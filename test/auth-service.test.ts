import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AppConfig } from "../src/config.js";
import { DatabaseContext } from "../src/db/database.js";
import { SimplifiAuthService, SimplifiReauthRequiredError } from "../src/simplifi/auth-service.js";

const simplifiConfig: AppConfig["simplifi"] = {
  baseUrl: "https://services.quicken.invalid",
  email: "user@example.com",
  password: "not-a-real-password",
  datasetId: "1",
  clientId: "acme_web",
  clientSecret: "secret",
  redirectUri: "https://simplifi.quicken.invalid/login",
  tokenEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  httpTimeoutMs: 1_000,
  syncIntervalMs: 60_000,
  maxStaleMs: 120_000,
  pageLimit: 100,
};

const past = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe("SimplifiAuthService.getAccessToken", () => {
  const realFetch = globalThis.fetch;
  let dir: string;
  let db: DatabaseContext;
  let auth: SimplifiAuthService;
  let calls: string[];

  function stubFetch(respond: () => Response | Promise<Response>): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(new URL(String(input)).pathname);
      return respond();
    }) as typeof fetch;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "simplifi-auth-"));
    db = new DatabaseContext(path.join(dir, "cache.sqlite"), simplifiConfig.tokenEncryptionKey);
    auth = new SimplifiAuthService(simplifiConfig, db);
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses without a stored token and never attempts a credential login", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));

    await assert.rejects(auth.getAccessToken(), SimplifiReauthRequiredError);
    assert.deepEqual(calls, []);
  });

  it("returns a cached access token that has not expired", async () => {
    db.saveSimplifiTokens({ accessToken: "live", accessTokenExpiresAt: future(), refreshToken: "r1" });
    stubFetch(() => new Response("{}", { status: 500 }));

    assert.equal(await auth.getAccessToken(), "live");
    assert.deepEqual(calls, []);
  });

  it("refreshes an expired access token and stores the rotated pair", async () => {
    db.saveSimplifiTokens({ accessToken: "old", accessTokenExpiresAt: past(), refreshToken: "r1" });
    stubFetch(
      () =>
        new Response(JSON.stringify({ accessToken: "new", refreshToken: "r2", accessTokenExpired: future() }), {
          status: 200,
        }),
    );

    assert.equal(await auth.getAccessToken(), "new");
    assert.deepEqual(calls, ["/oauth/token"]);
    assert.equal(db.getSimplifiTokens()?.refreshToken, "r2");
  });

  for (const status of [400, 401, 403]) {
    it(`clears tokens on a ${status} refresh rejection instead of logging in`, async () => {
      db.saveSimplifiTokens({ accessToken: "old", accessTokenExpiresAt: past(), refreshToken: "r1" });
      stubFetch(() => new Response('{"error":"invalid_grant"}', { status }));

      await assert.rejects(auth.getAccessToken(), SimplifiReauthRequiredError);
      assert.deepEqual(calls, ["/oauth/token"]);
      assert.equal(auth.getAuthStatus().authorized, false);

      // The next call must not retry the dead refresh token or start a login.
      await assert.rejects(auth.getAccessToken(), SimplifiReauthRequiredError);
      assert.deepEqual(calls, ["/oauth/token"]);
    });
  }

  for (const status of [429, 503]) {
    it(`keeps tokens on a transient ${status} so the next tick can retry`, async () => {
      db.saveSimplifiTokens({ accessToken: "old", accessTokenExpiresAt: past(), refreshToken: "r1" });
      stubFetch(() => new Response("busy", { status }));

      await assert.rejects(auth.getAccessToken(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof SimplifiReauthRequiredError));
        return true;
      });
      assert.deepEqual(calls, ["/oauth/token"]);
      assert.equal(auth.getAuthStatus().authorized, true);
    });
  }

  it("keeps tokens when the refresh request fails at the network layer", async () => {
    db.saveSimplifiTokens({ accessToken: "old", accessTokenExpiresAt: past(), refreshToken: "r1" });
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    await assert.rejects(auth.getAccessToken(), TypeError);
    assert.equal(auth.getAuthStatus().authorized, true);
  });
});
