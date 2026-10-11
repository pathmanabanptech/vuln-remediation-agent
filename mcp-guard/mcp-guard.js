#!/usr/bin/env node
// mcp-guard: stdio proxy that sits between ollama-mcp-bridge and an MCP server
// and enforces a tool allowlist in code, not in the prompt.
//
// Tools not in the selected policy are hidden from tools/list and rejected on
// tools/call. Each allowed tool has an argument check that returns an error
// string to deny, or null to allow (it may normalize arguments in place).
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

// A cancelled call that is still queued never reaches upstream. A cancelled
// in-flight call keeps its slot until upstream answers, since the work may
// still be running and starting another call could trigger the crash.
function dropQueuedCall(requestId) {
  const index = queuedCalls.findIndex((call) => call.id === requestId);
  if (index === -1) return false;
  queuedCalls.splice(index, 1);
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
    const args = message.params?.arguments ?? {};
    const policy = Object.hasOwn(ALLOWED_TOOLS, name) ? ALLOWED_TOOLS[name] : undefined;
    const denial = policy ? policy(args) : `tool '${name}' is not permitted (allowlist)`;
    if (denial) {
      log(`DENIED tools/call ${name}: ${denial}`);
      send(process.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: policy ? -32602 : -32601, message: `Blocked by mcp-guard: ${denial}` },
      });
      return;
    }
    log(`allowed tools/call ${name}`);
    queuedCalls.push(message);
    dispatchNextCall();
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
  }

  send(process.stdout, message);

  if (isResponse && inFlightCallId !== null && message.id === inFlightCallId) {
    inFlightCallId = null;
    dispatchNextCall();
  }
});
