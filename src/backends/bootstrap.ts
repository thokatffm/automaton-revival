/**
 * Backend bootstrap: picks the infrastructure client for the configured
 * backend and wires the self-hosted pieces (ledger, vouchers, topup gate).
 */

import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type { PrivateKeyAccount } from "viem";
import type { AutomatonConfig, ConwayClient, SelfHostedConfig } from "../types.js";
import { DEFAULT_SELF_HOSTED_CONFIG, DEFAULT_CONFIG } from "../types.js";
import { createConwayClient } from "../conway/client.js";
import { setTopupDisabled } from "../conway/topup.js";
import { getAutomatonDir } from "../identity/wallet.js";
import { createLogger } from "../observability/logger.js";
import { CreditLedger } from "./ledger.js";
import { importVouchers, VOUCHER_DIR_NAME } from "./vouchers.js";
import { createSelfHostedClient } from "./self-hosted-client.js";
import { configureSpawnEnvironment } from "../replication/spawn.js";

const logger = createLogger("backend");

export function isSelfHosted(config: Pick<AutomatonConfig, "backend">): boolean {
  return config.backend === "self-hosted";
}

export function resolveSelfHostedConfig(config: Pick<AutomatonConfig, "selfHosted">): SelfHostedConfig {
  return { ...DEFAULT_SELF_HOSTED_CONFIG, ...(config.selfHosted ?? {}) };
}

export interface InfraSetup {
  conway: ConwayClient;
  /** Present only on the self-hosted backend. */
  ledger?: CreditLedger;
}

export function createInfraClient(params: {
  config: AutomatonConfig;
  apiKey: string;
  db: Database.Database;
  account: PrivateKeyAccount;
  selfAddress: string;
  chainType: string;
}): InfraSetup {
  const { config, apiKey, db, account, selfAddress, chainType } = params;

  if (!isSelfHosted(config)) {
    setTopupDisabled(null);
    return {
      conway: createConwayClient({
        apiUrl: config.conwayApiUrl,
        apiKey,
        sandboxId: config.sandboxId,
      }),
    };
  }

  setTopupDisabled(
    "credit topups buy Conway credits and are disabled on the self-hosted backend; " +
      "ask your creator to fund you (automaton-cli fund) or earn credits from your parent",
  );

  const sh = resolveSelfHostedConfig(config);
  const ledger = new CreditLedger(db);

  // Children run self-hosted too. Inside its container a child's own shell
  // is local; it reaches the host's Ollama via host.docker.internal.
  configureSpawnEnvironment({
    runtimeRepoUrl: sh.runtimeRepoUrl,
    genesisExtras: {
      backend: "self-hosted",
      selfHosted: { ...sh, sandbox: "local", containerName: undefined },
      inferenceModel: config.inferenceModel,
      modelStrategy: config.modelStrategy,
      ollamaBaseUrl: config.ollamaBaseUrl ? sh.childOllamaBaseUrl : undefined,
    },
    secrets: sh.shareProviderKeysWithChildren
      ? { openaiApiKey: config.openaiApiKey, anthropicApiKey: config.anthropicApiKey }
      : null,
  });
  const voucherDir = path.join(getAutomatonDir(), VOUCHER_DIR_NAME);
  const allowedSigners = [config.parentAddress, config.creatorAddress].filter(
    (a): a is string => typeof a === "string" && a.length > 0,
  );

  const findChildSandbox = db.prepare(
    `SELECT sandbox_id AS sandboxId FROM children
     WHERE lower(address) = lower(?) AND sandbox_id IS NOT NULL AND sandbox_id != ''
       AND status NOT IN ('dead', 'cleaned_up', 'failed')
     ORDER BY created_at DESC LIMIT 1`,
  );

  const client = createSelfHostedClient({
    mode: sh.sandbox,
    containerName: sh.containerName,
    dockerImage: sh.dockerImage,
    ledger,
    account: chainType === "evm" ? account : undefined,
    selfAddress,
    resolveSandboxForAddress: (address) =>
      (findChildSandbox.get(address) as { sandboxId?: string } | undefined)?.sandboxId,
  });

  // Pick up credit vouchers from parent/creator before every balance read,
  // so funding shows up on the next tick without a restart.
  const baseGetBalance = client.getCreditsBalance;
  client.getCreditsBalance = async () => {
    if (chainType === "evm" && allowedSigners.length > 0) {
      try {
        const res = await importVouchers(voucherDir, ledger, selfAddress, allowedSigners);
        if (res.imported > 0) logger.info(`Imported ${res.imported} credit voucher(s)`);
        for (const r of res.rejected) logger.warn(`Rejected credit voucher ${r.file}: ${r.reason}`);
      } catch (err: any) {
        logger.warn(`Credit voucher import failed: ${err?.message || err}`);
      }
    }
    return baseGetBalance();
  };

  return { conway: client, ledger };
}

/**
 * Build a config non-interactively from ~/.automaton/genesis.json, which a
 * parent writes into a child sandbox before starting it. Returns null when
 * there is no usable genesis file (then the interactive wizard runs).
 */
export function configFromGenesis(walletAddress: string): AutomatonConfig | null {
  const genesisPath = path.join(getAutomatonDir(), "genesis.json");
  if (!fs.existsSync(genesisPath)) return null;

  let g: any;
  try {
    g = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));
  } catch (err: any) {
    logger.warn(`genesis.json is unreadable: ${err?.message || err}`);
    return null;
  }
  if (!g || typeof g.name !== "string" || typeof g.genesisPrompt !== "string" || typeof g.creatorAddress !== "string") {
    logger.warn("genesis.json is missing name, genesisPrompt or creatorAddress");
    return null;
  }

  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  // Provider keys never travel in genesis.json (it is versioned in the state
  // repo); a parent that shares keys writes them to bootstrap-secrets.json.
  let secrets: any = {};
  const secretsPath = path.join(getAutomatonDir(), BOOTSTRAP_SECRETS_FILE);
  if (fs.existsSync(secretsPath)) {
    try {
      secrets = JSON.parse(fs.readFileSync(secretsPath, "utf-8")) ?? {};
    } catch {
      logger.warn(`${BOOTSTRAP_SECRETS_FILE} is unreadable, ignoring it`);
    }
  }

  return {
    ...DEFAULT_CONFIG,
    name: g.name,
    genesisPrompt: g.genesisPrompt,
    creatorMessage: str(g.creatorMessage),
    creatorAddress: g.creatorAddress,
    parentAddress: str(g.parentAddress),
    registeredWithConway: false,
    sandboxId: str(g.sandboxId) ?? "",
    walletAddress,
    conwayApiKey: "",
    chainType: g.chainType === "solana" ? "solana" : "evm",
    backend: g.backend === "self-hosted" ? "self-hosted" : "conway",
    selfHosted: g.selfHosted && typeof g.selfHosted === "object" ? g.selfHosted : undefined,
    inferenceModel: str(g.inferenceModel) ?? (DEFAULT_CONFIG.inferenceModel as string),
    ollamaBaseUrl: str(g.ollamaBaseUrl),
    openaiApiKey: str(secrets.openaiApiKey),
    anthropicApiKey: str(secrets.anthropicApiKey),
    modelStrategy: g.modelStrategy && typeof g.modelStrategy === "object" ? g.modelStrategy : undefined,
  } as AutomatonConfig;
}

export const BOOTSTRAP_SECRETS_FILE = "bootstrap-secrets.json";

/** Delete bootstrap-secrets.json once its keys are saved in automaton.json. */
export function removeBootstrapSecrets(): void {
  try {
    fs.rmSync(path.join(getAutomatonDir(), BOOTSTRAP_SECRETS_FILE), { force: true });
  } catch (err: any) {
    logger.warn(`Could not remove ${BOOTSTRAP_SECRETS_FILE}: ${err?.message || err}`);
  }
}
