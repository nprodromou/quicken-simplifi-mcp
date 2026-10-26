import { DatabaseContext } from "../db/database.js";
import { SimplifiAuthService } from "../simplifi/auth-service.js";
import { nowIso } from "../utils.js";

/**
 * Read-only health of the Simplifi link: whether a refresh token is held and how
 * the sync loop is doing. It never calls Simplifi, so asking cannot trigger a
 * login or a sync. Liveness checks use it to tell a healthy, idle server from one
 * that has lost its authorization and is quietly syncing nothing.
 */
export class StatusService {
  public constructor(
    private readonly db: DatabaseContext,
    private readonly authService: SimplifiAuthService,
    private readonly publicBaseUrl: string,
  ) {}

  public getStatus(): Record<string, unknown> {
    const auth = this.authService.getAuthStatus();
    const sync = this.db.getSyncState();

    return {
      authorization: auth.authorized ? "authorized" : "awaiting_authorization",
      ...(auth.authorized ? {} : { authorizeUrl: new URL("/seed", this.publicBaseUrl).toString() }),
      tokens: {
        accessTokenExpiresAt: auth.accessTokenExpiresAt,
        refreshTokenExpiresAt: auth.refreshTokenExpiresAt,
        updatedAt: auth.updatedAt,
      },
      sync: {
        status: sync.syncStatus,
        lastSyncAt: sync.lastSyncAt,
        lastFullSyncAt: sync.lastFullSyncAt,
        lastAsOf: sync.lastAsOf,
        lastError: sync.lastError,
      },
      cachedTransactions: this.db.countTransactions(),
      checkedAt: nowIso(),
    };
  }
}
