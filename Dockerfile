FROM python:3.11-slim

# Install Trivy (The Security Scanner)
RUN apt-get update && apt-get install -y curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs ca-certificates tar git \
    && rm -rf /var/lib/apt/lists/*

# Pinned Trivy release, verified against the SHA-256 values published in
# trivy_${TRIVY_VERSION}_checksums.txt. Update the hashes when bumping the version.
ARG TRIVY_VERSION=0.75.0
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) TRIVY_ARCH=64bit; TRIVY_SHA256=c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f ;; \
      arm64) TRIVY_ARCH=ARM64; TRIVY_SHA256=a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3 ;; \
      *) echo "Unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/trivy.tar.gz "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${TRIVY_ARCH}.tar.gz"; \
    echo "${TRIVY_SHA256}  /tmp/trivy.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/trivy.tar.gz -C /usr/local/bin trivy; \
    rm /tmp/trivy.tar.gz

# Trivy MCP server (official plugin, aquasecurity/trivy-mcp), pinned. `trivy plugin install`
# does no checksum verification, so the installed binary is checked against the SHA-256 of
# trivy-mcp inside the release tarballs (whose digests match GitHub's published asset digests).
ARG TRIVY_MCP_VERSION=0.0.20
RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) TRIVY_MCP_SHA256=ca95743462c7ed1fa92f51598c5dc65dbe53ce776c13e2fd23a310cfb499ffa2 ;; \
      arm64) TRIVY_MCP_SHA256=3c4cc4f92414afba70e4964ed0135e785737220f284dad9694b67ec5d4b457b7 ;; \
      *) echo "Unsupported architecture" >&2; exit 1 ;; \
    esac; \
    trivy plugin install "mcp@v${TRIVY_MCP_VERSION}"; \
    echo "${TRIVY_MCP_SHA256}  ${HOME}/.trivy/plugins/mcp/trivy-mcp" | sha256sum -c -

# Install the Bridge using pip (pinned: mcp-config.json relies on its toolFilter support)
RUN pip install --no-cache-dir ollama-mcp-bridge==0.12.2

# Set working directory
WORKDIR /app

# Copy configuration and local source
COPY mcp-config.json .
COPY agent_prompt.md .

COPY my-demo-app/package*.json ./

# Install dependencies
RUN npm install

COPY . .
# Port for the MCP Bridge API
EXPOSE 8000
# The entrypoint is handled by docker-compose