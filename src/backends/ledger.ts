/**
 * Local Credit Ledger (self-hosted backend)
 *
 * Replaces Conway's hosted credit balance when the automaton runs without a
 * Conway account. Credits keep their original meaning — the budget the agent
 * may burn on compute before it dies — but are accounted for locally:
 *
 *   balance = SUM(credit_ledger.delta_cents) − SUM(inference_costs.cost_cents)
 *
 * Inference spend is not duplicated into the ledger: the inference router
 * already records every call's cost in `inference_costs`, so the ledger reads
 * it from there and stays consistent with the observability data.
 *
 * Credits enter via `fund` (the creator, through the CLI), `genesis` (initial
 * budget a parent hands a child) and `transfer_in`; they leave via
 * `transfer_out`. The table lives in state.db, which the agent's own file and
 * shell tools are not allowed to modify.
 *
 * Note: in self-hosted mode credits are an accounting budget, not money held
 * by a third party. The actual bills for BYOK inference go to whoever owns
 * the API keys.
 */

import Database from "better-sqlite3";
import { ulid } from "ulid";

export type LedgerEntryKind =
  | "fund"
  | "genesis"
  | "transfer_in"
  | "transfer_out"
  | "adjustment";

export interface LedgerEntry {
  id: string;
  kind: LedgerEntryKind;
  deltaCents: number;
  counterparty: string | null;
  note: string | null;
  createdAt: string;
}

const KINDS: readonly LedgerEntryKind[] = [
  "fund",
  "genesis",
  "transfer_in",
  "transfer_out",
  "adjustment",
];

export class CreditLedger {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('fund','genesis','transfer_in','transfer_out','adjustment')),
        delta_cents INTEGER NOT NULL,
        counterparty TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  /** Sum of all ledger entries, before inference spend. */
  getCreditedCents(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(delta_cents), 0) AS total FROM credit_ledger")
      .get() as { total: number };
    return row.total;
  }

  /** Total inference spend recorded by the router (0 if the table does not exist yet). */
  getSpentCents(): number {
    const exists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inference_costs'")
      .get();
    if (!exists) return 0;
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_cents), 0) AS total FROM inference_costs")
      .get() as { total: number };
    return row.total;
  }

  /** Spendable balance in cents. Can go negative if spend outran the budget. */
  getBalanceCents(): number {
    return this.getCreditedCents() - this.getSpentCents();
  }

  /** True once any credit has ever been recorded (used for one-time genesis funding). */
  hasEntries(): boolean {
    return !!this.db.prepare("SELECT 1 FROM credit_ledger LIMIT 1").get();
  }

  hasEntry(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM credit_ledger WHERE id = ?").get(id);
  }

  record(params: {
    /** Explicit id (e.g. a voucher id, to make imports idempotent). Defaults to a new ULID. */
    id?: string;
    kind: LedgerEntryKind;
    deltaCents: number;
    counterparty?: string;
    note?: string;
  }): LedgerEntry {
    if (!KINDS.includes(params.kind)) {
      throw new Error(`Invalid ledger entry kind: ${params.kind}`);
    }
    if (!Number.isSafeInteger(params.deltaCents) || params.deltaCents === 0) {
      throw new Error(`Ledger delta must be a non-zero integer number of cents, got ${params.deltaCents}`);
    }
    const isCredit = params.kind === "fund" || params.kind === "genesis" || params.kind === "transfer_in";
    if (isCredit && params.deltaCents < 0) {
      throw new Error(`Ledger entry of kind "${params.kind}" must be positive`);
    }
    if (params.kind === "transfer_out" && params.deltaCents > 0) {
      throw new Error(`Ledger entry of kind "transfer_out" must be negative`);
    }

    const entry: LedgerEntry = {
      id: params.id ?? ulid(),
      kind: params.kind,
      deltaCents: params.deltaCents,
      counterparty: params.counterparty ?? null,
      note: params.note ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO credit_ledger (id, kind, delta_cents, counterparty, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(entry.id, entry.kind, entry.deltaCents, entry.counterparty, entry.note, entry.createdAt);
    return entry;
  }

  /**
   * Debit a transfer atomically: the balance check and the debit run in one
   * SQLite transaction so concurrent transfers cannot both pass the check.
   */
  debitTransfer(amountCents: number, toAddress: string, note?: string): { entry: LedgerEntry; balanceAfterCents: number } {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error(`Transfer amount must be a positive integer number of cents, got ${amountCents}`);
    }
    const tx = this.db.transaction(() => {
      const balance = this.getBalanceCents();
      if (amountCents > balance) {
        const err: any = new Error(
          `Insufficient credits: balance ${balance} cents, requested ${amountCents} cents`,
        );
        err.status = 402;
        throw err;
      }
      const entry = this.record({
        kind: "transfer_out",
        deltaCents: -amountCents,
        counterparty: toAddress,
        note,
      });
      return { entry, balanceAfterCents: balance - amountCents };
    });
    return tx();
  }

  /**
   * Creator funding from the host (automaton-cli fund). Opens state.db
   * directly; WAL mode lets this run while the automaton is up.
   */
  static fundDatabase(dbPath: string, amountCents: number, note?: string): { entry: LedgerEntry; balanceCents: number } {
    const db = new Database(dbPath);
    try {
      db.pragma("busy_timeout = 5000");
      const ledger = new CreditLedger(db);
      const entry = ledger.record({ kind: "fund", deltaCents: amountCents, note: note ?? "creator funding" });
      return { entry, balanceCents: ledger.getBalanceCents() };
    } finally {
      db.close();
    }
  }

  listEntries(limit = 50): LedgerEntry[] {
    const rows = this.db
      .prepare(
        "SELECT id, kind, delta_cents, counterparty, note, created_at FROM credit_ledger ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(limit) as Array<{
        id: string;
        kind: LedgerEntryKind;
        delta_cents: number;
        counterparty: string | null;
        note: string | null;
        created_at: string;
      }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      deltaCents: r.delta_cents,
      counterparty: r.counterparty,
      note: r.note,
      createdAt: r.created_at,
    }));
  }
}
