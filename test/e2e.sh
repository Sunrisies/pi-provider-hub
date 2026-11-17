#!/usr/bin/env bash
# End-to-end check: extension registers a provider from provider-hub.json and
# pi can actually chat through the mock site.
set -u
cd "$(dirname "$0")/.." || exit 1
PORT=49988
export MOCK_PORT=$PORT

node test/mock-server.mjs > mock-server.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
sleep 1

if ! curl -s -H "Authorization: Bearer test-key" "http://127.0.0.1:$PORT/v1/models" >/dev/null; then
  echo "MOCK NOT REACHABLE"; cat mock-server.log; exit 1
fi

cat > .tmp-agent/provider-hub.json <<EOF
{
  "version": 1,
  "providers": [
    {
      "id": "mock-hub",
      "name": "Mock Hub",
      "baseUrl": "http://127.0.0.1:$PORT/v1",
      "apiKey": "test-key",
      "api": "openai-completions",
      "filter": "",
      "models": [
        {
          "id": "mock-chat-pro",
          "name": "mock-chat-pro",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 8192
        }
      ],
      "createdAt": "2026-11-17T00:00:00.000Z",
      "updatedAt": "2026-11-17T00:00:00.000Z"
    }
  ]
}
EOF

echo "== list-models"
PI_CODING_AGENT_DIR="D:/project/user/pi/pi-provider-hub/.tmp-agent" pi -e ./index.ts --list-models 2>&1 | tail -5

echo "== chat"
PI_CODING_AGENT_DIR="D:/project/user/pi/pi-provider-hub/.tmp-agent" pi -e ./index.ts -p "say hi" --no-session 2>&1 | tail -15