# Quicken Simplifi MCP Server

Single-user MCP server (Node.js + TypeScript) for Quicken Simplifi transactions.

It provides MCP tools:
- `list_transactions`
- `search_transactions`
- `get_transaction`
- `update_transaction`
- `categorize_transaction`
- `list_uncategorized_transactions`
- `search_merchants`
- `list_categories` / `search_categories`
- `list_tags` / `search_tags`
- `suggest_categories_for_merchant`
- `simplifi_status`

It includes:
- local transaction cache (SQLite)
- automatic full + incremental sync from Simplifi
- OAuth 2.0 (Authorization Code + PKCE, plus refresh tokens) to protect `/mcp`
- an optional static bearer (`MCP_API_KEY`) for headless clients

## How It Works

### 1) Simplifi upstream auth
This server authenticates to Simplifi with:
- `SIMPLIFI_EMAIL`
- `SIMPLIFI_PASSWORD`

By default it uses the Simplifi web client values observed in HAR traffic:
- `SIMPLIFI_CLIENT_ID=acme_web`
- `SIMPLIFI_CLIENT_SECRET=BCDCxXwdWYcj@bK6`
- `SIMPLIFI_REDIRECT_URI=https://simplifi.quicken.com/login`

Runtime behavior:
1. Login with `/oauth/authorize` + `/oauth/token` to obtain tokens. This happens only
   inside the browser authorize page (an MCP client's OAuth flow, or `/seed`), because
   on an MFA-enabled account it sends an MFA challenge that has to be answered there.
2. Persist access/refresh token in local SQLite (encrypted when `SIMPLIFI_TOKEN_ENC_KEY` is set).
3. Use refresh token automatically when access token expires.
4. Never start a credential login from the background sync or a tool call. If Simplifi
   rejects the refresh token (HTTP 400/401/403), the server drops it, the sync loop goes
   idle, and `simplifi_status` reports `awaiting_authorization` until someone logs in
   through `/seed` again. A 429, a 5xx or a network failure keeps the token for the next
   attempt.

### 2) MCP downstream auth
Your MCP clients authenticate to this server via OAuth 2.0:
- `GET /oauth/authorize`
- `POST /oauth/token`
- bearer access token on `Authorization: Bearer ...` for `/mcp`

Clients that cannot run a browser flow can instead send a static bearer: set
`MCP_API_KEY` (at least 32 characters) and send `Authorization: Bearer <MCP_API_KEY>`.
OAuth access tokens keep working alongside it. Leave `MCP_API_KEY` unset to keep
`/mcp` OAuth-only.

This keeps Simplifi credentials/tokens server-side only.

### 3) Local cache and sync
- On first run, it does a full sync from Simplifi transactions.
- Background incremental sync runs every `SIMPLIFI_SYNC_INTERVAL_MS`.
- Tool calls also enforce freshness (`SIMPLIFI_MAX_STALE_MS`) before querying cache.

## Project Layout

- `src/index.ts`: app bootstrap
- `src/http/server.ts`: HTTP server, OAuth endpoints, MCP transport
- `src/mcp/server.ts`: MCP tool definitions
- `src/services/transaction-tool-service.ts`: tool behavior
- `src/services/status-service.ts`: `simplifi_status` (authorization + sync health)
- `src/simplifi/*`: Simplifi auth + API client
- `src/sync/sync-service.ts`: sync orchestration
- `src/db/database.ts`: SQLite schema + repository methods

## Requirements

- Node.js 22 (pinned in `.node-version` and `mise.toml`; `better-sqlite3` has no
  prebuilt binary for newer majors)
- Yarn 1.x

## Development checks

```bash
yarn run check   # typecheck (`yarn check` alone runs Yarn's built-in, not this)
yarn run test    # unit tests
docker build -t quicken-simplifi-mcp:smoke . && scripts/smoke.sh quicken-simplifi-mcp:smoke
```

CI (`.github/workflows/ci.yml`) runs all three on every pull request and pushes the
smoke-tested image to `ghcr.io/nprodromou/quicken-simplifi-mcp:sha-<short>` from `main`.

## Setup

1. Install dependencies

```bash
yarn install
```

2. Create env file

```bash
cp .env.example .env
```

3. Fill required variables in `.env`

Required minimum:
- `OAUTH_JWT_SECRET`
- `OAUTH_LOGIN_USERNAME`
- `OAUTH_LOGIN_PASSWORD`
- `SIMPLIFI_EMAIL`
- `SIMPLIFI_PASSWORD`
- `SIMPLIFI_DATASET_ID`
- `SIMPLIFI_THREAT_METRIX_SESSION_ID` (recommended; required by current Simplifi authorize flow)

Optional but recommended:
- `OAUTH_ALLOWED_REDIRECT_URIS` (comma-separated allowlist)
- `PUBLIC_BASE_URL`
- `CACHE_DB_PATH`

4. Run in development

```bash
yarn dev
```

5. Build and run production

```bash
yarn build
yarn start
```

## MCP Endpoint

- MCP URL: `https://<your-host>/mcp`
- OAuth authorize URL: `https://<your-host>/oauth/authorize`
- OAuth token URL: `https://<your-host>/oauth/token`

## Tool Contracts

### `list_transactions`
Inputs (all optional):
- `limit` (1-200, default 50)
- `cursor`
- `accountId`
- `dateFrom` (`YYYY-MM-DD`)
- `dateTo` (`YYYY-MM-DD`)
- `minAmount`
- `maxAmount`
- `includeDeleted`
- `refresh`

### `search_transactions`
Inputs:
- `query` (required)
- same optional filters as `list_transactions`

### `get_transaction`
Inputs:
- `transactionId` (required)
- `refreshOnMiss` (optional, default true)

### `update_transaction`
Inputs:
- `transactionId` (required)
- `patch` (required object)

`update_transaction` merges `patch` into the cached transaction, validates required Simplifi upsert fields, sends `PUT /transactions/{transactionId}`, then resyncs.

### `categorize_transaction`
Inputs:
- `transactionId` (required)
- `categoryId` (required)

Sets `coa.type=CATEGORY` and `coa.id=<categoryId>` via `update_transaction`.

### `list_uncategorized_transactions`
Inputs: same as `list_transactions`

Returns transactions that appear uncategorized (typically `coa.type=UNCATEGORIZED` or `coa.id=0`).

### `search_merchants`
Inputs:
- `query` (required)
- `limit` (optional, 1-200)
- `includeDeleted` (optional)

Returns merchant name suggestions derived from cached transactions (grouped and counted).

### `list_categories`
Inputs:
- `refresh` (optional)
- `limit` (optional, 1-5000)

### `search_categories`
Inputs:
- `query` (required)
- `refresh` (optional)
- `limit` (optional, 1-5000)

### `list_tags`
Inputs:
- `refresh` (optional)
- `limit` (optional, 1-5000)

### `search_tags`
Inputs:
- `query` (required)
- `refresh` (optional)
- `limit` (optional, 1-5000)

### `suggest_categories_for_merchant`
Inputs:
- `merchant` (required)
- `limit` (optional, 1-20)
- `matchMode` (optional: `exact` or `contains`)
- `refreshCategories` (optional)

Returns the most common categories historically used for that merchant in your cached transactions (joined to category names when available).

### `simplifi_status`
Inputs: none.

Returns whether a Simplifi authorization is held (`authorized` or
`awaiting_authorization`, with an `authorizeUrl` in the latter case), token expiry
times, the sync loop's last status, times and error, and the cached transaction count.
It reads local state only and never contacts Simplifi, so it is safe to poll from a
liveness check.

## Production Deployment

### Option A: systemd (VM/bare-metal)

1. Build app:

```bash
yarn install --frozen-lockfile
yarn build
```

2. Run behind reverse proxy (Nginx/Caddy) with TLS.

3. Store `.env` outside repo and protect file permissions.

4. Use a `systemd` service that runs:

```bash
node /path/to/app/dist/index.js
```

### Option B: Docker

Build image:

```bash
docker build -t simplifi-mcp:latest .
```

Run container:

```bash
docker run -d \
  --name simplifi-mcp \
  --restart unless-stopped \
  -p 8787:8787 \
  --env-file .env \
  -v simplifi_mcp_data:/app/data \
  simplifi-mcp:latest
```

## Security Notes

- Treat `.env` as sensitive.
- Use a strong `OAUTH_JWT_SECRET` (32+ random bytes).
- Set `OAUTH_ALLOWED_REDIRECT_URIS` in production.
- Put the server behind HTTPS.
- Restrict network access (firewall, VPN, or zero-trust access policy).

## Operational Notes

- Health endpoint: `GET /healthz`
- OAuth metadata:
  - `GET /.well-known/oauth-authorization-server`
  - `GET /.well-known/openid-configuration`
- Cache lives in SQLite at `CACHE_DB_PATH`.
- MCP sessions live in memory. A session idle for 24 hours is closed by an hourly
  sweep, and a request for an unknown or closed session gets `404`, which tells the
  client to initialize a new one (after a sweep or a restart).
- Seeding a headless deployment: open `GET /seed` in a browser, log in with
  `OAUTH_LOGIN_USERNAME` / `OAUTH_LOGIN_PASSWORD`, and enter the Simplifi MFA code if
  asked. The next background sync (within `SIMPLIFI_SYNC_INTERVAL_MS`) starts the full
  sync. Repeat whenever `simplifi_status` reports `awaiting_authorization`.

## Troubleshooting

- `401 invalid_token` on `/mcp`:
  - token expired/invalid, re-run OAuth flow.
- Simplifi sync errors:
  - verify `SIMPLIFI_EMAIL`, `SIMPLIFI_PASSWORD`, and `SIMPLIFI_DATASET_ID`.
- Sync idle, `simplifi_status` says `awaiting_authorization`:
  - no refresh token is held (never seeded, or Simplifi rejected it). Log in via `/seed`.
- Empty cache on first start:
  - initial full sync runs in background; wait, then retry tool call.
