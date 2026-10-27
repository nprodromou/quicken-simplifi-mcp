import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DatabaseContext } from "../src/db/database.js";
import { TransactionToolService } from "../src/services/transaction-tool-service.js";
import type { Transaction } from "../src/types.js";

const ACCOUNT = "acct-1";

function txn(id: string, overrides: Partial<Transaction>): Transaction {
  return {
    id,
    accountId: ACCOUNT,
    payee: `Payee ${id}`,
    amount: -10,
    state: "CLEARED",
    matchState: "NOT_MATCHED",
    type: "CASH_FLOW",
    coa: { type: "CATEGORY", id: "100" },
    ...overrides,
  };
}

// A card account as Simplifi returns it: real activity plus projected bills,
// some dated a year out and one overdue reminder that never matched.
const FIXTURES: Transaction[] = [
  txn("real-latest", { postedOn: "2026-10-25", source: "QCS_REFRESH" }),
  txn("bank-pending", { postedOn: "2026-10-24", source: "QCS_REFRESH_BANK_PENDING", state: "PENDING" }),
  txn("matched-bill", {
    postedOn: "2026-10-15",
    source: "SCHEDULED_TRANSACTION",
    matchState: "AUTO_MATCHED",
    payee: "Streaming Service",
  }),
  txn("real-older", { postedOn: "2026-10-01", source: "CLIENT_AGGREGATED", coa: { type: "UNCATEGORIZED", id: "0" } }),
  txn("no-source", { postedOn: "2026-09-30" }),
  txn("projected-far", {
    postedOn: "2027-11-08",
    source: "SCHEDULED_TRANSACTION_PENDING",
    state: "PENDING",
    payee: "Streaming Service",
  }),
  txn("projected-next", {
    postedOn: "2026-11-15",
    source: "SCHEDULED_TRANSACTION_PENDING",
    state: "PENDING",
    coa: { type: "UNCATEGORIZED", id: "0" },
  }),
  txn("projected-overdue", {
    postedOn: "2026-10-20",
    source: "SCHEDULED_TRANSACTION_PENDING",
    state: "PENDING",
    payee: "Streaming Service",
  }),
];

const PROJECTED_IDS = ["projected-far", "projected-next", "projected-overdue"];

const ids = (items: Transaction[]) => items.map((item) => item.id);

describe("projected transactions", () => {
  let dir: string;
  let db: DatabaseContext;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "simplifi-projected-"));
    db = new DatabaseContext(path.join(dir, "cache.sqlite"), "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=");
    db.upsertTransactions(FIXTURES);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("DatabaseContext", () => {
    it("leaves projected rows out of listTransactions by default", () => {
      const page = db.listTransactions({ accountId: ACCOUNT, limit: 50 });
      assert.deepEqual(ids(page.items), ["real-latest", "bank-pending", "matched-bill", "real-older", "no-source"]);
      assert.equal(page.total, 5);
    });

    it("returns projected rows when includeProjected is true", () => {
      const page = db.listTransactions({ accountId: ACCOUNT, limit: 50, includeProjected: true });
      assert.equal(page.total, FIXTURES.length);
      assert.equal(page.items[0].id, "projected-far");
      for (const id of PROJECTED_IDS) {
        assert.ok(ids(page.items).includes(id), `${id} missing`);
      }
    });

    it("pages over real rows only, so the first page is not all projections", () => {
      const first = db.listTransactions({ accountId: ACCOUNT, limit: 2 });
      assert.deepEqual(ids(first.items), ["real-latest", "bank-pending"]);
      assert.ok(first.nextCursor);
      const second = db.listTransactions({ accountId: ACCOUNT, limit: 2, cursor: first.nextCursor });
      assert.deepEqual(ids(second.items), ["matched-bill", "real-older"]);
    });

    it("filters searchTransactions the same way", () => {
      const page = db.searchTransactions({ searchTerm: "streaming", limit: 50 });
      assert.deepEqual(ids(page.items), ["matched-bill"]);

      const all = db.searchTransactions({ searchTerm: "streaming", limit: 50, includeProjected: true });
      assert.deepEqual(ids(all.items), ["projected-far", "projected-overdue", "matched-bill"]);
    });

    it("filters listUncategorizedTransactions the same way", () => {
      const page = db.listUncategorizedTransactions({ limit: 50 });
      assert.deepEqual(ids(page.items), ["real-older"]);

      const all = db.listUncategorizedTransactions({ limit: 50, includeProjected: true });
      assert.deepEqual(ids(all.items), ["projected-next", "real-older"]);
    });
  });

  describe("TransactionToolService", () => {
    const syncService = { ensureFresh: async () => {}, syncIncremental: async () => {} };
    const service = () => new TransactionToolService(db, syncService as any, {} as any, {} as any, 60_000);

    it("passes includeProjected through from every transaction tool", async () => {
      const listed = (await service().listTransactions({ accountId: ACCOUNT })) as { items: Transaction[] };
      assert.equal(listed.items[0].id, "real-latest");

      const listedAll = (await service().listTransactions({ accountId: ACCOUNT, includeProjected: true })) as {
        total: number;
      };
      assert.equal(listedAll.total, FIXTURES.length);

      const searched = (await service().searchTransactions({ query: "streaming", includeProjected: true })) as {
        total: number;
      };
      assert.equal(searched.total, 3);

      const uncategorized = (await service().listUncategorizedTransactions({ includeProjected: true })) as {
        total: number;
      };
      assert.equal(uncategorized.total, 2);
    });
  });
});
