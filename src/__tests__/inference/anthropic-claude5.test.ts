/**
 * Claude 5-generation support for BYOK Anthropic setups:
 * pricing in the registry, provider-aware routing, and a request shape the
 * current API accepts (no sampling params, adaptive thinking, thinking blocks
 * replayed unchanged next to their tool_use blocks).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { MIGRATION_V6 } from "../../state/schema.js";
import { ModelRegistry } from "../../inference/registry.js";
import { InferenceRouter } from "../../inference/router.js";
import { InferenceBudgetTracker } from "../../inference/budget.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../../inference/types.js";
import {
  createInferenceClient,
  isThinkingClaudeModel,
  __clearAnthropicContentCacheForTest,
} from "../../conway/inference.js";
import type { ChatMessage } from "../../types.js";

describe("routing with only an Anthropic key", () => {
  let db: BetterSqlite3.Database;
  let router: InferenceRouter;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(MIGRATION_V6);
    const registry = new ModelRegistry(db);
    registry.initialize();
    const budget = new InferenceBudgetTracker(db, DEFAULT_MODEL_STRATEGY_CONFIG);
    router = new InferenceRouter(db, registry, budget, (m) => m.provider === "anthropic");
  });
  afterEach(() => db.close());

  it("routes agent turns to Opus and cheap tasks to Haiku", () => {
    expect(router.selectModel("normal", "agent_turn")?.modelId).toBe("claude-opus-5-5");
    expect(router.selectModel("normal", "heartbeat_triage")?.modelId).toBe("claude-haiku-5-5");
    expect(router.selectModel("low_compute", "agent_turn")?.modelId).toBe("claude-haiku-5-5");
    expect(router.selectModel("critical", "agent_turn")?.modelId).toBe("claude-haiku-5-5");
  });

  it("prices Claude models so spend reaches the credit ledger", () => {
    const opus = router.selectModel("normal", "agent_turn")!;
    // 10k input + 1k output on Opus 5.5 = $0.04 + $0.02 = 6 cents
    const cents = Math.ceil((10_000 / 1000) * opus.costPer1kInput / 100 + (1_000 / 1000) * opus.costPer1kOutput / 100);
    expect(cents).toBe(6);
  });

  it("without a filter keeps the original OpenAI-first choice", () => {
    const registry = new ModelRegistry(db);
    const plain = new InferenceRouter(db, registry, new InferenceBudgetTracker(db, DEFAULT_MODEL_STRATEGY_CONFIG));
    expect(plain.selectModel("normal", "agent_turn")?.modelId).toBe("gpt-5.2");
  });
});

describe("Anthropic request shape", () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let reply: unknown;

  beforeEach(() => {
    calls.length = 0;
    __clearAnthropicContentCacheForTest();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const client = () =>
    createInferenceClient({
      apiUrl: "",
      apiKey: "",
      defaultModel: "claude-opus-5-5",
      maxTokens: 4096,
      anthropicApiKey: "sk-ant-test",
      conwayEnabled: false,
      getModelProvider: () => "anthropic",
    });

  const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
  const toolUse = { type: "tool_use", id: "toolu_1", name: "exec", input: { command: "ls" } };

  it("recognises Claude 5-generation model ids", () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5", "claude-fable-5-2"]) {
      expect(isThinkingClaudeModel(id)).toBe(true);
    }
    for (const id of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "gpt-5.2"]) {
      expect(isThinkingClaudeModel(id)).toBe(false);
    }
  });

  it("sends adaptive thinking with drop_block and no temperature", async () => {
    reply = { id: "m1", model: "claude-opus-5-5", content: [thinking, { type: "text", text: "hi" }], usage: { input_tokens: 5, output_tokens: 3 }, stop_reason: "end_turn" };
    await client().chat([{ role: "user", content: "hello" }], { temperature: 0.7 });
    const { body, headers, url } = calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(16_000);
    expect(body.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(headers["anthropic-beta"]).toBe("thinking-binding-controls-2026-08-01");
  });

  it("keeps the old request shape for earlier Claude models", async () => {
    reply = { id: "m1", content: [{ type: "text", text: "hi" }], usage: {}, stop_reason: "end_turn" };
    await client().chat([{ role: "user", content: "hello" }], { model: "claude-sonnet-4-6", temperature: 0.7 });
    const { body, headers } = calls[0];
    expect(body.temperature).toBe(0.7);
    expect(body.thinking).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
  });

  it("replays thinking blocks unchanged with their tool_use on the next turn", async () => {
    const c = client();
    reply = { id: "m1", content: [thinking, { type: "text", text: "listing" }, toolUse], usage: {}, stop_reason: "tool_use" };
    const first = await c.chat([{ role: "user", content: "look around" }]);
    expect(first.toolCalls?.[0].id).toBe("toolu_1");

    reply = { id: "m2", content: [{ type: "text", text: "done" }], usage: {}, stop_reason: "end_turn" };
    const history: ChatMessage[] = [
      { role: "user", content: "look around" },
      { role: "assistant", content: "listing", tool_calls: first.toolCalls },
      { role: "tool", content: "a.txt", tool_call_id: "toolu_1" },
    ];
    await c.chat(history);

    const assistant = calls[1].body.messages.find((m: any) => m.role === "assistant");
    expect(assistant.content).toEqual([thinking, { type: "text", text: "listing" }, toolUse]);
  });

  it("does not replay a turn whose tool calls were only partly executed", async () => {
    const c = client();
    const second = { type: "tool_use", id: "toolu_2", name: "exec", input: { command: "pwd" } };
    reply = { id: "m1", content: [thinking, toolUse, second], usage: {}, stop_reason: "tool_use" };
    const first = await c.chat([{ role: "user", content: "go" }]);

    reply = { id: "m2", content: [{ type: "text", text: "ok" }], usage: {}, stop_reason: "end_turn" };
    await c.chat([
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [first.toolCalls![0]] },
      { role: "tool", content: "a.txt", tool_call_id: "toolu_1" },
    ]);
    const assistant = calls[1].body.messages.find((m: any) => m.role === "assistant");
    expect(assistant.content.some((b: any) => b.type === "thinking")).toBe(false);
    expect(assistant.content.filter((b: any) => b.type === "tool_use")).toHaveLength(1);
  });
});
