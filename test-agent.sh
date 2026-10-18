#!/bin/bash
# Uses AGENT_API_TOKEN from the environment, or from .env if not set.
# No "model" field: the agent always uses OLLAMA_MODEL (set when starting docker compose).
AGENT_API_TOKEN="${AGENT_API_TOKEN:-$(grep -E '^AGENT_API_TOKEN=' "$(dirname "$0")/.env" 2>/dev/null | cut -d= -f2-)}"
if [ -z "$AGENT_API_TOKEN" ]; then
  echo "AGENT_API_TOKEN is not set (add it to .env)" >&2
  exit 1
fi

echo "Triggering Autonomous Security Audit..."
curl -s -X POST http://localhost:8000/api/chat \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Run a security audit and fix only the axios vulnerability: one branch and one pull request."}],
    "stream": false
  }' | jq '.message.content'
