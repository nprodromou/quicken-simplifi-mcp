import { URL } from "node:url";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import type { SimplifiTokenSet } from "../types.js";
import { isExpired, nowIso } from "../utils.js";
import { DatabaseContext } from "../db/database.js";

const AUTHORIZATION_SKEW_MS = 60_000;

interface PendingMfa {
  mfaId: string;
  mfaChannel: string;
  email?: string;
  phone?: string;
  threatMetrixSessionId: string;
  expiresAt: number;
}

export type AttemptLoginResult =
  | { status: "ok" }
  | { status: "mfa_required"; pendingId: string; mfaChannel: string; email?: string; phone?: string };

export interface SimplifiAuthStatus {
  authorized: boolean;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  updatedAt?: string;
}

/**
 * Simplifi rejected the stored refresh token (or there is none). Only an interactive
 * login through the OAuth authorize page can recover, because that is the one path
 * allowed to answer an MFA challenge.
 */
export class SimplifiReauthRequiredError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SimplifiReauthRequiredError";
  }
}

// Statuses on which Simplifi has refused the refresh token itself. Anything else
// (429, 5xx, a network failure) is transient and the token is kept for a retry.
const REFRESH_REJECTED_STATUSES = new Set([400, 401, 403]);

export class SimplifiAuthService {
  private readonly pendingMfaMap = new Map<string, PendingMfa>();

  public constructor(
    private readonly config: AppConfig["simplifi"],
    private readonly db: DatabaseContext,
  ) {}

  /**
   * Returns a usable access token, refreshing it when needed, and never starts a
   * credential login. On an MFA-enabled account a credential login sends an MFA
   * challenge, so a background sync falling back to one would send a challenge on
   * every tick until Simplifi locks the account out. Only attemptLogin(), driven
   * from the OAuth authorize page, may log in with credentials.
   */
  public async getAccessToken(): Promise<string> {
    const cached = this.db.getSimplifiTokens();

    if (cached && !isExpired(cached.accessTokenExpiresAt, AUTHORIZATION_SKEW_MS)) {
      return cached.accessToken;
    }

    if (!cached?.refreshToken) {
      throw new SimplifiReauthRequiredError(
        "No stored Simplifi refresh token. Complete the browser authorization to seed one.",
      );
    }

    try {
      const refreshed = await this.refreshToken(cached.refreshToken);
      this.db.saveSimplifiTokens(refreshed);
      return refreshed.accessToken;
    } catch (error) {
      if (error instanceof SimplifiReauthRequiredError) {
        // Drop the dead token so hasStoredAuth() turns the sync loop into a no-op
        // instead of retrying a refresh that cannot succeed.
        this.clearTokens();
        logWarn("Simplifi rejected the refresh token; browser re-authorization required", {
          error: error.message,
        });
      }
      throw error;
    }
  }

  public getAuthStatus(): SimplifiAuthStatus {
    const cached = this.db.getSimplifiTokens();
    if (!cached || cached.refreshToken.trim().length === 0) {
      return { authorized: false };
    }

    return {
      authorized: true,
      accessTokenExpiresAt: cached.accessTokenExpiresAt,
      refreshTokenExpiresAt: cached.refreshTokenExpiresAt,
      updatedAt: cached.updatedAt,
    };
  }

  /**
   * Attempts to ensure valid Simplifi tokens exist. Used by the OAuth authorization
   * flow so that MFA can be handled interactively in the browser before the MCP
   * client receives its authorization code.
   *
   * Returns { status: "ok" } if tokens are already valid or login succeeded without MFA.
   * Returns { status: "mfa_required", ... } if Simplifi sent a 202 MFA challenge.
   */
  public async attemptLogin(): Promise<AttemptLoginResult> {
    const cached = this.db.getSimplifiTokens();

    if (cached && !isExpired(cached.accessTokenExpiresAt, AUTHORIZATION_SKEW_MS)) {
      return { status: "ok" };
    }

    if (cached?.refreshToken) {
      try {
        const refreshed = await this.refreshToken(cached.refreshToken);
        this.db.saveSimplifiTokens(refreshed);
        return { status: "ok" };
      } catch (error) {
        logWarn("Simplifi token refresh failed during OAuth flow; attempting credential re-login", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const threatMetrixSessionId = this.config.threatMetrixSessionId ?? randomUUID();
    const threatMetrixRequestId = this.config.threatMetrixRequestId ?? null;

    const authorizeResponse = await this.callAuthorize({
      mfaChannel: null,
      mfaCode: null,
      mfaId: null,
      threatMetrixSessionId,
      threatMetrixRequestId,
    });

    if (authorizeResponse.status === 202) {
      const body = (await authorizeResponse.json()) as Record<string, unknown>;
      const mfaId = String(body.mfaId ?? "");
      const mfaChannel = typeof body.mfaChannel === "string" ? body.mfaChannel : "EMAIL";
      const email = typeof body.email === "string" ? body.email : undefined;
      const phone = typeof body.phone === "string" ? body.phone : undefined;

      const pendingId = randomUUID();
      this.pendingMfaMap.set(pendingId, {
        mfaId,
        mfaChannel,
        email,
        phone,
        threatMetrixSessionId,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      return { status: "mfa_required", pendingId, mfaChannel, email, phone };
    }

    const token = await this.processSuccessfulAuthorize(authorizeResponse);
    this.db.saveSimplifiTokens(token);
    logInfo("Simplifi credential login completed");
    return { status: "ok" };
  }

  /**
   * Completes an MFA challenge initiated by attemptLogin(). On success the
   * Simplifi tokens are saved to the database.
   */
  public async completeMfaLogin(pendingId: string, mfaCode: string): Promise<void> {
    const pending = this.pendingMfaMap.get(pendingId);
    if (!pending) {
      throw new Error("MFA session not found or expired. Please restart the authorization flow.");
    }

    if (Date.now() > pending.expiresAt) {
      this.pendingMfaMap.delete(pendingId);
      throw new Error("MFA session expired. Please restart the authorization flow.");
    }

    const authorizeResponse = await this.callAuthorize({
      mfaChannel: pending.mfaChannel,
      mfaCode,
      mfaId: pending.mfaId,
      threatMetrixSessionId: pending.threatMetrixSessionId,
      threatMetrixRequestId: this.config.threatMetrixRequestId ?? null,
    });

    if (![200, 201].includes(authorizeResponse.status)) {
      const body = await authorizeResponse.text();
      throw new Error(`Simplifi MFA verification failed: status=${authorizeResponse.status}, body=${body}`);
    }

    const token = await this.processSuccessfulAuthorize(authorizeResponse);
    this.db.saveSimplifiTokens(token);
    this.pendingMfaMap.delete(pendingId);
    logInfo("Simplifi MFA login completed");
  }

  public getPendingMfaInfo(pendingId: string): Pick<PendingMfa, "mfaChannel" | "email" | "phone"> | undefined {
    const pending = this.pendingMfaMap.get(pendingId);
    if (!pending || Date.now() > pending.expiresAt) {
      return undefined;
    }
    return { mfaChannel: pending.mfaChannel, email: pending.email, phone: pending.phone };
  }

  private async callAuthorize(opts: {
    mfaChannel: string | null;
    mfaCode: string | null;
    mfaId: string | null;
    threatMetrixSessionId: string;
    threatMetrixRequestId: string | null;
  }): Promise<Response> {
    const authorizeUrl = new URL("/oauth/authorize", this.config.baseUrl);

    return this.request(authorizeUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        clientId: this.config.clientId,
        username: this.config.email,
        password: this.config.password,
        redirectUri: this.config.redirectUri,
        responseType: "code",
        mfaChannel: opts.mfaChannel,
        mfaCode: opts.mfaCode,
        mfaId: opts.mfaId,
        threatMetrixRequestId: opts.threatMetrixRequestId,
        threatMetrixSessionId: opts.threatMetrixSessionId,
      }),
      headers: {
        "tm-session-id": opts.threatMetrixSessionId,
      },
    });
  }

  private async processSuccessfulAuthorize(response: Response): Promise<SimplifiTokenSet> {
    // The authorization code can arrive either as a Location header (HTTP
    // redirect) or inside the JSON body's `redirectUri` field (Simplifi returns
    // the code this way on a 200 response). Check both before giving up.
    const candidates: string[] = [];

    const location = response.headers.get("location");
    if (location) {
      candidates.push(location);
    }

    let bodyText = "";
    try {
      bodyText = await response.text();
      const body = JSON.parse(bodyText) as { redirectUri?: unknown };
      if (typeof body.redirectUri === "string") {
        candidates.push(body.redirectUri);
      }
    } catch {
      // non-JSON or empty body — the Location header (if any) is our only source
    }

    for (const candidate of candidates) {
      try {
        const code = new URL(candidate).searchParams.get("code");
        if (code && code !== "null") {
          return this.exchangeAuthorizationCode(code);
        }
      } catch {
        // not a parseable URL — try the next candidate
      }
    }

    throw new Error(
      `Simplifi authorize did not return an authorization code (checked Location header and body redirectUri). body=${bodyText.slice(0, 300)}`,
    );
  }

  private async refreshToken(refreshToken: string): Promise<SimplifiTokenSet> {
    const tokenUrl = new URL("/oauth/token", this.config.baseUrl);

    const response = await this.request(tokenUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        grantType: "refreshToken",
        responseType: "token",
        redirectUri: this.config.redirectUri,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken,
      }),
    });

    if (response.status !== 200) {
      const body = await response.text();
      const message = `Simplifi token refresh failed: status=${response.status}, body=${body}`;
      if (REFRESH_REJECTED_STATUSES.has(response.status)) {
        throw new SimplifiReauthRequiredError(message);
      }
      throw new Error(message);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.parseTokenPayload(payload);
  }

  private async exchangeAuthorizationCode(code: string): Promise<SimplifiTokenSet> {
    const tokenUrl = new URL("/oauth/token", this.config.baseUrl);

    const response = await this.request(tokenUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        grantType: "authorization_code",
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        code,
        redirectUri: this.config.redirectUri,
      }),
    });

    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`Simplifi token exchange failed: status=${response.status}, body=${body}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.parseTokenPayload(payload);
  }

  private parseTokenPayload(payload: Record<string, unknown>): SimplifiTokenSet {
    const accessToken = this.pickString(payload, "accessToken") ?? this.pickString(payload, "access_token");
    const refreshToken = this.pickString(payload, "refreshToken") ?? this.pickString(payload, "refresh_token");

    if (!accessToken || !refreshToken) {
      throw new Error("Simplifi token response did not include access and refresh tokens");
    }

    const accessTokenExpiresAt =
      this.pickString(payload, "accessTokenExpired") ??
      this.calculateExpiryFromSeconds(payload.expires_in) ??
      new Date(Date.now() + 55 * 60 * 1000).toISOString();

    const refreshTokenExpiresAt = this.pickString(payload, "refreshTokenExpired") ?? undefined;

    return {
      accessToken,
      accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  private pickString(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private calculateExpiryFromSeconds(value: unknown): string | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    return new Date(Date.now() + value * 1000).toISOString();
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);

    try {
      return await fetch(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json;charset=UTF-8",
          accept: "application/json, text/plain, */*",
          "app-client-id": this.config.clientId,
          "app-release": "6.5.0",
          "app-build": "63580",
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  public clearTokens(): void {
    this.db.saveSimplifiTokens({
      accessToken: "",
      accessTokenExpiresAt: nowIso(),
      refreshToken: "",
    });
  }
}
