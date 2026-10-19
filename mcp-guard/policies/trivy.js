// Trivy MCP policy: least privilege for scanning.
//
// The pipeline only needs a vulnerability scan of the demo project. Denied:
// scan_repository and scan_image (let the model fetch arbitrary remote URLs),
// scans outside MCP_GUARD_SCAN_ROOT (e.g. "/" or /app/.env), and the secret,
// misconfig and license scanners. findings_list results are narrowed to direct
// dependencies, the only ones the agent can fix by editing package.json.

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

// Packages listed directly in the scanned project's package.json.
function directDependencies() {
  const root = scanRoot();
  if (!root) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
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
      return 'scanType must be the JSON array ["vuln"]';
    }

    args.target = target; // forward the resolved path so the check and the scan agree
    return null;
  },
  // The agent only fixes direct dependencies (editing package.json can't fix the
  // rest), but findings don't say which packages are direct, and small models can't
  // reliably cross-check. Keep only findings for packages listed in the scanned
  // project's package.json; no package names are hard-coded.
  findings_list: Object.assign(() => null, {
    transformResult(result) {
      const direct = directDependencies();
      const item = result.content?.[0];
      if (!direct || typeof item?.text !== "string") return null;
      const body = JSON.parse(item.text);
      if (!Array.isArray(body.findings)) return null;
      const total = body.findings.length;
      body.findings = body.findings.filter((finding) => direct.has(finding.an));
      body.note =
        `Showing ${body.findings.length} of ${total} findings: only packages listed directly ` +
        "in package.json, which are the ones this agent may fix.";
      item.text = JSON.stringify(body);
      return `kept ${body.findings.length} of ${total} findings (direct dependencies)`;
    },
  }),
  findings_get: () => null,
  trivy_version: () => null,
};
