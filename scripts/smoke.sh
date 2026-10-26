#!/usr/bin/env bash
# Boot a built image with throwaway config and prove it serves MCP.
#
#   scripts/smoke.sh <image>
#
# No Simplifi credentials are used and SIMPLIFI_BASE_URL points at a closed
# port, so nothing leaves the runner. With no stored authorization the server
# must start, enforce the bearer, list its tools, and report
# awaiting_authorization from simplifi_status. scripts/smoke_check.py does the
# HTTP side.
set -euo pipefail

image="${1:?usage: smoke.sh <image>}"
name="simplifi-smoke-$$"
port="${SMOKE_PORT:-18787}"
key="smoke-$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- container logs ---" >&2
    docker logs "$name" >&2 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker run -d --name "$name" -p "127.0.0.1:${port}:8787" \
  -e MCP_API_KEY="$key" \
  -e PUBLIC_BASE_URL="http://localhost:${port}" \
  -e OAUTH_JWT_SECRET=smoke-jwt-secret \
  -e OAUTH_LOGIN_USERNAME=smoke \
  -e OAUTH_LOGIN_PASSWORD=smoke \
  -e SIMPLIFI_EMAIL=smoke@example.invalid \
  -e SIMPLIFI_PASSWORD=smoke \
  -e SIMPLIFI_DATASET_ID=0 \
  -e SIMPLIFI_BASE_URL=http://127.0.0.1:9 \
  -e SIMPLIFI_TOKEN_ENC_KEY="$(head -c 32 /dev/urandom | base64)" \
  "$image" >/dev/null

uid="$(docker exec "$name" id -u)"
if [ "$uid" = "0" ]; then
  echo "FAIL: container runs as root" >&2
  exit 1
fi

python3 "$(dirname "$0")/smoke_check.py" "http://127.0.0.1:${port}" "$key"
