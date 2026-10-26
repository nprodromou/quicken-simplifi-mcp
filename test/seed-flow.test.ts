import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { AppConfig } from "../src/config.js";
import { DatabaseContext } from "../src/db/database.js";
import { startHttpServer, type RunningHttpServer } from "../src/http/server.js";
import { OAuthService } from "../src/oauth/oauth-service.js";
import type { SimplifiAuthService } from "../src/simplifi/auth-service.js";
import type { StatusService } from "../src/services/status-service.js";
import type { TransactionToolService } from "../src/services/transaction-tool-service.js";

const PUBLIC_BASE = "https://simplifi-mcp.example.com";
const SEED_DONE = `${PUBLIC_BASE}/seed/done`;
const CLIENT_CALLBACK = "http://localhost:33418/callback";

describe("authorize flow", () => {
  let dir: string;
  let db: DatabaseContext;
  let server: RunningHttpServer;
  let base: string;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "simplifi-seed-"));
    db = new DatabaseContext(path.join(dir, "cache.sqlite"), "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=");
    const config = {
      server: { host: "127.0.0.1", port: 0, publicBaseUrl: PUBLIC_BASE, corsOrigin: PUBLIC_BASE },
      cache: { dbPath: path.join(dir, "cache.sqlite") },
      oauth: {
        issuer: PUBLIC_BASE,
        audience: "simplifi-mcp",
        jwtSecret: "test-jwt-secret",
        accessTokenTtlSeconds: 900,
        refreshTokenTtlSeconds: 3600,
        loginUsername: "nate",
        loginPassword: "correct-horse",
        allowedRedirectUris: [CLIENT_CALLBACK, SEED_DONE],
      },
    } as unknown as AppConfig;
    // The Simplifi side always succeeds without MFA; this test is about what the
    // gateway hands back once the operator has passed the login form.
    const simplifiAuthService = {
      attemptLogin: async () => ({ status: "ok" }),
      getAuthStatus: () => ({ authorized: true }),
    } as unknown as SimplifiAuthService;
    server = await startHttpServer({
      config,
      oauthService: new OAuthService(config.oauth, db),
      simplifiAuthService,
      toolService: {} as TransactionToolService,
      statusService: {} as StatusService,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function login(clientId: string, redirectUri: string): Promise<Response> {
    return fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        username: "nate",
        password: "correct-horse",
      }).toString(),
    });
  }

  it("redirects the seed flow to its callback with no authorization code", async () => {
    const res = await login("seed", SEED_DONE);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), SEED_DONE);
  });

  it("issues no code at the seed callback whatever client_id asks for it", async () => {
    const res = await login("mcp-client", SEED_DONE);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), SEED_DONE);
  });

  it("still issues a code to a real client callback", async () => {
    const res = await login("mcp-client", CLIENT_CALLBACK);
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location") ?? "");
    assert.equal(location.origin + location.pathname, CLIENT_CALLBACK);
    assert.ok(location.searchParams.get("code"));
  });
});
