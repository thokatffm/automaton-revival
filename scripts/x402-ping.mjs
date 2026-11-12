#!/usr/bin/env node
/**
 * Live x402 payment check for the creator.
 *
 * Pays a public x402 test endpoint from the automaton's own wallet, inside the
 * automaton's configured limits, and prints what settled on chain. It asks
 * for confirmation before signing anything.
 *
 *   node scripts/x402-ping.mjs [url]
 *
 * Default URL: the Wren x402 Doctor ping on Base mainnet (0.001 USDC).
 * Run `pnpm build` first; the script uses the compiled runtime in dist/.
 */

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline/promises";
import { pathToFileURL } from "url";

const DEFAULT_URL = "https://wren-x402-doctor.wrenonbase.workers.dev/ping";
const url = process.argv[2] || DEFAULT_URL;

const dist = (p) => pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "dist", p)).href;
const { getWallet } = await import(dist("identity/wallet.js"));
const { x402Fetch, getUsdcBalance } = await import(dist("conway/x402.js"));

const configPath = path.join(process.env.HOME || os.homedir(), ".automaton", "automaton.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const policy = config.treasuryPolicy ?? {};
const maxCents = policy.maxX402PaymentCents ?? 0;
const allowed = policy.x402AllowedDomains ?? [];

const host = new URL(url).hostname;
if (!allowed.some((d) => host === d || host.endsWith(`.${d}`))) {
  console.error(`\n  ${host} is not in treasuryPolicy.x402AllowedDomains (${allowed.join(", ") || "empty"}). Nothing paid.\n`);
  process.exit(1);
}
if (!(maxCents > 0)) {
  console.error("\n  treasuryPolicy.maxX402PaymentCents is 0, so x402 payments are disabled. Nothing paid.\n");
  process.exit(1);
}

const { account, chainType } = await getWallet();
if (chainType !== "evm") {
  console.error("\n  x402 needs an EVM wallet. Nothing paid.\n");
  process.exit(1);
}

const before = await getUsdcBalance(account.address, "eip155:8453");
console.log(`
  Automaton:   ${config.name} (${account.address})
  USDC (Base): ${before.toFixed(6)}
  Endpoint:    ${url}
  Limit:       ${maxCents} cent(s) per payment
`);

if (before <= 0) {
  console.error("  The wallet holds no USDC on Base yet. Send a small amount first. Nothing paid.\n");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question("  Pay this endpoint now with real USDC? (yes/no) ")).trim().toLowerCase();
rl.close();
if (answer !== "yes" && answer !== "y" && answer !== "ja" && answer !== "j") {
  console.log("\n  Cancelled. Nothing paid.\n");
  process.exit(0);
}

const result = await x402Fetch(url, account, "GET", undefined, undefined, maxCents, chainType);
console.log("\n  Result:", result.success ? "paid and served" : "not paid / failed");
if (result.error) console.log("  Error: ", result.error);
if (result.settlement) {
  console.log("  Settlement:", JSON.stringify(result.settlement));
  const tx = result.settlement.transaction;
  if (tx) console.log(`  BaseScan:   https://basescan.org/tx/${tx}`);
}
if (result.response !== undefined) {
  const text = typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2);
  console.log("  Response:  ", text.slice(0, 1500));
}

const after = await getUsdcBalance(account.address, "eip155:8453");
console.log(`\n  USDC before: ${before.toFixed(6)}  after: ${after.toFixed(6)}  (settlement can take a few seconds to show)\n`);
