// GitHub MCP policy: enforces Human-in-the-Loop.
//
// The agent may only: read a file, create a branch, commit a file to that
// branch, and open a pull request. A human must review and merge. Everything
// else (merge_pull_request, push_files [force-pushes], fork/create repo,
// issue/review writes, ...) is denied. Writes are restricted to
// `security/fix-*` branches so the agent can never commit directly to main.

"use strict";

const BRANCH_PATTERN = /^security\/fix-[A-Za-z0-9._@\/-]+$/;

function isAgentBranch(value) {
  return typeof value === "string" && BRANCH_PATTERN.test(value) && !value.includes("..");
}

module.exports = {
  get_file_contents: () => null, // read-only, needed to edit package.json
  create_branch: (args) =>
    isAgentBranch(args.branch) ? null : "branch must match security/fix-<package>",
  create_or_update_file: (args) =>
    isAgentBranch(args.branch) ? null : "commits are only allowed on security/fix-* branches",
  create_pull_request: (args) =>
    isAgentBranch(args.head) ? null : "PR head must be a security/fix-* branch",
};
