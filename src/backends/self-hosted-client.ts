/**
 * Self-hosted Infrastructure Client
 *
 * Implements the ConwayClient interface without Conway Cloud, so the rest
 * of the runtime (tools, heartbeat, replication, survival) works unchanged:
 *
 *   exec / files     → the host itself ("local") or a Docker container ("docker")
 *   sandboxes        → Docker containers (children always run in Docker)
 *   credits          → local CreditLedger; transfers are signed vouchers
 *   registration     → local no-op (on-chain ERC-8004 identity is unaffected)
 *   domains          → not available; tools get a clear error
 *   models           → none advertised here; the model registry / Ollama
 *                      discovery supply BYOK and local models
 */

import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import nodePath from "path";
import type { PrivateKeyAccount } from "viem";
import type {
  ConwayClient,
  ExecResult,
  PortInfo,
  CreateSandboxOptions,
  SandboxInfo,
  PricingTier,
  CreditTransferResult,
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
} from "../types.js";
import { DockerSandboxDriver, toContainerPath } from "./docker.js";
import type { CreditLedger } from "./ledger.js";
import { createVoucher, VOUCHER_DIR_NAME } from "./vouchers.js";

export interface SelfHostedClientOptions {
  /** Where this client's exec/file operations run. */
  mode: "local" | "docker";
  /** Target container when mode = "docker". */
  containerName?: string;
  /** Image for newly created child sandboxes. */
  dockerImage: string;
  /** Own ledger. Omitted for clients scoped to a child sandbox. */
  ledger?: CreditLedger;
  /** Wallet used to sign outgoing credit vouchers. */
  account?: PrivateKeyAccount;
  /** This automaton's wallet address (used as parent label on children). */
  selfAddress: string;
  /** Finds the sandbox (container) of a child by wallet address, for voucher delivery. */
  resolveSandboxForAddress?: (address: string) => string | undefined;
  driver?: DockerSandboxDriver;
  /** Host home directory for local mode (defaults to HOME / os.homedir()). */
  home?: string;
}

export class SelfHostedUnsupportedError extends Error {
  constructor(feature: string) {
    super(
      `${feature} is not available on the self-hosted backend. ` +
        `Switch "backend" to "conway" in automaton.json to use Conway Cloud for this.`,
    );
    this.name = "SelfHostedUnsupportedError";
  }
}

export function createSelfHostedClient(options: SelfHostedClientOptions): ConwayClient {
  const driver = options.driver ?? new DockerSandboxDriver();
  const home = options.home ?? (process.env.HOME || os.homedir());
  const mode = options.mode;
  const container = options.containerName?.trim() || "";

  if (mode === "docker" && !container) {
    throw new Error('selfHosted.sandbox is "docker" but no containerName is configured');
  }

  /**
   * Map sandbox paths to the host in local mode. The tool layer confines
   * writes to the POSIX sandbox home /root; on a self-hosted machine that is
   * the user's home directory.
   */
  const toLocalPath = (filePath: string): string => {
    const p = toContainerPath(filePath);
    if (p === "/root") return home;
    if (p.startsWith("/root/")) return nodePath.join(home, ...p.slice("/root/".length).split("/"));
    return p;
  };

  const exec = async (command: string, timeout?: number): Promise<ExecResult> => {
    if (mode === "docker") return driver.exec(container, command, timeout);
    try {
      const stdout = execSync(command, {
        timeout: timeout || 30_000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        cwd: home,
        windowsHide: true,
      });
      return { stdout: stdout || "", stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || err.message || "",
        exitCode: err.status ?? 1,
      };
    }
  };

  const writeFile = async (filePath: string, content: string): Promise<void> => {
    if (mode === "docker") return driver.writeFile(container, filePath, content);
    const resolved = toLocalPath(filePath);
    fs.mkdirSync(nodePath.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
  };

  const readFile = async (filePath: string): Promise<string> => {
    if (mode === "docker") return driver.readFile(container, filePath);
    return fs.readFileSync(toLocalPath(filePath), "utf-8");
  };

  const exposePort = async (port: number): Promise<PortInfo> => {
    if (mode === "local") {
      return { port, publicUrl: `http://localhost:${port}`, sandboxId: "local" };
    }
    throw new SelfHostedUnsupportedError(
      "Exposing ports of a running Docker sandbox (publish ports when the container is created instead)",
    );
  };

  const removePort = async (_port: number): Promise<void> => {
    // Nothing to tear down locally; Docker port mappings are fixed at creation.
  };

  const createSandbox = async (opts: CreateSandboxOptions): Promise<SandboxInfo> => {
    if (!(await driver.isAvailable())) {
      throw new Error("Docker is not available: child sandboxes need a running Docker daemon");
    }
    return driver.createSandbox({ ...opts, image: options.dockerImage, parentId: options.selfAddress });
  };

  const deleteSandbox = async (sandboxId: string): Promise<void> => {
    if (mode === "docker" && sandboxId === container) {
      throw new Error("Refusing to delete own sandbox");
    }
    await driver.deleteSandbox(sandboxId);
  };

  const listSandboxes = async (): Promise<SandboxInfo[]> => {
    if (!(await driver.isAvailable())) return [];
    return driver.listSandboxes();
  };

  const requireLedger = (): CreditLedger => {
    if (!options.ledger) {
      throw new Error("Credit operations are not available on a client scoped to another sandbox");
    }
    return options.ledger;
  };

  const getCreditsBalance = async (): Promise<number> => requireLedger().getBalanceCents();

  const getCreditsPricing = async (): Promise<PricingTier[]> => [];

  const transferCredits = async (
    toAddress: string,
    amountCents: number,
    note?: string,
  ): Promise<CreditTransferResult> => {
    const ledger = requireLedger();
    if (!options.account) {
      throw new Error("Credit transfers need the wallet account to sign a voucher");
    }
    const targetSandbox = options.resolveSandboxForAddress?.(toAddress);
    if (!targetSandbox) {
      throw new Error(
        `No known sandbox for ${toAddress}. Self-hosted credit transfers can only go to this automaton's own children.`,
      );
    }

    // Sign first so a signing failure cannot leave a debit behind.
    const voucher = await createVoucher(options.account, { to: toAddress, amountCents, note });
    const { balanceAfterCents } = ledger.debitTransfer(amountCents, toAddress, note);

    try {
      await driver.writeFile(
        targetSandbox,
        `/root/.automaton/${VOUCHER_DIR_NAME}/${voucher.payload.id}.json`,
        JSON.stringify(voucher, null, 2),
      );
    } catch (err) {
      // Delivery failed: refund the debit so credits are never lost in transit.
      ledger.record({
        kind: "adjustment",
        deltaCents: amountCents,
        counterparty: toAddress,
        note: `refund: voucher ${voucher.payload.id} could not be delivered`,
      });
      throw err;
    }

    return {
      transferId: voucher.payload.id,
      status: "delivered",
      toAddress,
      amountCents,
      balanceAfterCents,
    };
  };

  const registerAutomaton: ConwayClient["registerAutomaton"] = async (params) => ({
    automaton: {
      id: params.automatonId,
      address: params.automatonAddress,
      backend: "self-hosted",
      registered: "local",
    },
  });

  const searchDomains = async (): Promise<DomainSearchResult[]> => {
    throw new SelfHostedUnsupportedError("Domain search");
  };
  const registerDomain = async (): Promise<DomainRegistration> => {
    throw new SelfHostedUnsupportedError("Domain registration");
  };
  const listDnsRecords = async (): Promise<DnsRecord[]> => {
    throw new SelfHostedUnsupportedError("DNS management");
  };
  const addDnsRecord = async (): Promise<DnsRecord> => {
    throw new SelfHostedUnsupportedError("DNS management");
  };
  const deleteDnsRecord = async (): Promise<void> => {
    throw new SelfHostedUnsupportedError("DNS management");
  };

  const listModels = async (): Promise<ModelInfo[]> => [];

  const createScopedClient = (targetSandboxId: string): ConwayClient =>
    createSelfHostedClient({
      mode: "docker",
      containerName: targetSandboxId,
      dockerImage: options.dockerImage,
      selfAddress: options.selfAddress,
      driver,
      // no ledger / account: a scoped client must not spend the parent's credits
    });

  return {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,
    createSandbox,
    deleteSandbox,
    listSandboxes,
    getCreditsBalance,
    getCreditsPricing,
    transferCredits,
    registerAutomaton,
    searchDomains,
    registerDomain,
    listDnsRecords,
    addDnsRecord,
    deleteDnsRecord,
    listModels,
    createScopedClient,
  };
}
