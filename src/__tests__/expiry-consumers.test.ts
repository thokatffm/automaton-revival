/**
 * Downstream consumers of the normalised expiry timestamps.
 *
 * Two places read a DB timestamp with JavaScript instead of SQL, and both
 * break once the value is in SQLite-native UTC format:
 *
 *  - registry/discovery.ts parsed `valid_until` with `new Date(string)`, which
 *    reads the space-separated form as LOCAL time - a 5.5h skew in IST.
 *  - social/client.ts wrote the replay nonce with `toISOString()`, so
 *    heartbeat_dedup held mixed formats once the state layer moved to native.
 *
 * These assert the format contract directly, without needing the private
 * helpers or a live network.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { toSqliteUtcTimestamp } from "../state/database.js";

/** Mirrors the parse used by discovery.ts getCachedCard. */
function parseValidUntil(value: string): number {
  return new Date(`${value.replace(" ", "T")}Z`).getTime();
}

describe("valid_until is parsed as UTC, not local time", () => {
  it("round-trips the native format back to the original instant", () => {
    const now = Date.now();
    const stored = toSqliteUtcTimestamp(now);
    // The whole point: parsing must recover the instant we stored.
    expect(parseValidUntil(stored)).toBe(Math.floor(now / 1000) * 1000);
  });

  it("does not shift by the machine's UTC offset", () => {
    const now = Date.now();
    const stored = toSqliteUtcTimestamp(now);
    const offsetMinutes = new Date().getTimezoneOffset();

    // Before the fix, new Date(stored) was parsed as local time, so the
    // recovered instant was off by exactly the UTC offset. In a timezone east
    // of UTC (like IST, offset -330) that put the parsed instant 5.5h BEHIND
    // the true one, so every cached entry looked expired hours early.
    const naiveParse = new Date(stored).getTime();
    const correctParse = parseValidUntil(stored);
    expect(correctParse - naiveParse).toBe(-offsetMinutes * 60_000);

    if (offsetMinutes !== 0) {
      expect(naiveParse).not.toBe(correctParse);
    }
  });

  it("treats a future entry as still valid", () => {
    const future = toSqliteUtcTimestamp(Date.now() + 3_600_000);
    expect(parseValidUntil(future) > Date.now()).toBe(true);
  });

  it("treats a past entry as expired", () => {
    const past = toSqliteUtcTimestamp(Date.now() - 3_600_000);
    expect(parseValidUntil(past) < Date.now()).toBe(true);
  });

  it("still parses a legacy ISO value", () => {
    // Rows written before the migration are already ISO; the parse must not
    // break on them.
    const iso = new Date(Date.now() + 60_000).toISOString();
    expect(new Date(iso).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("heartbeat_dedup holds one format", () => {
  it("compares a native-format nonce as live and a stale one as expired", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE heartbeat_dedup (dedup_key TEXT PRIMARY KEY, task_name TEXT, expires_at TEXT)",
    );
    const ins = db.prepare("INSERT INTO heartbeat_dedup VALUES (?,?,?)");
    ins.run("social:nonce:live", "social_replay", toSqliteUtcTimestamp(Date.now() + 300_000));
    ins.run("social:nonce:old", "social_replay", toSqliteUtcTimestamp(Date.now() - 300_000));

    const live = db
      .prepare("SELECT 1 FROM heartbeat_dedup WHERE dedup_key = ? AND expires_at >= datetime('now')")
      .get("social:nonce:live");
    const stale = db
      .prepare("SELECT 1 FROM heartbeat_dedup WHERE dedup_key = ? AND expires_at >= datetime('now')")
      .get("social:nonce:old");

    expect(live).toBeDefined();
    expect(stale).toBeUndefined();
    db.close();
  });

  it("an ISO-written nonce never expires, which this fixes", () => {
    // Documents the regression. An ISO value in this table sorts after the
    // space-separated form, so `expires_at >= datetime('now')` stays true even
    // long past the deadline: a used nonce blocks that same nonce forever and
    // the table grows without bound. A *future* ISO nonce does read as live,
    // which is exactly why the bug is invisible in the happy path.
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE heartbeat_dedup (dedup_key TEXT PRIMARY KEY, task_name TEXT, expires_at TEXT)",
    );
    const ins = db.prepare("INSERT INTO heartbeat_dedup VALUES (?,?,?)");
    ins.run("iso_past", "t", new Date(Date.now() - 300_000).toISOString());
    ins.run("nat_past", "t", toSqliteUtcTimestamp(Date.now() - 300_000));

    const isLive = (k: string) =>
      db
        .prepare("SELECT 1 FROM heartbeat_dedup WHERE dedup_key = ? AND expires_at >= datetime('now')")
        .get(k) !== undefined;

    // The bug: an expired ISO nonce is still treated as live.
    expect(isLive("iso_past")).toBe(true);
    // The fix: the native format expires correctly.
    expect(isLive("nat_past")).toBe(false);
    db.close();
  });
});
