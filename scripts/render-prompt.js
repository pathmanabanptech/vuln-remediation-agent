#!/usr/bin/env node
// render-prompt: fills agent_prompt.md's {{TARGET_*}} placeholders from the
// target settings and prints the result, so the prompt names no repository.
//
// Settings: TARGET_REPO (owner/name), TARGET_BRANCH, TARGET_PATH (directory of
// package.json inside the repo; "." for the root). The local checkout is
// mounted at /workspace/target (see docker-compose.yml).
//
// Usage: node render-prompt.js [path/to/agent_prompt.md]

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SCAN_MOUNT = "/workspace/target";

function fail(message) {
  process.stderr.write(`[render-prompt] ${message}\n`);
  process.exit(1);
}

const repo = (process.env.TARGET_REPO || "").trim();
const branch = (process.env.TARGET_BRANCH || "").trim();
const targetPath = (process.env.TARGET_PATH || ".").trim();

const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repo);
if (!match) fail(`TARGET_REPO must be "owner/name", got "${repo}"`);
if (!branch) fail("TARGET_BRANCH must be set");
if (path.isAbsolute(targetPath) || targetPath.split(/[\\/]/).includes("..")) {
  fail(`TARGET_PATH must be a path inside the repository, got "${targetPath}"`);
}

const relativeDir = path.posix.normalize(targetPath).replace(/\/$/, "");
const values = {
  TARGET_OWNER: match[1],
  TARGET_NAME: match[2],
  TARGET_BRANCH: branch,
  TARGET_MANIFEST: relativeDir === "." ? "package.json" : `${relativeDir}/package.json`,
  TARGET_SCAN_DIR: relativeDir === "." ? SCAN_MOUNT : `${SCAN_MOUNT}/${relativeDir}`,
};

const templatePath = process.argv[2] || path.join(__dirname, "..", "agent_prompt.md");
const rendered = fs.readFileSync(templatePath, "utf8").replace(/\{\{(\w+)\}\}/g, (placeholder, key) => {
  if (!Object.hasOwn(values, key)) fail(`unknown placeholder ${placeholder} in ${templatePath}`);
  return values[key];
});
process.stdout.write(rendered);
