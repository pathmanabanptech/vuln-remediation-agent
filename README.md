# vuln-remediation-agent
## Autonomous DevSecOps via Local Llama & Model Context Protocol (MCP)
The `vuln-remediation-agent` is a **Privacy-First** autonomous remediation agent. It leverages an internally hosted **Llama 3.1 8B (sLLM)** to analyze vulnerability reports from **Trivy** and propose code fixes as **GitHub pull requests** for a human to review and merge.

Built with **Healthcare and Financial Services** compliance in mind, this architecture keeps proprietary source code and vulnerability data away from third-party LLM providers.

## Why This Architecture?
In traditional enterprise environments, security is often a reactive **"Context-Switching Tax."** Tools like `npm audit` or Nexus IQ identify risks but leave the high-friction work of triage and remediation to the developer, slowing down velocity and leaving windows of vulnerability open. Furthermore, standard AI security solutions introduce **"Data Exit"** risks by sending proprietary codebases to public LLM APIs a non-starter for high-compliance sectors like Healthcare and Finance.

The **vuln-remediation-agent** solves these challenges by shifting the paradigm from **Reactive Detection to Proactive Immunity**:
- **Ensures Data Privacy:** All reasoning runs on a local Llama 3.1 8B; source code and vulnerability data are never sent to an LLM provider.
- **Proactive Remediation:** Instead of waiting for a post-build alert, the agent identifies and fixes vulnerabilities at the point of inception. It moves the needle from "Shift-Left Detection" to **"Shift-Left Correction."**
- **Human-in-the-Loop by Design:** The agent can only open pull requests. Merging is always a human decision, enforced in code rather than by prompt instructions (see [Security & Privacy](#security--privacy)).
- **Reproducible Infrastructure:** Fully containerized via Docker Compose, with pinned and checksum-verified tooling.
- **Zero-Friction DevSecOps:** The agent acts as a "Digital Pair Programmer" that handles the grunt work of identifying "Policy-Clean" versions and preparing PRs,  allowing engineers to stay in the "flow state" and focus on feature delivery rather than security debt.

## Architecture 
![System Architecture](./assets/agent_archi.jpg)

### Key Components:
* **Reasoning Engine:** Local Llama 3.1 via Ollama (Hardware accelerated).
* **Orchestration:** `ollama-mcp-bridge` acting as a stateless proxy.
* **Security Scanner:** [Trivy MCP plugin](https://github.com/aquasecurity/trivy-mcp) for filesystem vulnerability discovery.
* **GitOps:** GitHub MCP Server for branch creation, commits and PR creation.
* **Guardrails:** **`mcp-guard`**, an allowlist proxy in front of both MCP servers that enforces Human-in-the-Loop and least privilege.

The agent operates on a **Observe-Orient-Decide-Act (OODA)** loop:

- **Observe:** Reads package.json using GitHub MCP.
- **Orient:** Executes a Trivy scan to identify CVEs and "Fixed Versions."
- **Decide:** Llama reasons if the fix is safe to apply (e.g., no breaking major version changes).
- **Act:** Commits the change to a `security/fix-*` branch and opens a PR with a detailed security summary for human review.


## Tech Stack
- **AI Brain:** Llama 3.1 (8B/70B) via [Ollama](https://ollama.com/)
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

    *Note: For Apple Silicon users, it is recommended to run Ollama locally to take advantage of Metal GPU acceleration, while the **vuln-remediation-agent** runs containerized via Docker Compose.*
2. **Configuration**

    Copy `.env.example` to `.env` in the root directory and add your token:
    ```
    GITHUB_TOKEN=your_fine_grained_pat_here
    ```
  
3. **Launch the Agent**
    - Launch llama on your mac: `ollama run llama3.1`
        *(keep this terminal open)*

    - Run the bridge to connect Llama to the MCP tools:
        ```bash
        # Start the containers
        docker compose up -d

        # Verify the agent
        docker logs -f vuln-remediation-agent
        ```
    - Test your Agent (or run `./test-agent.sh`)
        ```
        curl -X POST http://localhost:8000/api/chat \
            -H "Content-Type: application/json" \
            -d '{
                "model": "llama3.1",
                "messages": [{"role": "user", "content": "Run security audit and fix vulnerabilities."}],
                "stream": false
            }'
        ```
    - Review the pull request the agent opens on GitHub, and merge it yourself if the fix is correct.

4. **Enterprise Hosting Models:**

As a cloud-native solution, this agent can be scaled across various environments:

- **Local Developer:** Runs as a background service on Apple Silicon or NVIDIA-enabled workstations.
- **Private Cloud (AWS/Azure/GCP):** Hosted on GPU-enabled instances (e.g., EC2 g5.xlarge) within a private VPC.
- **On-Prem Kubernetes:** Deployed as a sidecar to CI/CD runners (Jenkins/GitLab) to provide real-time remediation during the build phase.


## Security & Privacy
This project was built with Finance and Healthcare grade privacy in mind. By using a Llama instance, we avoid the risks associated with sending proprietary codebases to third-party LLM providers. All reasoning happens within your execution environment. The only outbound connections are to the GitHub API (to read files and open PRs) and to download Trivy's vulnerability database.

**Tool allowlists enforced in code.** Both MCP servers are wrapped by [`mcp-guard`](./mcp-guard/mcp-guard.js), a proxy that hides every tool not in that server's [policy](./mcp-guard/policies/) from the model, rejects it if called anyway, and checks arguments. `ollama-mcp-bridge`'s `toolFilter` applies the same allowlists as a second layer. See the comments in [`mcp-config.json`](./mcp-config.json) before changing either.
- **GitHub (Human-in-the-Loop):** only `get_file_contents`, `create_branch`, `create_or_update_file` and `create_pull_request`. Merge, force-push, fork and repository admin tools are blocked, and writes are limited to `security/fix-*` branches, so the agent can never commit to `main` or merge its own PR.
- **Trivy (least privilege):** only vulnerability scans (`scanType: ["vuln"]`) of `my-demo-app`, plus reading the findings. Remote repository and image scans are blocked, and symlinks are resolved so a scan can't escape the project directory.

**Hardening in place:**
- The API listens on `127.0.0.1:8000` only, and CORS is restricted so websites you visit cannot drive the agent through your browser.
- The GitHub token is passed only to the GitHub MCP server; Trivy never sees it.
- Trivy, the Trivy MCP plugin, the GitHub MCP server and the bridge are version-pinned; Trivy and its plugin are verified against published SHA-256 checksums at build time.
- `.dockerignore` keeps `.env` and other local secrets out of the image.

**Known limitation:** the bridge API has no authentication, so any process on the host can call it. Do not expose port 8000 beyond localhost.

## License
MIT - Clean-room implementation for demonstration purposes.
