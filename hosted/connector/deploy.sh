#!/bin/bash
# Publishes the connector to its Railway service. The repo's railway.json builds the dashboard, so
# this uploads a clean copy of the committed tree with the connector's own config instead. Only
# committed files go: no .env, no keys.
set -euo pipefail
cd "$(dirname "$0")/../.."

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
git archive HEAD | tar -x -C "$STAGE"
cat > "$STAGE/railway.json" <<'JSON'
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "hosted/connector/Dockerfile" },
  "deploy": { "healthcheckPath": "/health", "restartPolicyType": "ON_FAILURE" }
}
JSON
PROJECT=$(railway status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.id, j.environments.edges[0].node.id)})')
read -r PROJECT_ID ENVIRONMENT_ID <<< "$PROJECT"
(cd "$STAGE" && railway up --ci -p "$PROJECT_ID" -e "$ENVIRONMENT_ID" -s connector)
