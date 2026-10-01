/**
 * Failed-Inference Cost Accounting Tests
 *
 * Regression coverage for two defects in the inference layer:
 *
 *  1. `InferenceRouter.route` called `budget.recordCost` only on the success
 *     path. A request that reached the provider and then failed — timeout,
 *     upstream 5xx, connection reset — was recorded at zero, so the spend
 *     ledger silently under-reported real consumption.
 *
 *  2. The token cache keyed entries on the full input text, so the Map
 *     retained every payload (~45 KB per cached integer) while looking like a
 *     fixed-size LRU.
 *
 * These assert observable behaviour (what lands in `inference_costs`, what the
 * cache retains), not the internal encoding.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { MIGRATION_V6 } from "../state/schema.js";
import { inferenceGetSessionCosts } from "../state/database.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceRouter } from "../inference/router.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../inference/types.js";
import { createTokenCounter } from "../memory/context-manager.js";

let db: BetterSqlite3.Database;

function createTestDb(): BetterSqlite3.Database {
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = WAL");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(MIGRATION_V6);
  return testDb;
}

function makeRouter(customBudget?: InferenceBudgetTracker) {
  const registry = new ModelRegistry(db);
  registry.initialize();
  const budget =
    customBudget ?? new InferenceBudgetTracker(db, DEFAULT_MODEL_STRATEGY_CONFIG);
  return { router: new InferenceRouter(db, registry, budget), budget };
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

describe("failed inference calls are billed", () => {
  it("records cost for a request that times out", async () => {
    const { router } = makeRouter();

    // AbortError is how the timeout path surfaces.
    const abortError: any = new Error("aborted");
    abortError.name = "AbortError";

    const result = await router.route(
      {
        messages: [{ role: "user", content: "x".repeat(40_000) }],
        taskType: "agent_turn",
        tier: "normal",
        sessionId: "timeout-session",
      },
      async () => {
        throw abortError;
      },
    );

    expect(result.finishReason).toBe("timeout");

    // The prompt was still sent, so the ledger must reflect it.
    const costs = inferenceGetSessionCosts(db, "timeout-session");
    expect(costs.length).toBe(1);
    expect(costs[0].inputTokens).toBeGreaterThan(0);
    expect(costs[0].outputTokens).toBe(0);
  });

  it("reports the estimated cost on the timeout result", async () => {
    const { router } = makeRouter();
    const abortError: any = new Error("aborted");
    abortError.name = "AbortError";

    const result = await router.route(
      {
        messages: [{ role: "user", content: "y".repeat(40_000) }],
        taskType: "agent_turn",
        tier: "normal",
        sessionId: "timeout-result",
      },
      async () => {
        throw abortError;
      },
    );

    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.costCents).toBeGreaterThan(0);
  });

  it("records cost before rethrowing a non-timeout failure", async () => {
    const { router } = makeRouter();

    await expect(
      router.route(
        {
          messages: [{ role: "user", content: "z".repeat(40_000) }],
          taskType: "agent_turn",
          tier: "normal",
          sessionId: "upstream-failure",
        },
        async () => {
          throw new Error("503 Service Unavailable");
        },
      ),
    ).rejects.toThrow("503");

    // A retry storm must not be free.
    const costs = inferenceGetSessionCosts(db, "upstream-failure");
    expect(costs.length).toBe(1);
    expect(costs[0].inputTokens).toBeGreaterThan(0);
  });

  it("scales the recorded cost with prompt size", async () => {
    const { router } = makeRouter();
    const abortError: any = new Error("aborted");
    abortError.name = "AbortError";

    const run = async (chars: number, sessionId: string) => {
      await router.route(
        {
          messages: [{ role: "user", content: "q".repeat(chars) }],
          taskType: "agent_turn",
          tier: "normal",
          sessionId,
        },
        async () => {
          throw abortError;
        },
      );
      return inferenceGetSessionCosts(db, sessionId)[0];
    };

    const small = await run(1_000, "small-prompt");
    const large = await run(100_000, "large-prompt");

    expect(large.inputTokens).toBeGreaterThan(small.inputTokens);
    expect(large.costCents).toBeGreaterThanOrEqual(small.costCents);
  });

  it("does not double-record when the call succeeds normally", async () => {
    const { router } = makeRouter();

    await router.route(
      {
        messages: [{ role: "user", content: "hello" }],
        taskType: "agent_turn",
        tier: "normal",
        sessionId: "success-session",
      },
      async () => ({
        message: { content: "hi" },
        usage: { promptTokens: 1000, completionTokens: 500 },
        finishReason: "stop",
      }),
    );

    const costs = inferenceGetSessionCosts(db, "success-session");
    expect(costs.length).toBe(1);
    expect(costs[0].inputTokens).toBe(1000);
    expect(costs[0].outputTokens).toBe(500);
  });
});

describe("token cache does not retain payloads", () => {
  it("still returns the same count for repeated input", () => {
    const counter = createTokenCounter();
    const text = "the quick brown fox jumps over the lazy dog";

    const first = counter.countTokens(text);
    const second = counter.countTokens(text);
    expect(second).toBe(first);
  });

  it("returns a correct count for distinct inputs", () => {
    const counter = createTokenCounter();
    const a = "hello world";
    const b = "goodbye moon";

    expect(counter.countTokens(a)).not.toBe(counter.countTokens(b));
  });

  it("keeps cache keys small instead of storing the text", () => {
    const counter = createTokenCounter();
    // ~2 KB keeps this off the tokenizer's quadratic path (see PR #358/#332),
    // while still being far larger than any fixed-size key would need to be.
    const big = "w".repeat(2_000);
    counter.countTokens(big);

    expect(counter.cache.size).toBe(1);
    for (const key of counter.cache.keys()) {
      // A key that embeds the payload would be ~2k chars.
      expect(key.length).toBeLessThan(128);
    }
  });

  it("does not retain the payload text in the cache", () => {
    const counter = createTokenCounter();
    const marker = "UNIQUEPAYLOADMARKER";
    const payload = `${marker}${"w".repeat(1_000)}`;
    counter.countTokens(payload);

    // Inspect what the Map actually holds rather than sampling heap growth:
    // heapUsed also moves with tokenizer/tiktoken internals, which makes a
    // byte threshold flaky. The old key was `${model}::${text}`, so the
    // payload was literally the key.
    const [key, value] = [...counter.cache.entries()][0];
    expect(key).not.toContain(marker);
    expect(key).not.toContain("w".repeat(100));
    // The value stays a plain number, so nothing large is attached to it.
    expect(typeof value).toBe("number");
  });

  it("still honours the entry-count cap", () => {
    const counter = createTokenCounter();
    for (let i = 0; i < 10_050; i++) {
      counter.countTokens(`distinct-${i}-${"p".repeat(32)}`);
    }
    expect(counter.cache.size).toBeLessThanOrEqual(10_000);
  });
});
