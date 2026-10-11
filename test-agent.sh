#!/bin/bash
# Uses AGENT_API_TOKEN from the environment, or from .env if not set.
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
    "model": "llama3.1",
    "messages": [{"role": "user", "content": "Run security audit and fix vulnerabilities."}],
    "stream": false
  }' | jq '.message.content'
