# Hardening and enhancement plan (deferred)

Contents: [bounded network](#where-things-stand) · [verifier sidecar](#verify-fixes-before-committing-verifier-sidecar) · [any repository and grouped fixes](#any-repository-and-grouped-fixes) · [other deferred items](#other-deferred-items-from-the-security-review)

**Status:** not started; deferred until after the demo (written 2026-10-17).
**Goal:** source code and vulnerability data stay inside a secure network you control, and the running agent depends on nothing on the public internet except what you explicitly allow.

## Where things stand

Source code and scan findings are **not** sent to any package registry: Trivy scans offline against a downloaded database. The gaps are supply chain and outbound network dependencies.

| When | What | Source | Pinned? | Integrity checked? |
|---|---|---|---|---|
| **Every container start** | GitHub MCP server (`npx -y @modelcontextprotocol/server-github@2025.4.8` in `mcp-config.json`) | registry.npmjs.org | Top-level only; its deps use ranges (`node-fetch ^3.3.2`, `zod ^3.22.4`, `universal-user-agent ^7.0.2`, `@types/node ^22`) | No |
| Runtime, first scan | Trivy vulnerability DB | `mirror.gcr.io/aquasec/trivy-db` | No | Signed by Aqua |
| Build | Demo-app deps (`npm install`, Dockerfile) | registry.npmjs.org | Lockfile | Lockfile hashes, but install scripts run as root |
| Build | `ollama-mcp-bridge==0.12.2` and its deps (`mcp>=1.9.4,<2`, `fastapi~=0.119`, …) | PyPI | Top-level only | No |
| Build | NodeSource setup script (`curl \| bash`, Dockerfile) | deb.nodesource.com | No | No |
| Build | Trivy 0.75.0, trivy-mcp 0.0.20 | GitHub releases | Yes | Yes (SHA-256) |
| Runtime | GitHub API | api.github.com | n/a | TLS |
| Runtime | Ollama | `OLLAMA_URL` (your network) | n/a | Your infrastructure |

**Main risk:** the GitHub MCP server holds the GitHub token and is resolved fresh from the public npm registry on each container start. A compromised release of any of its dependencies would receive the token, with no build, review or hash check in between.

**Privacy leak (metadata only):** npm sees the build host's IP and the demo app's dependency list during `docker build`. That `npm install` isn't needed: Trivy only reads the lockfile.

**Docs inaccuracy:** README › Security & Privacy says the only outbound connections besides Ollama are GitHub and the Trivy DB. That's untrue until step 1 is done. Fix the sentence before showing the README as the security story.

## Recommended steps

1. **Install the GitHub MCP server at build time.** Add a small `mcp-servers/package.json` with `@modelcontextprotocol/server-github` pinned exactly, commit its `package-lock.json`, run `npm ci` in the Dockerfile, and point `mcp-config.json` at the installed binary instead of `npx -y`. This removes npm from runtime and checks every dependency's hash.
2. **Remove the demo-app `npm install`** from the Dockerfile (the `COPY my-demo-app/package*.json` and `RUN npm install` lines). Trivy needs only `package.json` and `package-lock.json`.
3. **Lock Python dependencies with hashes.** Generate `requirements.txt` for `ollama-mcp-bridge==0.12.2` with `pip-compile --generate-hashes`, then `pip install --require-hashes -r requirements.txt`.
4. **Replace NodeSource `curl | bash`.** Use Debian's `nodejs` package, or download the official Node tarball and verify its SHA-256, as already done for Trivy.
5. **Make every source point to an internal mirror,** as Docker build args and env vars that default to the public sources:
   - npm: `NPM_CONFIG_REGISTRY` (Artifactory, Nexus, Verdaccio, AWS CodeArtifact)
   - PyPI: `PIP_INDEX_URL`
   - apt: a Debian mirror via `sources.list`
   - Trivy DB: `--db-repository <internal-registry>/trivy-db` (and `--java-db-repository` if Java is ever scanned), or bake the DB into the image at build time and rebuild regularly
   - Base image: pull `python:3.11-slim` via an internal registry, pinned by digest
6. **GitHub inside the boundary (optional).** For GitHub Enterprise Server on your network, switch to `github/github-mcp-server`, which supports a custom host. The current server only talks to github.com. Its tool groups still include merge and delete, so keep `mcp-guard` in front of it.
7. **Enforce egress at the network layer.** Allow the container to reach only Ollama, GitHub and the mirrors (security group, firewall or Kubernetes NetworkPolicy). This also covers anything missed above.
8. **Update the README** Security & Privacy section to list the exact remaining outbound connections.

**End state:** with 1–4, the running container talks only to Ollama, GitHub and the Trivy DB. With 5–7, everything except GitHub (or all of it, with GitHub Enterprise Server) stays inside the network.

## Verify fixes before committing (verifier sidecar)

**Problem (seen 2026-10-17):** the model wrote `package.json` from memory, dropping every other dependency and all scripts, with a major-version jump. The guard now blocks any `package.json` commit that changes more than existing dependency versions. But nothing regenerates `package-lock.json` (still pinned to the old version, so `npm ci` fails in CI and Trivy still reports the issue), and nothing runs tests or the build before the PR.

**Design:** the model chooses *what* (package and version); deterministic code does the edit and proves it works.
- A `verifier` service in `docker-compose.yml`:
  - no secrets, non-root, read-only root filesystem, CPU and memory limits;
  - network access only to the npm registry or internal mirror;
  - **no Docker socket**: the agent must not start containers itself, since that is root on the host.
- A new MCP tool, `verify_dependency_update(package, version)`, wrapped by `mcp-guard`. It:
  1. copies `my-demo-app` to a temp directory and changes only that version string, in code;
  2. regenerates the lockfile (`npm install --package-lock-only --ignore-scripts`);
  3. runs `npm ci --ignore-scripts`, then `CI=true npm test -- --watchAll=false`, then `npm run build`;
  4. re-runs Trivy on the result and confirms the targeted CVE is gone;
  5. returns pass or fail, the logs, and the exact verified `package.json` and `package-lock.json`.
- **Guard rule:** `create_or_update_file` for `package.json` and `package-lock.json` is allowed only if the content's hash matches a passing verification from the same session. The model can no longer commit content it made up.
- **Prompt:** verify first; commit both files; put the test and build results in the PR body.
- **Open questions:** test and build time for `react-scripts` (minutes); whether to block major-version bumps in the guard or only flag them in the PR.

## Any repository and grouped fixes

**Done (2026-10-18):** the target is configuration (`TARGET_REPO`, `TARGET_BRANCH`, `TARGET_PATH`, `TARGET_DIR`); `agent_prompt.md` is a template filled by `scripts/render-prompt.js`; the guard rejects GitHub calls for any other repository.

**Next:**

1. **Clone at startup instead of `TARGET_DIR`.** Shallow-clone `TARGET_REPO@TARGET_BRANCH` into `/workspace/target`, passing the token via `git -c http.extraHeader=...` so it isn't stored in `.git/config`; public repos need no token. The scan then always matches the base branch on GitHub, and no local clone is needed.
2. **Deterministic remediation plan, `plan_fixes`.** A small MCP server, wrapped by `mcp-guard`, that:
   - runs `trivy fs --format json` on the target and keeps direct dependencies only;
   - picks, per package, the **lowest version that fixes all of its findings**. Fixed versions are listed per release line (e.g. `1.15.1, 0.31.1`): prefer the current major line, and move to the lowest qualifying higher major only if needed. Rehearsals showed the model picking axios `1.15.1`, which is still vulnerable, when `1.20.0` was needed;
   - classifies each upgrade as patch, minor or major;
   - groups them according to config:
     - `FIX_GROUPING=grouped` (default): all patch+minor upgrades in one branch/PR (`security/fix-deps-<date>`), and each major in its own PR (`security/fix-<package>-major`), since majors need individual review;
     - `FIX_GROUPING=per-package`: one PR per package;
     - `MAJOR_UPGRADES=separate` (default) or `skip` (list majors in the summary, don't open PRs);
   - returns branch names, `{package, from, to, bump, CVEs}`, and a ready-made PR body.

   The LLM then only orchestrates: per group, create branch → read file → commit → open PR. **Guard rule:** a `package.json` commit must match one group of the latest plan exactly (same packages, same versions, that group's branch). This extends the existing version-only check in `mcp-guard/policies/github.js`.
3. **Guard path lock:** commits only to `TARGET_PATH/package.json` (and its lockfile, once the verifier sidecar regenerates it).
4. **Dockerfile:** drop the demo-app `COPY my-demo-app/package*.json` and `RUN npm install`.
5. **Beyond npm and single projects:** other ecosystems (Maven, pip, Go: Trivy already scans them, but editing and verifying are ecosystem-specific) and monorepos with several manifests.

## Other deferred items from the security review

- **Least privilege:**
  - read-only `my-demo-app` mount instead of `.:/app`
  - drop `env_file: .env` in favour of explicit variables
  - non-root user, `cap_drop: [ALL]`, `no-new-privileges`, `read_only`
  - drop `git`/`curl` from the final image (multi-stage build)
- **Branch protection on `main`** in GitHub, requiring PR review, as a backstop if `mcp-guard` were bypassed.
- **`MAX_TOOL_ROUNDS`** for the bridge, so a model that loops can't run forever.
- **Architecture diagram** (`assets/agent_archi.jpg`) still says `llama-security-agent` and doesn't show `mcp-guard` or `api-guard`.
- **Old local container** `llama-security-agent`: remove with `docker rm -f llama-security-agent`.
