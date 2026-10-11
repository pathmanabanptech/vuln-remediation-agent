#!/usr/bin/env node
// api-guard: authenticating reverse proxy in front of ollama-mcp-bridge, whose
// API has no authentication of its own.
//
// Every request must carry `Authorization: Bearer $AGENT_API_TOKEN` and a Host
// header from API_GUARD_ALLOWED_HOSTS (blocks DNS rebinding, where a website
// points its own domain at 127.0.0.1 to get around CORS). The token is
// stripped before forwarding, because the bridge passes request headers on to
// Ollama.
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

const server = http.createServer((req, res) => {
  const host = (req.headers.host || "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return reject(req, res, 403, "host not allowed");
  if (!isAuthorized(req.headers.authorization)) return reject(req, res, 401, "missing or invalid bearer token");

  const headers = { ...req.headers };
  delete headers.authorization;

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

  req.pipe(upstreamReq);
});

// Agent runs (scan + LLM + GitHub calls) can exceed Node's default 5-minute limit.
server.requestTimeout = 0;
server.listen(LISTEN_PORT, "0.0.0.0", () => {
  log(`listening on :${LISTEN_PORT}, forwarding to 127.0.0.1:${UPSTREAM_PORT}, hosts [${[...ALLOWED_HOSTS].join(", ")}]`);
});
