/**
 * Self-hosted credit ledger + signed credit vouchers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { CreditLedger } from "../../backends/ledger.js";
import { createVoucher, verifyVoucher, importVouchers } from "../../backends/vouchers.js";

function memDb(withInferenceCosts = true): Database.Database {
  const db = new Database(":memory:");
  if (withInferenceCosts) {
    db.exec(`CREATE TABLE inference_costs (id TEXT PRIMARY KEY, cost_cents INTEGER NOT NULL DEFAULT 0)`);
  }
  return db;
}

describe("CreditLedger", () => {
  it("balance is credited minus recorded inference spend", () => {
    const db = memDb();
    const ledger = new CreditLedger(db);
    ledger.record({ kind: "fund", deltaCents: 500 });
    db.prepare("INSERT INTO inference_costs (id, cost_cents) VALUES ('a', 120), ('b', 30)").run();
    expect(ledger.getCreditedCents()).toBe(500);
    expect(ledger.getSpentCents()).toBe(150);
    expect(ledger.getBalanceCents()).toBe(350);
  });

  it("works before the inference_costs table exists", () => {
    const ledger = new CreditLedger(memDb(false));
    ledger.record({ kind: "fund", deltaCents: 100 });
    expect(ledger.getBalanceCents()).toBe(100);
  });

  it("rejects non-integer, zero and wrongly-signed entries", () => {
    const ledger = new CreditLedger(memDb());
    expect(() => ledger.record({ kind: "fund", deltaCents: 0 })).toThrow();
    expect(() => ledger.record({ kind: "fund", deltaCents: 1.5 })).toThrow();
    expect(() => ledger.record({ kind: "fund", deltaCents: -5 })).toThrow();
    expect(() => ledger.record({ kind: "transfer_out", deltaCents: 5 })).toThrow();
    expect(() => ledger.record({ kind: "mint" as any, deltaCents: 5 })).toThrow();
  });

  it("debitTransfer refuses to overdraw and reports 402", () => {
    const ledger = new CreditLedger(memDb());
    ledger.record({ kind: "fund", deltaCents: 100 });
    try {
      ledger.debitTransfer(101, "0xabc");
      expect.unreachable();
    } catch (err: any) {
      expect(err.status).toBe(402);
    }
    expect(ledger.getBalanceCents()).toBe(100);
    const { balanceAfterCents } = ledger.debitTransfer(40, "0xabc");
    expect(balanceAfterCents).toBe(60);
    expect(ledger.getBalanceCents()).toBe(60);
  });

  it("fundDatabase funds a state.db on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
    const dbPath = path.join(dir, "state.db");
    try {
      const { balanceCents } = CreditLedger.fundDatabase(dbPath, 250, "test");
      expect(balanceCents).toBe(250);
      const db = new Database(dbPath);
      expect(new CreditLedger(db).getBalanceCents()).toBe(250);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("credit vouchers", () => {
  const parent = privateKeyToAccount(generatePrivateKey());
  const child = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vouchers-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("verifies a voucher from an allowed signer to the right recipient", async () => {
    const v = await createVoucher(parent, { to: child.address, amountCents: 300 });
    expect(await verifyVoucher(v, child.address, [parent.address])).toEqual({ ok: true });
  });

  it("rejects strangers, wrong recipients and tampered amounts", async () => {
    const fromStranger = await createVoucher(stranger, { to: child.address, amountCents: 300 });
    expect((await verifyVoucher(fromStranger, child.address, [parent.address])).ok).toBe(false);

    const toSomeoneElse = await createVoucher(parent, { to: stranger.address, amountCents: 300 });
    expect((await verifyVoucher(toSomeoneElse, child.address, [parent.address])).ok).toBe(false);

    const tampered = await createVoucher(parent, { to: child.address, amountCents: 300 });
    tampered.payload.amountCents = 300_000;
    expect(await verifyVoucher(tampered, child.address, [parent.address])).toEqual({
      ok: false,
      reason: "bad signature",
    });

    // A child forging a voucher signed by itself but claiming the parent as sender
    const forged = await createVoucher(child, { to: child.address, amountCents: 999 });
    forged.payload.from = parent.address;
    expect((await verifyVoucher(forged, child.address, [parent.address])).ok).toBe(false);
  });

  it("imports valid vouchers once and quarantines the rest", async () => {
    const ledger = new CreditLedger(memDb());
    const good = await createVoucher(parent, { to: child.address, amountCents: 300, note: "allowance" });
    const bad = await createVoucher(stranger, { to: child.address, amountCents: 5000 });
    fs.writeFileSync(path.join(dir, "good.json"), JSON.stringify(good));
    fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify(bad));
    fs.writeFileSync(path.join(dir, "junk.json"), "{not json");

    const res = await importVouchers(dir, ledger, child.address, [parent.address]);
    expect(res.imported).toBe(1);
    expect(res.rejected.map((r) => r.file).sort()).toEqual(["bad.json", "junk.json"]);
    expect(ledger.getBalanceCents()).toBe(300);
    expect(fs.existsSync(path.join(dir, "processed", "good.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "rejected", "bad.json"))).toBe(true);

    // Replay: the same voucher dropped in again must not double-credit
    fs.writeFileSync(path.join(dir, "replay.json"), JSON.stringify(good));
    const again = await importVouchers(dir, ledger, child.address, [parent.address]);
    expect(again.imported).toBe(0);
    expect(again.rejected[0]?.reason).toMatch(/already imported/);
    expect(ledger.getBalanceCents()).toBe(300);
  });
});
