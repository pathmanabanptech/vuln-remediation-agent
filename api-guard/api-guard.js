#!/usr/bin/env node
// api-guard: authenticating reverse proxy in front of ollama-mcp-bridge, whose
// API has no authentication of its own.
//
// Every request must carry `Authorization: Bearer $AGENT_API_TOKEN` and a Host
// header from API_GUARD_ALLOWED_HOSTS (blocks DNS rebinding, where a website
// points its own domain at 127.0.0.1 to get around CORS). The token is
// stripped before forwarding, because the bridge passes request headers on to
// Ollama. The `model` of every /api/chat request is set to OLLAMA_MODEL.
//
// The bridge is started as a child process and must listen on
// 127.0.0.1:API_GUARD_UPSTREAM_PORT so this proxy is the only way in. The
// proxy exits when the bridge does.
//
// Usage: node api-guard.js -- <bridge command> [args...]

"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");

const LISTEN_PORT = Number(process.env.API_GUARD_LISTEN_PORT || 8000);
const UPSTREAM_PORT = Number(process.env.API_GUARD_UPSTREAM_PORT || 8001);
const ALLOWED_HOSTS = new Set(
  (process.env.API_GUARD_ALLOWED_HOSTS || "localhost:8000,127.0.0.1:8000")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const MIN_TOKEN_LENGTH = 32;
// The model is server config, not a per-request choice: every /api/chat request is
// pinned to OLLAMA_MODEL, the model scripts/model-preflight.js verified at startup.
const MODEL = process.env.OLLAMA_MODEL || "llama3.1";
// Ollama's default context (4096 tokens) is smaller than one findings_list result; when it
// overflows, Ollama drops the oldest messages, starting with the system prompt.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 16384);
const MAX_CHAT_BODY_BYTES = 10 * 1024 * 1024;

function log(message) {
  process.stderr.write(`[api-guard] ${message}\n`);
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest();
}

const token = process.env.AGENT_API_TOKEN || "";
if (token.length < MIN_TOKEN_LENGTH) {
  log(`AGENT_API_TOKEN must be set to at least ${MIN_TOKEN_LENGTH} characters (try: openssl rand -hex 32)`);
  process.exit(2);
}
const tokenDigest = digest(token);

const separator = process.argv.indexOf("--");
const bridgeArgv = separator === -1 ? [] : process.argv.slice(separator + 1);
if (bridgeArgv.length === 0) {
  log("usage: api-guard.js -- <bridge command> [args...]");
  process.exit(2);
}

// The bridge never needs the API token.
const bridgeEnv = { ...process.env };
delete bridgeEnv.AGENT_API_TOKEN;

const bridge = spawn(bridgeArgv[0], bridgeArgv.slice(1), { stdio: "inherit", env: bridgeEnv });
bridge.on("error", (err) => {
  log(`failed to start bridge: ${err.message}`);
  process.exit(1);
});
let stopping = false;
bridge.on("exit", (code, signal) => {
  log(`bridge exited (${signal || code}), shutting down`);
  process.exit(code ?? (stopping ? 0 : 1));
});
// As PID 1 in the container, Node has no default signal handling.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopping = true;
    bridge.kill(signal);
  });
}

function isAuthorized(header) {
  const match = /^Bearer (.+)$/.exec(header || "");
  return match !== null && crypto.timingSafeEqual(digest(match[1]), tokenDigest);
}

function reject(req, res, status, reason) {
  log(`DENIED ${req.method} ${req.url} from ${req.socket.remoteAddress}: ${reason}`);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: reason }));
}

// Forwards to the bridge; `body` replaces the request body when given, otherwise it is streamed.
function forward(req, res, headers, body) {
  const upstreamReq = http.request(
    { host: "127.0.0.1", port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res); // streams NDJSON chunks as they arrive
    },
  );
  upstreamReq.on("error", (err) => {
    log(`upstream error for ${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bridge unavailable" }));
    } else {
      res.destroy();
    }
  });
  // Client went away: abort the bridge request so it stops the agent run.
  res.on("close", () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });

  if (body) upstreamReq.end(body);
  else req.pipe(upstreamReq);
}

// Buffers an /api/chat body and sets its model to OLLAMA_MODEL before forwarding.
function forwardChat(req, res, headers) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_CHAT_BODY_BYTES) {
      tooLarge = true;
      reject(req, res, 413, "request body too large");
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (tooLarge) return;
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      payload = undefined;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return reject(req, res, 400, "body must be a JSON object");
    }
    if (payload.model !== undefined && payload.model !== MODEL) {
      log(`replaced requested model "${payload.model}" with OLLAMA_MODEL "${MODEL}"`);
    }
    payload.model = MODEL;
    const options = payload.options !== null && typeof payload.options === "object" ? payload.options : {};
    payload.options = { ...options, num_ctx: options.num_ctx ?? NUM_CTX };

    const body = Buffer.from(JSON.stringify(payload));
    delete headers["transfer-encoding"];
    headers["content-length"] = String(body.length);
    forward(req, res, headers, body);
  });
}

const server = http.createServer((req, res) => {
  const host = (req.headers.host || "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return reject(req, res, 403, "host not allowed");
  if (!isAuthorized(req.headers.authorization)) return reject(req, res, 401, "missing or invalid bearer token");

  const headers = { ...req.headers };
  delete headers.authorization;

  const pathname = req.url.split("?")[0];
  if (req.method === "POST" && pathname === "/api/chat") return forwardChat(req, res, headers);
  forward(req, res, headers);
});

// Agent runs (scan + LLM + GitHub calls) can exceed Node's default 5-minute limit.
server.requestTimeout = 0;
server.listen(LISTEN_PORT, "0.0.0.0", () => {
  log(
    `listening on :${LISTEN_PORT}, forwarding to 127.0.0.1:${UPSTREAM_PORT}, ` +
      `hosts [${[...ALLOWED_HOSTS].join(", ")}], model ${MODEL}, num_ctx ${NUM_CTX}`,
  );
});
