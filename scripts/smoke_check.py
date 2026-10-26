"""HTTP half of scripts/smoke.sh. Exits non-zero on the first failed check.

    python3 scripts/smoke_check.py <base-url> <mcp-api-key>
"""

import json
import sys
import time
import urllib.error
import urllib.request

BASE, KEY = sys.argv[1], sys.argv[2]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


opener = urllib.request.build_opener(NoRedirect)


def request(path, body=None, token=None, session=None, method=None):
    headers = {"Accept": "application/json, text/event-stream", "User-Agent": "simplifi-smoke/1.0"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if session:
        headers["mcp-session-id"] = session
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
        method=method or ("POST" if body is not None else "GET"),
    )
    try:
        with opener.open(req, timeout=10) as resp:
            return resp.status, dict(resp.headers), resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()


def rpc_result(raw):
    """Pull the JSON-RPC message out of a JSON or SSE response body."""
    for line in raw.splitlines():
        if line.startswith("data:"):
            raw = line[len("data:"):].strip()
            break
    return json.loads(raw)


def check(cond, msg):
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"ok: {msg}")


deadline = time.time() + 30
while True:
    try:
        status, _, _ = request("/healthz")
        if status == 200:
            break
    except OSError:
        pass
    if time.time() > deadline:
        check(False, "server answered /healthz within 30s")
    time.sleep(1)
check(True, "server answered /healthz")

init = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "simplifi-smoke", "version": "1.0"},
    },
}

status, _, _ = request("/mcp", init)
check(status == 401, f"/mcp without a bearer is refused (got {status})")

status, _, _ = request("/mcp", init, token="wrong-" + KEY)
check(status == 401, f"/mcp with a wrong bearer is refused (got {status})")

status, headers, body = request("/mcp", init, token=KEY)
check(status == 200, f"initialize with the static bearer succeeds (got {status})")
session = {k.lower(): v for k, v in headers.items()}.get("mcp-session-id")
check(bool(session), "initialize returned an mcp-session-id")
check("result" in rpc_result(body), "initialize returned a result")

request("/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"}, token=KEY, session=session)

status, _, body = request("/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, token=KEY, session=session)
names = {t["name"] for t in rpc_result(body)["result"]["tools"]}
for expected in ("simplifi_status", "list_uncategorized_transactions", "categorize_transaction"):
    check(expected in names, f"tools/list includes {expected}")

status, _, body = request(
    "/mcp",
    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "simplifi_status", "arguments": {}}},
    token=KEY,
    session=session,
)
result = rpc_result(body)["result"]
report = json.loads(result["content"][0]["text"])
check(report.get("authorization") == "awaiting_authorization", "simplifi_status reports awaiting_authorization")
check(report.get("authorizeUrl", "").endswith("/seed"), "simplifi_status points at /seed")

status, headers, _ = request("/seed")
location = {k.lower(): v for k, v in headers.items()}.get("location", "")
check(status == 302 and "/oauth/authorize?" in location and "client_id=seed" in location, "/seed redirects to the authorize page")

status, _, body = request(location)
check(status == 200 and "password" in body.lower(), "the seed authorize page renders a login form")

print("smoke: all checks passed")
