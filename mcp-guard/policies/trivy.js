// Trivy MCP policy: least privilege for scanning.
//
// The pipeline only needs a vulnerability scan of the demo project. Denied:
// scan_repository and scan_image (let the model fetch arbitrary remote URLs),
// scans outside MCP_GUARD_SCAN_ROOT (e.g. "/" or /app/.env), and the secret,
// misconfig and license scanners.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

function scanRoot() {
  const root = process.env.MCP_GUARD_SCAN_ROOT;
  if (!root || !path.isAbsolute(root)) return null;
  try {
    return fs.realpathSync(root);
  } catch {
    return null;
  }
}

module.exports = {
  scan_filesystem: (args) => {
    const root = scanRoot();
    if (!root) return "MCP_GUARD_SCAN_ROOT is not set to an existing absolute path";

    if (typeof args.target !== "string" || !path.isAbsolute(args.target)) {
      return "target must be an absolute path";
    }
    let target;
    try {
      target = fs.realpathSync(args.target); // resolve symlinks before checking
    } catch {
      return "target does not exist";
    }
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      return `target must be inside ${root}`;
    }

    const scanTypes = args.scanType;
    if (!Array.isArray(scanTypes) || scanTypes.length === 0 || scanTypes.some((t) => t !== "vuln")) {
      return 'scanType must be ["vuln"]';
    }

    args.target = target; // forward the resolved path so the check and the scan agree
    return null;
  },
  findings_list: () => null,
  findings_get: () => null,
  trivy_version: () => null,
};
