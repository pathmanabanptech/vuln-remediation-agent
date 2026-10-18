#!/usr/bin/env node
// model-preflight: startup check that OLLAMA_MODEL can make structured tool calls
// through Ollama, which the agent depends on entirely.
//
// ollama-mcp-bridge only acts on `message.tool_calls`. A model that answers in
// plain text (or writes a tool call as text) makes the agent "finish" without
// doing anything and without any error. This sends one request with a single
// dummy tool and exits non-zero unless the model returns a well-formed call to
// it, so a bad model choice fails at startup instead of deep in a real run.
//
// Usage: OLLAMA_URL=... OLLAMA_MODEL=... [UPSTREAM_HEADERS='{"Authorization":"..."}'] node model-preflight.js

"use strict";

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
const MODEL = process.env.OLLAMA_MODEL || "llama3.1";
const TIMEOUT_MS = Number(process.env.PREFLIGHT_TIMEOUT_SECONDS || 300) * 1000; // includes cold model load

// Dotted like the bridge's real tool names (e.g. github.create_branch), which the
// model has to reproduce exactly for the bridge to find the tool.
const TOOL_NAME = "preflight.add_numbers";

function log(message) {
  process.stderr.write(`[model-preflight] ${message}\n`);
}

function fail(headline, detail) {
  log(`FAILED: ${headline}`);
  if (detail) log(detail);
  process.exit(1);
}

// Same format the bridge accepts: a JSON object of header name/value pairs, e.g. for an
// Ollama behind an authenticating gateway in a private network.
function upstreamHeaders() {
  const raw = process.env.UPSTREAM_HEADERS;
  if (!raw || !raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`UPSTREAM_HEADERS must be a valid JSON object: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("UPSTREAM_HEADERS must be a JSON object of header name/value pairs");
  }
  const headers = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!name.trim()) fail("UPSTREAM_HEADERS contains an empty header name");
    headers[name.trim()] = String(value);
  }
  return headers;
}

const UPSTREAM_HEADERS = upstreamHeaders();

function failToolCalling(detail) {
  fail(`Model ${MODEL} does not appear to support tool calling via Ollama — try a different model/tag.`, detail);
}

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(`${OLLAMA_URL}${path}`, {
      method,
      headers: { ...UPSTREAM_HEADERS, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      fail(
        `Ollama at ${OLLAMA_URL} did not answer ${path} within ${TIMEOUT_MS / 1000}s.`,
        `${MODEL} may be too large for the server's memory or still loading; try a smaller model or raise PREFLIGHT_TIMEOUT_SECONDS.`,
      );
    }
    fail(`Cannot reach Ollama at ${OLLAMA_URL} (${err.cause?.code || err.name}).`, "Is `ollama serve` running?");
  }
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

function parseArguments(args) {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}

async function main() {
  const started = Date.now();
  log(`checking ${MODEL} at ${OLLAMA_URL}`);

  await request("GET", "/api/tags");

  const show = await request("POST", "/api/show", { model: MODEL });
  if (show.status === 404) {
    fail(`Model ${MODEL} is not available in Ollama.`, `Pull it first: ollama pull ${MODEL}`);
  }
  if (show.status === 401 || show.status === 403) {
    fail(
      `Ollama at ${OLLAMA_URL} rejected the request (HTTP ${show.status}).`,
      "If it sits behind an authenticating gateway, set UPSTREAM_HEADERS to the headers it needs.",
    );
  }
  if (show.status !== 200) {
    fail(`Ollama returned HTTP ${show.status} for model ${MODEL}.`, show.text.slice(0, 300));
  }
  // Ollama >= 0.6 reports capabilities; older versions don't, so fall through to the live test.
  const capabilities = show.json?.capabilities;
  if (Array.isArray(capabilities) && !capabilities.includes("tools")) {
    failToolCalling(`Ollama reports capabilities [${capabilities.join(", ")}], without "tools".`);
  }

  const chat = await request("POST", "/api/chat", {
    model: MODEL,
    stream: false,
    // Same context size as api-guard, so Ollama loads the model once with the size real runs use.
    options: { temperature: 0, seed: 42, num_ctx: Number(process.env.OLLAMA_NUM_CTX || 16384) },
    messages: [
      { role: "user", content: `Call the ${TOOL_NAME} tool with a=2 and b=3. Do not answer in text.` },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: TOOL_NAME,
          description: "Add two numbers and return the sum.",
          parameters: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
      },
    ],
  });
  if (chat.status !== 200) {
    const error = chat.json?.error || chat.text.slice(0, 300);
    if (/does not support tools/i.test(error)) failToolCalling(`Ollama: ${error}`);
    fail(`Ollama returned HTTP ${chat.status} for a chat request to ${MODEL}.`, error);
  }

  const message = chat.json?.message || {};
  const calls = message.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    const reply = (message.content || "").trim().replace(/\s+/g, " ").slice(0, 200);
    failToolCalling(`It replied with text instead of a structured tool call: "${reply}"`);
  }

  const call = calls[0]?.function || {};
  if (call.name !== TOOL_NAME) {
    failToolCalling(`It called "${call.name}" instead of "${TOOL_NAME}"; the bridge needs exact tool names.`);
  }
  const args = parseArguments(call.arguments);
  if (!args || Number(args.a) !== 2 || Number(args.b) !== 3) {
    failToolCalling(`It called ${TOOL_NAME} with ${JSON.stringify(call.arguments)} instead of {"a":2,"b":3}.`);
  }

  log(`OK: ${MODEL} made a well-formed tool call (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

main().catch((err) => fail(`Preflight error: ${err.message}`));
