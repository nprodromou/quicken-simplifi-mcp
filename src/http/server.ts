import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { SEED_CLIENT_ID, seedRedirectUri, type AppConfig } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import { createMcpServer } from "../mcp/server.js";
import { OAuthService } from "../oauth/oauth-service.js";
import { SimplifiAuthService } from "../simplifi/auth-service.js";
import { StatusService } from "../services/status-service.js";
import { TransactionToolService } from "../services/transaction-tool-service.js";

interface HttpServerDeps {
  config: AppConfig;
  oauthService: OAuthService;
  simplifiAuthService: SimplifiAuthService;
  toolService: TransactionToolService;
  statusService: StatusService;
}

const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const SESSION_SWEEP_MS = 60 * 60 * 1000;

// Compares digests so the check takes the same time whatever the token's length.
function matchesStaticKey(token: string, key: string): boolean {
  const presented = createHash("sha256").update(token).digest();
  const expected = createHash("sha256").update(key).digest();
  return timingSafeEqual(presented, expected);
}

export interface RunningHttpServer {
  close: () => Promise<void>;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function readBearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) {
    return null;
  }

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export async function startHttpServer(deps: HttpServerDeps): Promise<RunningHttpServer> {
  const { config, oauthService, simplifiAuthService, toolService, statusService } = deps;

  const app = express();
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const sessionLastSeen = new Map<string, number>();

  // A client that exits without sending DELETE (killed, crashed, laptop shut)
  // leaves its session here. Without a sweep they accumulate until the process
  // restarts; with it, the map holds at most the sessions used in the last day.
  const sessionSweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, lastSeen] of sessionLastSeen) {
      if (lastSeen < cutoff) {
        const idle = sessions.get(id);
        sessions.delete(id);
        sessionLastSeen.delete(id);
        void idle?.close();
      }
    }
  }, SESSION_SWEEP_MS);
  sessionSweep.unref();

  app.disable("x-powered-by");
  app.use(
    cors({
      origin: config.server.corsOrigin === "*" ? true : config.server.corsOrigin,
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.status(200).json(oauthService.getMetadata(config.server.publicBaseUrl));
  });

  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.status(200).json(oauthService.getMetadata(config.server.publicBaseUrl));
  });

  app.get("/oauth/authorize", (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.query));
      res.status(200).type("html").send(oauthService.buildAuthorizePage(request));
    } catch (error) {
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid authorize request");
    }
  });

  app.post("/oauth/register", (req, res) => {
    const response = oauthService.buildClientRegistrationResponse(toRecord(req.body), config.server.publicBaseUrl);
    res.status(201).json(response);
  });

  app.post("/oauth/authorize", async (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.body));
      const username = typeof req.body.username === "string" ? req.body.username : "";
      const password = typeof req.body.password === "string" ? req.body.password : "";

      if (!oauthService.validateLogin(username, password)) {
        res.status(401).type("html").send(oauthService.buildAuthorizePage(request, "Invalid credentials"));
        return;
      }

      const result = await simplifiAuthService.attemptLogin();

      if (result.status === "mfa_required") {
        res
          .status(200)
          .type("html")
          .send(oauthService.buildMfaPage(request, result.pendingId, result));
        return;
      }

      const code = oauthService.issueAuthorizationCode(request);
      const redirect = oauthService.buildAuthorizeRedirect(request, code);
      res.redirect(302, redirect);
    } catch (error) {
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid authorize request");
    }
  });

  app.post("/oauth/mfa", async (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.body));
      const pendingId = typeof req.body.pending_mfa_id === "string" ? req.body.pending_mfa_id : "";
      const mfaCode = typeof req.body.mfa_code === "string" ? req.body.mfa_code.trim() : "";

      if (!pendingId || !mfaCode) {
        res.status(400).type("text/plain").send("Missing pending_mfa_id or mfa_code");
        return;
      }

      try {
        await simplifiAuthService.completeMfaLogin(pendingId, mfaCode);
      } catch (mfaError) {
        const mfaInfo = simplifiAuthService.getPendingMfaInfo(pendingId) ?? {
          mfaChannel: "EMAIL",
        };
        res
          .status(200)
          .type("html")
          .send(
            oauthService.buildMfaPage(
              request,
              pendingId,
              mfaInfo,
              mfaError instanceof Error ? mfaError.message : "Verification failed. Please try again.",
            ),
          );
        return;
      }

      const code = oauthService.issueAuthorizationCode(request);
      const redirect = oauthService.buildAuthorizeRedirect(request, code);
      res.redirect(302, redirect);
    } catch (error) {
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid MFA request");
    }
  });

  // Seeding the Simplifi login on a headless deployment. MFA can only be answered
  // in a browser, so this sends the operator through the same authorize page an
  // OAuth client would use, with a redirect back here instead of to a client.
  // The authorization code it issues is never exchanged and expires in 5 minutes.
  app.get("/seed", (_req, res) => {
    const authorize = new URL("/oauth/authorize", config.server.publicBaseUrl);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", SEED_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", seedRedirectUri(config.server.publicBaseUrl));
    res.redirect(302, authorize.pathname + authorize.search);
  });

  app.get("/seed/done", (_req, res) => {
    const authorized = simplifiAuthService.getAuthStatus().authorized;
    const message = authorized
      ? "Simplifi is authorized. The next background sync (within a minute) picks it up."
      : "Simplifi is still not authorized. Start again from /seed.";
    res
      .status(authorized ? 200 : 409)
      .type("html")
      .send(`<!doctype html><title>Simplifi MCP</title><p>${message}</p>`);
  });

  app.post("/oauth/token", (req, res) => {
    try {
      const payload = oauthService.exchangeToken(toRecord(req.body));
      res.status(200).json(payload);
    } catch (error) {
      res.status(400).json({
        error: "invalid_request",
        error_description: error instanceof Error ? error.message : "Token request failed",
      });
    }
  });

  const requireAccessToken = (req: Request, res: Response, next: NextFunction): void => {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "invalid_token", error_description: "Missing bearer token" });
      return;
    }

    if (config.server.mcpApiKey && matchesStaticKey(token, config.server.mcpApiKey)) {
      next();
      return;
    }

    try {
      oauthService.verifyAccessToken(token);
      next();
    } catch (error) {
      res.status(401).json({
        error: "invalid_token",
        error_description: error instanceof Error ? error.message : "Token verification failed",
      });
    }
  };

  // Handle all MCP requests (GET for SSE, POST for JSON-RPC, DELETE for session close).
  // A new McpServer+transport pair is created per session; the transport itself validates
  // session IDs and whether the first request is an initialize — no manual pre-checks needed.
  app.all("/mcp", requireAccessToken, async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    // An unknown session (swept, or lost to a restart) gets 404, which the MCP
    // spec tells clients to answer by initializing a new session. Handing it to
    // a fresh transport instead would return 400 "not initialized", which they
    // treat as fatal.
    if (sessionId && !transport) {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      return;
    }

    if (sessionId) {
      sessionLastSeen.set(sessionId, Date.now());
    }

    try {
      if (!transport) {
        const mcpServer = createMcpServer(toolService, statusService);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            sessions.set(newSessionId, transport!);
            sessionLastSeen.set(newSessionId, Date.now());
          },
        });

        transport.onclose = () => {
          if (transport!.sessionId) {
            sessions.delete(transport!.sessionId);
            sessionLastSeen.delete(transport!.sessionId);
          }
        };

        await mcpServer.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logWarn("Error handling /mcp request", {
        error: error instanceof Error ? error.message : String(error),
        method: req.method,
      });

      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", error_description: "Failed to handle MCP request" });
      }
    }
  });

  app.get("/", (_req, res) => {
    res.status(200).json({
      name: "quicken-simplifi-mcp",
      status: "ok",
      mcp: `${config.server.publicBaseUrl}/mcp`,
      oauthAuthorize: `${config.server.publicBaseUrl}/oauth/authorize`,
      oauthToken: `${config.server.publicBaseUrl}/oauth/token`,
    });
  });

  const server = app.listen(config.server.port, config.server.host);
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });

  const address = server.address() as AddressInfo;
  logInfo("HTTP server started", {
    host: address.address,
    port: address.port,
  });

  return {
    close: async () => {
      clearInterval(sessionSweep);
      for (const [sessionId] of sessions.entries()) {
        sessions.delete(sessionId);
      }
      sessionLastSeen.clear();

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
