/**
 * Expiry Timestamp Format Tests
 *
 * Regression coverage for the ISO-8601-vs-SQLite-native mismatch.
 *
 * Expiry columns are compared against `datetime('now')`, which yields
 * `YYYY-MM-DD HH:MM:SS`. Writers that stored `Date.prototype.toISOString()`
 * values (`YYYY-MM-DDTHH:MM:SS.mmmZ`) produced TEXT that compares
 * *lexicographically* against that, and 'T' sorts after ' ' — so an expired
 * row still read as live. Each test below asserts the *observable* behaviour
 * (a lease is reclaimable, a dedup key expires, a cache entry goes stale)
 * rather than the storage format, so the tests stay honest if the encoding
 * changes again.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createDatabase } from "../state/database.js";
import {
  acquireTaskLease,
  releaseTaskLease,
  clearExpiredLeases,
  insertDedupKey,
  isDeduplicated,
  pruneExpiredDedupKeys,
  wmClearExpired,
  toSqliteUtcTimestamp,
} from "../state/database.js";
import { MIGRATION_V12_NORMALISE_EXPIRY_TIMESTAMPS } from "../state/schema.js";

let tmpDir: string;
let dbPath: string;

function makeDbPath(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-expiry-test-"));
  return path.join(tmpDir, "test.db");
}

/** Insert a heartbeat_schedule row directly, bypassing the lease helper. */
function seedLeaseRow(
  db: ReturnType<typeof createDatabase>,
  taskName: string,
  owner: string | null,
  expiresAt: string | null,
): void {
  (db as any).raw
    .prepare(
      `INSERT OR REPLACE INTO heartbeat_schedule
         (task_name, cron_expression, lease_owner, lease_expires_at)
       VALUES (?, '* * * * *', ?, ?)`,
    )
    .run(taskName, owner, expiresAt);
}

describe("expiry timestamp format", () => {
  beforeEach(() => {
    dbPath = makeDbPath();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  // ─── Format helper ──────────────────────────────────────────────

  describe("toSqliteUtcTimestamp", () => {
    it("emits the same shape as datetime('now')", () => {
      const formatted = toSqliteUtcTimestamp(Date.now());
      expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("sorts correctly against datetime('now') in SQLite", () => {
      const db = createDatabase(dbPath);
      const nowSqlite = db.raw.prepare("SELECT datetime('now') AS v").get() as { v: string };
      // A past instant must compare as LESS THAN the current time.
      const past = toSqliteUtcTimestamp(Date.now() - 60_000);
      const future = toSqliteUtcTimestamp(Date.now() + 60_000);
      expect(past < nowSqlite.v).toBe(true);
      expect(future < nowSqlite.v).toBe(false);
    });

    it("preserves the instant (no timezone shift)", () => {
      const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
      expect(toSqliteUtcTimestamp(ms)).toBe("2026-01-02 03:04:05");
    });
  });

  // ─── Heartbeat leases ──────────────────────────────────────────

  describe("acquireTaskLease", () => {
    it("writes an expiry that compares correctly against datetime('now')", () => {
      const db = createDatabase(dbPath);
      seedLeaseRow(db, "task-a", null, null);

      const acquired = acquireTaskLease(db.raw, "task-a", "owner-1", 60_000);
      expect(acquired).toBe(true);

      const row = db.raw
        .prepare("SELECT lease_expires_at FROM heartbeat_schedule WHERE task_name = ?")
        .get("task-a") as { lease_expires_at: string };
      expect(row.lease_expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("cannot double-lease while the lease is live", () => {
      const db = createDatabase(dbPath);
      seedLeaseRow(db, "task-a", null, null);

      expect(acquireTaskLease(db.raw, "task-a", "owner-1", 60_000)).toBe(true);
      expect(acquireTaskLease(db.raw, "task-a", "owner-2", 60_000)).toBe(false);
    });

    it("reclaims a lease whose TTL has already elapsed", () => {
      const db = createDatabase(dbPath);
      // Seed an ISO-formatted lease that expired a minute ago, exactly as an
      // older build would have persisted it.
      seedLeaseRow(db, "task-a", "dead-owner", new Date(Date.now() - 60_000).toISOString());

      const acquired = acquireTaskLease(db.raw, "task-a", "new-owner", 60_000);
      expect(acquired).toBe(true);

      const row = db.raw
        .prepare("SELECT lease_owner FROM heartbeat_schedule WHERE task_name = ?")
        .get("task-a") as { lease_owner: string };
      expect(row.lease_owner).toBe("new-owner");
    });

    it("reclaims a lease expired in the SQLite-native format", () => {
      const db = createDatabase(dbPath);
      seedLeaseRow(db, "task-a", "dead-owner", toSqliteUtcTimestamp(Date.now() - 60_000));

      expect(acquireTaskLease(db.raw, "task-a", "new-owner", 60_000)).toBe(true);
    });

    it("does not reclaim a lease that is still live", () => {
      const db = createDatabase(dbPath);
      seedLeaseRow(db, "task-a", "live-owner", toSqliteUtcTimestamp(Date.now() + 60_000));

      expect(acquireTaskLease(db.raw, "task-a", "new-owner", 60_000)).toBe(false);
    });

    it("releaseTaskLease frees the lease for the next owner", () => {
      const db = createDatabase(dbPath);
      seedLeaseRow(db, "task-a", null, null);

      acquireTaskLease(db.raw, "task-a", "owner-1", 60_000);
      releaseTaskLease(db.raw, "task-a", "owner-1");
      expect(acquireTaskLease(db.raw, "task-a", "owner-2", 60_000)).toBe(true);
    });

    it("releaseTaskLease does not free another owner's lease", () => {
      const db = createDatabase(dbPath);
      seedLeaseRow(db, "task-a", null, null);

      acquireTaskLease(db.raw, "task-a", "owner-1", 60_000);
      releaseTaskLease(db.raw, "task-a", "impostor");
      expect(acquireTaskLease(db.raw, "task-a", "owner-2", 60_000)).toBe(false);
    });
  });

  // ─── clearExpiredLeases ────────────────────────────────────────

  describe("clearExpiredLeases", () => {
    it("clears an expired lease written in ISO format", () => {
      const db = createDatabase(dbPath);
      seedLeaseRow(db, "task-a", "dead", new Date(Date.now() - 60_000).toISOString());

      expect(clearExpiredLeases(db.raw)).toBe(1);
      const row = db.raw
        .prepare("SELECT lease_owner FROM heartbeat_schedule WHERE task_name = ?")
        .get("task-a") as { lease_owner: string | null };
      expect(row.lease_owner).toBeNull();
    });

    it("leaves a live lease intact", () => {
      const db = createDatabase(dbPath);
      seedLeaseRow(db, "task-a", "alive", toSqliteUtcTimestamp(Date.now() + 60_000));

      expect(clearExpiredLeases(db.raw)).toBe(0);
      const row = db.raw
        .prepare("SELECT lease_owner FROM heartbeat_schedule WHERE task_name = ?")
        .get("task-a") as { lease_owner: string };
      expect(row.lease_owner).toBe("alive");
    });
  });

  // ─── Dedup keys ────────────────────────────────────────────────

  describe("dedup key expiry", () => {
    it("treats a key as active before its TTL", () => {
      const db = createDatabase(dbPath);
      expect(insertDedupKey(db.raw, "k1", "task", 60_000)).toBe(true);
      expect(isDeduplicated(db.raw, "k1")).toBe(true);
    });

    it("stops treating an elapsed key as active", () => {
      const db = createDatabase(dbPath);
      // Insert with a TTL that has already passed.
      expect(insertDedupKey(db.raw, "k1", "task", -60_000)).toBe(true);
      expect(isDeduplicated(db.raw, "k1")).toBe(false);
    });

    it("rejects a duplicate insert of a live key", () => {
      const db = createDatabase(dbPath);
      expect(insertDedupKey(db.raw, "k1", "task", 60_000)).toBe(true);
      expect(insertDedupKey(db.raw, "k1", "task", 60_000)).toBe(false);
    });

    it("prunes keys whose TTL has elapsed", () => {
      const db = createDatabase(dbPath);
      insertDedupKey(db.raw, "expired", "task", -60_000);
      insertDedupKey(db.raw, "live", "task", 60_000);

      expect(pruneExpiredDedupKeys(db.raw)).toBe(1);
      expect(isDeduplicated(db.raw, "expired")).toBe(false);
      expect(isDeduplicated(db.raw, "live")).toBe(true);
    });

    it("reads a legacy ISO-formatted key correctly even before migration", () => {
      const db = createDatabase(dbPath);
      // Simulate a row persisted by an older build, already expired.
      db.raw
        .prepare(
          "INSERT INTO heartbeat_dedup (dedup_key, task_name, expires_at) VALUES (?, ?, ?)",
        )
        .run("legacy", "task", new Date(Date.now() - 60_000).toISOString());

      // isDeduplicated normalises through datetime(), so this is correct
      // regardless of the stored format.
      expect(isDeduplicated(db.raw, "legacy")).toBe(false);
    });

    it("pruneExpiredDedupKeys relies on the native format (migration-owned)", () => {
      const db = createDatabase(dbPath);
      // A legacy ISO row is repaired by MIGRATION_V12, not by this scan: the
      // prune must stay a plain comparison to keep using idx_dedup_expires.
      db.raw
        .prepare(
          "INSERT INTO heartbeat_dedup (dedup_key, task_name, expires_at) VALUES (?, ?, ?)",
        )
        .run("legacy", "task", new Date(Date.now() - 60_000).toISOString());
      insertDedupKey(db.raw, "live", "task", 60_000);

      expect(pruneExpiredDedupKeys(db.raw)).toBe(0);
      expect(isDeduplicated(db.raw, "legacy")).toBe(false);
      expect(isDeduplicated(db.raw, "live")).toBe(true);
    });
  });

  // ─── Working memory TTL ────────────────────────────────────────

  describe("wmClearExpired", () => {
    it("evicts working memory whose TTL has elapsed", () => {
      const db = createDatabase(dbPath);
      db.raw
        .prepare(
          `INSERT INTO working_memory (id, session_id, content, content_type, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("wm1", "s1", "stale note", "note", toSqliteUtcTimestamp(Date.now() - 60_000));

      expect(wmClearExpired(db.raw)).toBe(1);
      const row = db.raw
        .prepare("SELECT COUNT(*) AS c FROM working_memory WHERE id = ?")
        .get("wm1") as { c: number };
      expect(row.c).toBe(0);
    });

    it("keeps working memory whose TTL has not elapsed", () => {
      const db = createDatabase(dbPath);
      db.raw
        .prepare(
          `INSERT INTO working_memory (id, session_id, content, content_type, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("wm1", "s1", "fresh note", "note", toSqliteUtcTimestamp(Date.now() + 60_000));

      expect(wmClearExpired(db.raw)).toBe(0);
      const row = db.raw
        .prepare("SELECT COUNT(*) AS c FROM working_memory WHERE id = ?")
        .get("wm1") as { c: number };
      expect(row.c).toBe(1);
    });

    it("evicts a legacy ISO-formatted expiry", () => {
      const db = createDatabase(dbPath);
      db.raw
        .prepare(
          `INSERT INTO working_memory (id, session_id, content, content_type, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("wm1", "s1", "legacy stale", "note", new Date(Date.now() - 60_000).toISOString());

      expect(wmClearExpired(db.raw)).toBe(1);
    });
  });

  // ─── Migration ─────────────────────────────────────────────────

  describe("MIGRATION_V12 expiry normalisation", () => {
    it("rewrites pre-existing ISO timestamps on startup", () => {
      // Build a database at the old schema version, seed ISO timestamps,
      // then reopen it so the migration runs against real persisted data.
      const legacyPath = makeDbPath();
      const legacy = createDatabase(legacyPath);

      legacy.raw
        .prepare(
          "INSERT INTO heartbeat_dedup (dedup_key, task_name, expires_at) VALUES (?, ?, ?)",
        )
        .run("legacy-expired", "task", new Date(Date.now() - 60_000).toISOString());
      legacy.raw
        .prepare(
          "INSERT INTO heartbeat_dedup (dedup_key, task_name, expires_at) VALUES (?, ?, ?)",
        )
        .run("legacy-fresh", "task", new Date(Date.now() + 60_000).toISOString());
      legacy.raw
        .prepare(
          `INSERT INTO working_memory (id, session_id, content, content_type, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("wm-legacy", "s1", "legacy", "note", new Date(Date.now() - 60_000).toISOString());
      seedLeaseRow(legacy, "task-legacy", "dead", new Date(Date.now() - 60_000).toISOString());

      // Force the migration to re-run on reopen.
      legacy.raw.prepare("DELETE FROM schema_version WHERE version >= 12").run();
      legacy.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");

      const reopened = createDatabase(legacyPath);

      // The migration must have rewritten every ISO value.
      const remaining = reopened.raw
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM heartbeat_dedup WHERE expires_at LIKE '%T%')
           + (SELECT COUNT(*) FROM working_memory WHERE expires_at LIKE '%T%')
           + (SELECT COUNT(*) FROM heartbeat_schedule WHERE lease_expires_at LIKE '%T%') AS c`,
        )
        .get() as { c: number };
      expect(remaining.c).toBe(0);

      // And the previously-permanent rows now behave correctly.
      expect(isDeduplicated(reopened.raw, "legacy-expired")).toBe(false);
      expect(isDeduplicated(reopened.raw, "legacy-fresh")).toBe(true);
      expect(wmClearExpired(reopened.raw)).toBe(1);
      expect(acquireTaskLease(reopened.raw, "task-legacy", "new-owner", 60_000)).toBe(true);
    });

    it("is idempotent when re-applied", () => {
      const db = createDatabase(dbPath);
      db.raw
        .prepare(
          "INSERT INTO heartbeat_dedup (dedup_key, task_name, expires_at) VALUES (?, ?, ?)",
        )
        .run("k1", "task", toSqliteUtcTimestamp(Date.now() + 60_000));

      // Run the normalisation SQL a second time; it must not corrupt the row.
      db.raw.exec(MIGRATION_V12_NORMALISE_EXPIRY_TIMESTAMPS);
      db.raw.exec(MIGRATION_V12_NORMALISE_EXPIRY_TIMESTAMPS);

      const row = db.raw
        .prepare("SELECT expires_at FROM heartbeat_dedup WHERE dedup_key = ?")
        .get("k1") as { expires_at: string };
      expect(row.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(isDeduplicated(db.raw, "k1")).toBe(true);
    });
  });
});
