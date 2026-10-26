import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  server: {
    host: string;
    port: number;
    publicBaseUrl: string;
    corsOrigin: string;
    mcpApiKey?: string;
  };
  cache: {
    dbPath: string;
  };
  oauth: {
    issuer: string;
    audience: string;
    jwtSecret: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    loginUsername: string;
    loginPassword: string;
    allowedRedirectUris: string[];
  };
  simplifi: {
    baseUrl: string;
    email: string;
    password: string;
    datasetId: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    tokenEncryptionKey?: string;
    threatMetrixSessionId?: string;
    threatMetrixRequestId?: string;
    httpTimeoutMs: number;
    syncIntervalMs: number;
    maxStaleMs: number;
    pageLimit: number;
  };
}

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric environment variable ${name}: ${raw}`);
  }
  return value;
}

function parseRedirectAllowlist(raw: string): string[] {
  if (!raw.trim()) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// The /seed flow (src/http/server.ts) runs the authorize page as this client and
// redirects back to the server itself.
export const SEED_CLIENT_ID = "seed";

export function seedRedirectUri(publicBaseUrl: string): string {
  return new URL("/seed/done", publicBaseUrl).toString();
}

// An empty allowlist already admits every redirect. A non-empty one must still
// admit the server's own seed callback, or /seed stops working.
function withSeedRedirect(allowlist: string[], publicBaseUrl: string): string[] {
  if (allowlist.length === 0) {
    return allowlist;
  }
  const seed = seedRedirectUri(publicBaseUrl);
  return allowlist.includes(seed) ? allowlist : [...allowlist, seed];
}

// Optional static bearer for headless MCP clients that cannot run an OAuth browser
// flow. Unset keeps /mcp OAuth-only. A short key is refused rather than accepted.
function parseMcpApiKey(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (value.length < 32) {
    throw new Error("MCP_API_KEY must be at least 32 characters");
  }
  return value;
}

export function loadConfig(): AppConfig {
  const port = getNumberEnv("PORT", 8787);
  const host = process.env.HOST ?? "0.0.0.0";
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;

  const cacheDbPath = path.resolve(process.cwd(), process.env.CACHE_DB_PATH ?? "./data/cache.sqlite");

  return {
    server: {
      host,
      port,
      publicBaseUrl,
      corsOrigin: process.env.CORS_ORIGIN ?? "*",
      mcpApiKey: parseMcpApiKey(process.env.MCP_API_KEY),
    },
    cache: {
      dbPath: cacheDbPath,
    },
    oauth: {
      issuer: process.env.OAUTH_ISSUER ?? publicBaseUrl,
      audience: process.env.OAUTH_AUDIENCE ?? "simplifi-mcp",
      jwtSecret: getEnv("OAUTH_JWT_SECRET"),
      accessTokenTtlSeconds: getNumberEnv("OAUTH_ACCESS_TOKEN_TTL_SECONDS", 900),
      refreshTokenTtlSeconds: getNumberEnv("OAUTH_REFRESH_TOKEN_TTL_SECONDS", 60 * 60 * 24 * 30),
      loginUsername: getEnv("OAUTH_LOGIN_USERNAME"),
      loginPassword: getEnv("OAUTH_LOGIN_PASSWORD"),
      allowedRedirectUris: withSeedRedirect(
        parseRedirectAllowlist(process.env.OAUTH_ALLOWED_REDIRECT_URIS ?? ""),
        publicBaseUrl,
      ),
    },
    simplifi: {
      baseUrl: process.env.SIMPLIFI_BASE_URL ?? "https://services.quicken.com",
      email: getEnv("SIMPLIFI_EMAIL"),
      password: getEnv("SIMPLIFI_PASSWORD"),
      datasetId: getEnv("SIMPLIFI_DATASET_ID"),
      clientId: process.env.SIMPLIFI_CLIENT_ID ?? "acme_web",
      clientSecret: process.env.SIMPLIFI_CLIENT_SECRET ?? "BCDCxXwdWYcj@bK6",
      redirectUri: process.env.SIMPLIFI_REDIRECT_URI ?? "https://simplifi.quicken.com/login",
      tokenEncryptionKey: process.env.SIMPLIFI_TOKEN_ENC_KEY?.trim() || undefined,
      // Coerce empty-string env vars to undefined so the auth service's
      // `?? randomUUID()` fallback fires (an empty string would otherwise be sent
      // verbatim, which Simplifi rejects with "must be specified").
      threatMetrixSessionId: process.env.SIMPLIFI_THREAT_METRIX_SESSION_ID?.trim() || undefined,
      threatMetrixRequestId: process.env.SIMPLIFI_THREAT_METRIX_REQUEST_ID?.trim() || undefined,
      httpTimeoutMs: getNumberEnv("SIMPLIFI_HTTP_TIMEOUT_MS", 30_000),
      syncIntervalMs: getNumberEnv("SIMPLIFI_SYNC_INTERVAL_MS", 60_000),
      maxStaleMs: getNumberEnv("SIMPLIFI_MAX_STALE_MS", 120_000),
      pageLimit: getNumberEnv("SIMPLIFI_PAGE_LIMIT", 5000),
    },
  };
}
