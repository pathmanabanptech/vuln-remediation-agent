# vuln-remediation-agent
## Autonomous DevSecOps via Self-Hosted LLMs & Model Context Protocol (MCP)
The `vuln-remediation-agent` is a **Privacy-First** autonomous remediation agent. It leverages a self-hosted LLM served by **Ollama** inside your secure network boundary (workstation, on-prem, or private cloud VPC; **Llama 3.1 8B** by default, [configurable](#switching-models)) to analyze vulnerability reports from **Trivy** and propose code fixes as **GitHub pull requests** for a human to review and merge.

Built with **Healthcare and Financial Services** compliance in mind, this architecture keeps proprietary source code and vulnerability data away from third-party LLM providers.

## Why This Architecture?
In traditional enterprise environments, security is often a reactive **"Context-Switching Tax."** Tools like `npm audit` or Nexus IQ identify risks but leave the high-friction work of triage and remediation to the developer, slowing down velocity and leaving windows of vulnerability open. Furthermore, standard AI security solutions introduce **"Data Exit"** risks by sending proprietary codebases to public LLM APIs a non-starter for high-compliance sectors like Healthcare and Finance.

The **vuln-remediation-agent** solves these challenges by shifting the paradigm from **Reactive Detection to Proactive Immunity**:
- **Ensures Data Privacy:** All reasoning runs on a self-hosted model inside your secure network boundary, whether on a workstation, on-prem, or in a private cloud network; source code and vulnerability data are never sent to a third-party LLM provider.
- **Proactive Remediation:** Instead of waiting for a post-build alert, the agent identifies and fixes vulnerabilities at the point of inception. It moves the needle from "Shift-Left Detection" to **"Shift-Left Correction."**
- **Human-in-the-Loop by Design:** The agent can only open pull requests. Merging is always a human decision, enforced in code rather than by prompt instructions (see [Security & Privacy](#security--privacy)).
- **Reproducible Infrastructure:** Fully containerized via Docker Compose, with pinned and checksum-verified tooling.
- **Zero-Friction DevSecOps:** The agent acts as a "Digital Pair Programmer" that handles the grunt work of identifying "Policy-Clean" versions and preparing PRs,  allowing engineers to stay in the "flow state" and focus on feature delivery rather than security debt.

## Architecture 
![System Architecture](./assets/agent_archi.jpg)

### Key Components:
* **Reasoning Engine:** Self-hosted LLM via Ollama (hardware accelerated), on the same machine or anywhere in your private network: Llama 3.1 by default, any tool-calling model via `OLLAMA_MODEL`.
* **Orchestration:** `ollama-mcp-bridge` acting as a stateless proxy.
* **Security Scanner:** [Trivy MCP plugin](https://github.com/aquasecurity/trivy-mcp) for filesystem vulnerability discovery.
* **GitOps:** GitHub MCP Server for branch creation, commits and PR creation.
* **Guardrails:** **`mcp-guard`**, an allowlist proxy in front of both MCP servers that enforces Human-in-the-Loop and least privilege.

The agent operates on a **Observe-Orient-Decide-Act (OODA)** loop:

- **Observe:** Reads package.json using GitHub MCP.
- **Orient:** Executes a Trivy scan to identify CVEs and "Fixed Versions."
- **Decide:** The model reasons if the fix is safe to apply (e.g., no breaking major version changes).
- **Act:** Commits the change to a `security/fix-*` branch and opens a PR with a detailed security summary for human review.


## Tech Stack
- **AI Brain:** Llama 3.1 (default) or another tool-calling model via [Ollama](https://ollama.com/)
- **Protocol:** [Model Context Protocol (MCP)](https://modelcontextprotocol.io/docs/getting-started/intro)
- **Security Scanner:** [Trivy](https://trivy.dev/) (Open Source SCA)
- **Automation:** GitHub API (via MCP Server)
- **Runtime:** Python (MCP bridge), Node.js (GitHub MCP server and `mcp-guard`)

## Getting Started
1. **Prerequisites**

  - Docker  & Docker Compose installed.
  - **GitHub PAT:** A [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) scoped to **only the single demo repository** ("Only select repositories"), with these repository permissions and nothing else:
    - **Contents:** Read and write
    - **Pull requests:** Read and write

    Do not grant administration or any other permissions, and do not use a classic token with the `repo` scope: it grants write access to every repository you can reach.

  - **Ollama server** reachable from the agent over a private network: on the same machine (the default), on-prem, or on a GPU host in your private cloud network. Set its address with `OLLAMA_URL` (see [Ollama location](#ollama-location)).

    *Note: For Apple Silicon users running everything on one machine, it is recommended to run Ollama natively on the Mac to take advantage of Metal GPU acceleration, while the **vuln-remediation-agent** runs containerized via Docker Compose.*
2. **Configuration**

    Copy `.env.example` to `.env` in the root directory, add your GitHub token, and generate an API token (`openssl rand -hex 32`) that callers of the agent must present:
    ```
    GITHUB_TOKEN=your_fine_grained_pat_here
    AGENT_API_TOKEN=output_of_openssl_rand_hex_32
    ```
    The agent refuses to start without an `AGENT_API_TOKEN` of at least 32 characters.
  
3. **Launch the Agent**
    - Make sure your Ollama server (on this machine or in your private network) is running and has the model downloaded:
        ```bash
        ollama pull llama3.1    # or the model you set in OLLAMA_MODEL
        ```

    - Run the bridge to connect Llama to the MCP tools:
        ```bash
        # Start the containers
        docker compose up -d

        # Verify the agent: the model preflight must report "OK" before the bridge starts
        docker logs -f vuln-remediation-agent
        ```
    - Test your Agent (or run `bash test-agent.sh`, which reads the token from `.env`)
        ```
        curl -X POST http://localhost:8000/api/chat \
            -H "Authorization: Bearer $AGENT_API_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{
                "messages": [{"role": "user", "content": "Run security audit and fix vulnerabilities."}],
                "stream": false
            }'
        ```
    - Review the pull request the agent opens on GitHub, and merge it yourself if the fix is correct.

4. **Enterprise Hosting Models:**

As a cloud-native solution, this agent can be scaled across various environments:

- **Developer Workstation:** Runs as a background service on Apple Silicon or NVIDIA-enabled workstations, with Ollama on the same machine.
- **Private Cloud (AWS/Azure/GCP):** Ollama runs on a GPU-enabled instance (e.g., EC2 g5.xlarge) in a private subnet of your VPC, and the agent reaches it via `OLLAMA_URL` without the traffic leaving your network.
- **On-Prem Kubernetes:** Deployed as a sidecar to CI/CD runners (Jenkins/GitLab) to provide real-time remediation during the build phase.


## Ollama location
By default the agent uses Ollama on the Docker host (`http://host.docker.internal:11434`). To use an Ollama server elsewhere in your private network, set `OLLAMA_URL` in `.env` or per run:
```bash
OLLAMA_URL=http://ollama.internal:11434 docker compose up -d
```
If that server sits behind an authenticating gateway, add the headers it needs as a JSON object; the bridge and the startup preflight both send them on every Ollama request:
```
UPSTREAM_HEADERS={"Authorization": "Bearer your_gateway_token"}
```
Use only private-network addresses: every prompt contains source code and vulnerability data. See [Security & Privacy](#security--privacy).

## Switching models
The agent works with any Ollama-served model that supports **tool (function) calling**. Set it with `OLLAMA_MODEL` (default: `llama3.1`), either per run:
```bash
ollama pull qwen2.5:7b-instruct
OLLAMA_MODEL=qwen2.5:7b-instruct docker compose up -d
```
or permanently in `.env` (`OLLAMA_MODEL=qwen2.5:7b-instruct`). Pull the model in Ollama first.

`OLLAMA_MODEL` is the single source of truth: `api-guard` sets it as the `model` of every `/api/chat` request, so any `model` a caller sends is ignored.

**Startup preflight.** Before the bridge starts, [`scripts/model-preflight.js`](./scripts/model-preflight.js) sends the model one request with a single dummy tool and checks that it answers with a well-formed, structured tool call. If it doesn't, the container exits immediately with:
```
[model-preflight] FAILED: Model <name> does not appear to support tool calling via Ollama — try a different model/tag.
```
followed by the reason (no `tools` capability, replied in plain text, wrong tool name or arguments). Without this check, a model that answers in plain text makes the agent "finish" without doing anything and without any error. The check also fails clearly if Ollama is unreachable or the model isn't pulled. Run it on its own with `OLLAMA_MODEL=<model> node scripts/model-preflight.js`.

**Tested models**

| Model | Preflight | Full remediation run |
|---|---|---|
| `llama3.1` | _to be filled in_ | _to be filled in_ |
| `qwen2.5:7b-instruct` | _to be filled in_ | _to be filled in_ |

## Security & Privacy
This project was built with Finance and Healthcare grade privacy in mind. The guarantee is that source code and vulnerability data stay **inside a secure, bounded network that you control**: prompts go only to the Ollama server you configure, never to a third-party LLM provider. That server can be on the same machine, on-prem, or in a private cloud network. Apart from Ollama, the only outbound connections are to the GitHub API (to read files and open PRs) and to download Trivy's vulnerability database.

**Keeping Ollama inside the boundary** is an infrastructure responsibility, because the Ollama API has no authentication of its own:
- Give the Ollama host a private address only (no public IP), and restrict its firewall or security group to the agent.
- When Ollama is not on the same host, encrypt the traffic (TLS via a private load balancer or reverse proxy) and put an authenticating gateway in front of it. Send the gateway's credentials with `UPSTREAM_HEADERS`.

**Tool allowlists enforced in code.** Both MCP servers are wrapped by [`mcp-guard`](./mcp-guard/mcp-guard.js), a proxy that hides every tool not in that server's [policy](./mcp-guard/policies/) from the model, rejects it if called anyway, and checks arguments. `ollama-mcp-bridge`'s `toolFilter` applies the same allowlists as a second layer. See the comments in [`mcp-config.json`](./mcp-config.json) before changing either.
- **GitHub (Human-in-the-Loop):** only `get_file_contents`, `create_branch`, `create_or_update_file` and `create_pull_request`. Merge, force-push, fork and repository admin tools are blocked, and writes are limited to `security/fix-*` branches, so the agent can never commit to `main` or merge its own PR. Commits to `package.json` may only change versions of dependencies already listed: the guard reads the current file from the branch, rejects anything else (removed scripts or dependencies, added packages), and commits the real file with only those version strings changed.
- **Trivy (least privilege):** only vulnerability scans (`scanType: ["vuln"]`) of `my-demo-app`, plus reading the findings. Remote repository and image scans are blocked, and symlinks are resolved so a scan can't escape the project directory.

**Hardening in place:**
- The API is fronted by [`api-guard`](./api-guard/api-guard.js), which requires `Authorization: Bearer $AGENT_API_TOKEN` on every request and rejects unexpected `Host` headers (blocking DNS-rebinding attacks from websites). The bridge itself listens only inside the container, so it cannot be reached around the guard.
- The API is published on `127.0.0.1:8000` only, and CORS is restricted so websites you visit cannot drive the agent through your browser.
- The GitHub token is passed only to the GitHub MCP server; Trivy never sees it.
- Trivy, the Trivy MCP plugin, the GitHub MCP server and the bridge are version-pinned; Trivy and its plugin are verified against published SHA-256 checksums at build time.
- `.dockerignore` keeps `.env` and other local secrets out of the image.

## License
MIT - Clean-room implementation for demonstration purposes.
