import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadConfig, seedRedirectUri } from "../src/config.js";

const REQUIRED = {
  PUBLIC_BASE_URL: "https://simplifi-mcp.example.com",
  OAUTH_JWT_SECRET: "jwt-secret",
  OAUTH_LOGIN_USERNAME: "admin",
  OAUTH_LOGIN_PASSWORD: "pw",
  SIMPLIFI_EMAIL: "user@example.com",
  SIMPLIFI_PASSWORD: "pw",
  SIMPLIFI_DATASET_ID: "1",
};

describe("loadConfig", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const key of ["MCP_API_KEY", "OAUTH_ALLOWED_REDIRECT_URIS"]) {
      delete process.env[key];
    }
    Object.assign(process.env, REQUIRED);
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("leaves the static bearer off when MCP_API_KEY is unset", () => {
    assert.equal(loadConfig().server.mcpApiKey, undefined);
  });

  it("refuses a short MCP_API_KEY", () => {
    process.env.MCP_API_KEY = "too-short";
    assert.throws(() => loadConfig(), /at least 32 characters/);
  });

  it("accepts a long MCP_API_KEY", () => {
    process.env.MCP_API_KEY = "k".repeat(64);
    assert.equal(loadConfig().server.mcpApiKey, "k".repeat(64));
  });

  it("keeps an empty redirect allowlist empty (all redirects allowed)", () => {
    assert.deepEqual(loadConfig().oauth.allowedRedirectUris, []);
  });

  it("adds the seed callback to a non-empty allowlist", () => {
    process.env.OAUTH_ALLOWED_REDIRECT_URIS = "https://claude.ai/api/mcp/auth/callback";
    assert.deepEqual(loadConfig().oauth.allowedRedirectUris, [
      "https://claude.ai/api/mcp/auth/callback",
      seedRedirectUri(REQUIRED.PUBLIC_BASE_URL),
    ]);
  });
});
