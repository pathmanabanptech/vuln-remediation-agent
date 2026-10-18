// GitHub MCP policy: enforces Human-in-the-Loop.
//
// The agent may only: read a file, create a branch, commit a file to that
// branch, and open a pull request. A human must review and merge. Everything
// else (merge_pull_request, push_files [force-pushes], fork/create repo,
// issue/review writes, ...) is denied. Writes are restricted to
// `security/fix-*` branches so the agent can never commit directly to main.
//
// Commits to package.json may only change versions of dependencies that are
// already listed: the guard reads the current file from the branch and rejects
// anything else (an LLM rewriting the file from memory drops scripts and deps).

"use strict";

const BRANCH_PATTERN = /^security\/fix-[A-Za-z0-9._@\/-]+$/;
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function isAgentBranch(value) {
  return typeof value === "string" && BRANCH_PATTERN.test(value) && !value.includes("..");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Lists every difference between two package.json objects other than version
// changes of existing dependencies, and the version changes themselves.
function comparePackageJson(current, proposed) {
  const problems = [];
  const versionChanges = [];

  for (const key of new Set([...Object.keys(current), ...Object.keys(proposed)])) {
    if (DEPENDENCY_SECTIONS.includes(key)) continue;
    if (!(key in proposed)) problems.push(`"${key}" was removed`);
    else if (!(key in current)) problems.push(`"${key}" was added`);
    else if (JSON.stringify(current[key]) !== JSON.stringify(proposed[key])) problems.push(`"${key}" was changed`);
  }

  for (const section of DEPENDENCY_SECTIONS) {
    const before = isObject(current[section]) ? current[section] : {};
    const after = isObject(proposed[section]) ? proposed[section] : {};
    for (const name of Object.keys(before)) {
      if (!(name in after)) problems.push(`${section}.${name} was removed`);
      else if (after[name] !== before[name]) versionChanges.push({ section, name, from: before[name], to: after[name] });
    }
    for (const name of Object.keys(after)) {
      if (!(name in before)) problems.push(`${section}.${name} was added`);
    }
  }

  return { problems, versionChanges };
}

async function checkPackageJsonCommit(args, proposed, callUpstream) {
  const response = await callUpstream("get_file_contents", {
    owner: args.owner,
    repo: args.repo,
    path: args.path,
    branch: args.branch,
  });
  if (response.error) {
    return `could not read the current ${args.path} on ${args.branch} to check the change: ${response.error.message}`;
  }
  let current;
  try {
    current = JSON.parse(JSON.parse(response.result.content[0].text).content);
  } catch {
    return `could not read the current ${args.path} on ${args.branch} to check the change`;
  }

  const { problems, versionChanges } = comparePackageJson(current, proposed);
  if (problems.length > 0) {
    return (
      `only versions of existing dependencies may change in ${args.path}, but ${problems.join(", ")}. ` +
      "Read the file with get_file_contents and change only the version string of the package being fixed."
    );
  }
  if (versionChanges.length === 0) return `no dependency version was changed in ${args.path}`;

  // Commit the real file with only the version strings changed, keeping its key
  // order and npm's 2-space formatting, so the PR diff is just those lines.
  for (const { section, name, to } of versionChanges) current[section][name] = to;
  args.content = JSON.stringify(current, null, 2) + "\n";
  return null;
}

module.exports = {
  get_file_contents: () => null, // read-only, needed to edit package.json
  create_branch: (args) =>
    isAgentBranch(args.branch) ? null : "branch must match security/fix-<package>",
  create_or_update_file: async (args, { callUpstream }) => {
    if (!isAgentBranch(args.branch)) return "commits are only allowed on security/fix-* branches";
    if (typeof args.path !== "string" || !args.path.endsWith(".json")) return null;

    // Stops a model that hasn't read the file yet from committing a placeholder like "...".
    let proposed;
    try {
      proposed = JSON.parse(args.content);
    } catch {
      return "content must be the complete updated file as valid JSON; read it first with get_file_contents";
    }
    if (args.path === "package.json" || args.path.endsWith("/package.json")) {
      if (!isObject(proposed)) return "package.json content must be a JSON object";
      return checkPackageJsonCommit(args, proposed, callUpstream);
    }
    return null;
  },
  create_pull_request: (args) =>
    isAgentBranch(args.head) ? null : "PR head must be a security/fix-* branch",
};
