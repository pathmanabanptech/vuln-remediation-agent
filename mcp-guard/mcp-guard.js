#!/usr/bin/env node
// mcp-guard: stdio proxy that sits between ollama-mcp-bridge and an MCP server
// and enforces a tool allowlist in code, not in the prompt.
//
// Tools not in the selected policy are hidden from tools/list and rejected on
// tools/call. Each allowed tool has an argument check that returns an error
// string to deny, or null to allow (it may normalize arguments in place). Checks
// may be async and read upstream state through the callUpstream helper they receive.
// See policies/ for what each server is allowed to do.
//
// Usage: node mcp-guard.js <policy> -- <upstream command> [args...]
// Transport: newline-delimited JSON-RPC over stdio (MCP stdio transport).

"use strict";

const { spawn } = require("node:child_process");
const readline = require("node:readline");

const POLICIES = {
  github: () => require("./policies/github"),
  trivy: () => require("./policies/trivy"),
};

const policyName = process.argv[2];

function log(message) {
  process.stderr.write(`[mcp-guard:${policyName}] ${message}\n`);
}

function send(stream, message) {
  stream.write(JSON.stringify(message) + "\n");
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const separator = process.argv.indexOf("--");
const upstreamArgv = separator === -1 ? [] : process.argv.slice(separator + 1);
if (!Object.hasOwn(POLICIES, policyName) || separator !== 3 || upstreamArgv.length === 0) {
  log(`usage: mcp-guard.js <${Object.keys(POLICIES).join("|")}> -- <upstream command> [args...]`);
  process.exit(2);
}
const ALLOWED_TOOLS = POLICIES[policyName]();

const upstream = spawn(upstreamArgv[0], upstreamArgv.slice(1), {
  stdio: ["pipe", "pipe", "inherit"],
});
upstream.on("error", (err) => {
  log(`failed to start upstream: ${err.message}`);
  process.exit(1);
});
upstream.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

// Ids of in-flight tools/list requests whose responses must be filtered.
const pendingToolLists = new Set();

// Input schemas of allowed tools, captured from tools/list responses.
const toolSchemas = new Map();

// Small models often send typed arguments as strings: "['vuln']" or "vuln,secret"
// for an array, "true" for a boolean. Convert those to the type the tool's schema
// declares, before the policy checks the result.
function coerce(value, type) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (type === "boolean" && /^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  if ((type === "number" || type === "integer") && text !== "" && Number.isFinite(Number(text))) return Number(text);
  if (type === "array") {
    for (const candidate of [text, text.replace(/'/g, '"')]) {
      const parsed = parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    }
    return text
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return value;
}

// Returns a description of each argument that was converted.
function coerceArguments(name, args) {
  const properties = toolSchemas.get(name)?.properties;
  if (!properties) return [];
  const changed = [];
  for (const [key, value] of Object.entries(args)) {
    const coerced = coerce(value, properties[key]?.type);
    if (coerced !== value) {
      args[key] = coerced;
      changed.push(`${key}: ${JSON.stringify(value)} -> ${JSON.stringify(coerced)}`);
    }
  }
  return changed;
}

// tools/call requests are sent upstream one at a time: trivy-mcp v0.0.20
// crashes ("concurrent map writes") on overlapping scans, taking the server
// down for the session. A call waits here until the previous one is answered.
const queuedCalls = [];
let inFlightCallId = null;

function dispatchNextCall() {
  if (inFlightCallId !== null || queuedCalls.length === 0) return;
  const call = queuedCalls.shift();
  inFlightCallId = call.id;
  send(upstream.stdin, call);
}

// Tool name of each allowed client call awaiting its result, so a policy's
// optional transformResult(result) can post-process it before the client sees it.
const clientCallTools = new Map();

// Calls the guard makes itself (e.g. reading the current file before allowing a
// commit). They share the queue above, and their responses never reach the client.
const pendingInternalCalls = new Map();
let internalCallCount = 0;

function callUpstream(name, args) {
  return new Promise((resolve) => {
    const id = `mcp-guard-internal-${++internalCallCount}`;
    pendingInternalCalls.set(id, resolve);
    queuedCalls.push({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    dispatchNextCall();
  });
}

function deny(message, name, reason, code) {
  log(`DENIED tools/call ${name}: ${reason}`);
  send(process.stdout, { jsonrpc: "2.0", id: message.id, error: { code, message: `Blocked by mcp-guard: ${reason}` } });
}

// A cancelled call that is still queued never reaches upstream. A cancelled
// in-flight call keeps its slot until upstream answers, since the work may
// still be running and starting another call could trigger the crash.
function dropQueuedCall(requestId) {
  const index = queuedCalls.findIndex((call) => call.id === requestId);
  if (index === -1) return false;
  queuedCalls.splice(index, 1);
  clientCallTools.delete(requestId);
  return true;
}

// Client (bridge) -> upstream
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  const message = parse(line);

  if (message === undefined || Array.isArray(message) || typeof message !== "object" || message === null) {
    // Fail closed: batches and malformed input are never forwarded.
    log("rejected malformed or batched message from client");
    send(process.stdout, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    return;
  }

  if (message.method === "tools/list" && message.id !== undefined) {
    pendingToolLists.add(message.id);
  }

  if (message.method === "notifications/cancelled" && dropQueuedCall(message.params?.requestId)) {
    log(`dropped cancelled queued call ${message.params.requestId}`);
    return;
  }

  if (message.method === "tools/call") {
    if (message.id === undefined || message.id === null) {
      // Without an id there is no response to release the queue on.
      log("rejected tools/call without an id");
      send(process.stdout, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
      return;
    }
    const name = message.params?.name;
    if (typeof message.params?.arguments === "string") message.params.arguments = parse(message.params.arguments);
    if (message.params && (typeof message.params.arguments !== "object" || message.params.arguments === null)) {
      message.params.arguments = {};
    }
    const args = message.params?.arguments ?? {};
    const coerced = coerceArguments(name, args);
    if (coerced.length > 0) log(`coerced ${name} arguments: ${coerced.join("; ")}`);
    const policy = Object.hasOwn(ALLOWED_TOOLS, name) ? ALLOWED_TOOLS[name] : undefined;
    if (!policy) return deny(message, name, `tool '${name}' is not permitted (allowlist)`, -32601);
    // Policies may be async (they can read upstream state via callUpstream); errors deny.
    Promise.resolve()
      .then(() => policy(args, { callUpstream }))
      .catch((err) => `policy check failed: ${err.message}`)
      .then((denial) => {
        if (denial) return deny(message, name, denial, -32602);
        log(`allowed tools/call ${name}`);
        clientCallTools.set(message.id, name);
        queuedCalls.push(message);
        dispatchNextCall();
      });
    return;
  }

  send(upstream.stdin, message);
});
process.stdin.on("end", () => upstream.stdin.end());

// Upstream -> client (bridge)
readline.createInterface({ input: upstream.stdout, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  const message = parse(line);
  if (message === undefined) {
    log("dropped non-JSON line from upstream");
    return;
  }

  const isResponse = message && !Array.isArray(message) && message.method === undefined;
  if (isResponse && pendingToolLists.delete(message.id) && Array.isArray(message.result?.tools)) {
    message.result.tools = message.result.tools.filter((tool) => Object.hasOwn(ALLOWED_TOOLS, tool.name));
    for (const tool of message.result.tools) toolSchemas.set(tool.name, tool.inputSchema);
  }

  if (isResponse && pendingInternalCalls.has(message.id)) {
    const resolve = pendingInternalCalls.get(message.id);
    pendingInternalCalls.delete(message.id);
    resolve(message);
  } else {
    const toolName = isResponse ? clientCallTools.get(message.id) : undefined;
    if (toolName !== undefined) {
      clientCallTools.delete(message.id);
      const transform = ALLOWED_TOOLS[toolName].transformResult;
      if (transform && message.result) {
        try {
          const note = transform(message.result);
          if (note) log(`post-processed ${toolName} result: ${note}`);
        } catch (err) {
          log(`could not post-process ${toolName} result: ${err.message}`);
        }
      }
    }
    send(process.stdout, message);
  }

  if (isResponse && inFlightCallId !== null && message.id === inFlightCallId) {
    inFlightCallId = null;
    dispatchNextCall();
  }
});
