#!/usr/bin/env node
/**
 * Testnet x402 sale, run by the creator.
 *
 * Ferby sells one call (0.001 test USDC) through the local x402 seller on
 * Base Sepolia. A separate test wallet acts as the customer and pays with the
 * real x402 client. Ferby settles the payment on chain and pays the gas.
 *
 * Testnet only: tokens have no value. The seller listens on 127.0.0.1 only and
 * is shut down after the sale.
 *
 *   node scripts/x402-testnet-sale.mjs
 *
 * Run `pnpm build` first; the script uses the compiled runtime in dist/.
 */

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline/promises";
import { pathToFileURL } from "url";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const dist = (p) => pathToFileURL(path.resolve(here, "..", "dist", p)).href;
const nm = (p) => pathToFileURL(path.resolve(here, "..", "node_modules", p)).href;

const { getWallet } = await import(dist("identity/wallet.js"));
const { x402Fetch } = await import(dist("conway/x402.js"));
const { createSeller, makeOnchainSettler, startLocalSeller } = await import(dist("conway/x402-seller.js"));
const viem = await import(nm("viem/_esm/index.js"));
const { privateKeyToAccount, generatePrivateKey } = await import(nm("viem/_esm/accounts/index.js"));
const { baseSepolia } = await import(nm("viem/_esm/chains/index.js"));

const SEP_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PRICE = 1000n; // 0.001 USDC
const RPC = "https://sepolia.base.org";

const erc20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "version", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
const client = viem.createPublicClient({ chain: baseSepolia, transport: viem.http(RPC) });
const usdc = (addr) => client.readContract({ address: SEP_USDC, abi: erc20, functionName: "balanceOf", args: [addr] });

// Seller: Ferby's own wallet (same address on every EVM chain).
const { account: ferby } = await getWallet();

// Customer: a separate testnet-only wallet, created on first run.
const automatonDir = path.join(process.env.HOME || os.homedir(), ".automaton");
const payerFile = path.join(automatonDir, "testnet-payer.json");
if (!fs.existsSync(payerFile)) {
  fs.writeFileSync(
    payerFile,
    JSON.stringify({ privateKey: generatePrivateKey(), note: "Base Sepolia test customer for x402-testnet-sale. Testnet only, no real value." }, null, 2),
    { mode: 0o600 },
  );
}
const payer = privateKeyToAccount(JSON.parse(fs.readFileSync(payerFile, "utf-8")).privateKey);

const [ferbyEth, payerUsdc, tokenName, tokenVersion] = await Promise.all([
  client.getBalance({ address: ferby.address }),
  usdc(payer.address),
  client.readContract({ address: SEP_USDC, abi: erc20, functionName: "name" }),
  client.readContract({ address: SEP_USDC, abi: erc20, functionName: "version" }),
]);

console.log(`
  Network:           Base Sepolia (testnet, no real value)
  Seller (Ferby):    ${ferby.address}  test ETH for gas: ${viem.formatEther(ferbyEth)}
  Customer (test):   ${payer.address}  test USDC: ${(Number(payerUsdc) / 1e6).toFixed(6)}
  Price:             ${(Number(PRICE) / 1e6).toFixed(3)} USDC   Token: ${tokenName} v${tokenVersion}
`);

const missing = [];
if (ferbyEth === 0n) missing.push(`- Test ETH (Base Sepolia) for Ferby's gas, to ${ferby.address}`);
if (payerUsdc < PRICE) missing.push(`- Test USDC (Base Sepolia) for the customer, to ${payer.address}`);
if (missing.length) {
  console.log("  Testnet funds needed first (free, from public faucets):\n  " + missing.join("\n  ") + "\n");
  console.log("  Then run this script again. Nothing was paid.\n");
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question("  Run the testnet sale now? (yes/no) ")).trim().toLowerCase();
rl.close();
if (!["yes", "y", "ja", "j"].includes(answer)) {
  console.log("\n  Cancelled. Nothing was paid.\n");
  process.exit(0);
}

const handle = createSeller({
  payTo: ferby.address,
  asset: SEP_USDC,
  network: "eip155:84532",
  chainId: baseSepolia.id,
  priceAtomic: PRICE,
  domainName: tokenName,
  domainVersion: tokenVersion,
  maxTimeoutSeconds: 300,
  resourceUrl: "http://127.0.0.1/text/stats",
  settle: makeOnchainSettler({ account: ferby, asset: SEP_USDC, chain: baseSepolia, rpcUrl: RPC }),
});

const server = await startLocalSeller(handle, 0);
const port = server.address().port;
const url = `http://127.0.0.1:${port}/text/stats`;
console.log(`\n  Seller listening on ${url} (this machine only)`);

try {
  const result = await x402Fetch(url, payer, "GET", undefined, undefined, 1, "evm");
  console.log("\n  Result:    ", result.success ? "paid, settled and served" : "not paid / failed");
  if (result.error) console.log("  Error:     ", result.error);
  if (result.settlement) console.log("  Settlement:", JSON.stringify(result.settlement));
  const tx = result.settlement?.transaction;
  if (tx) console.log(`  BaseScan:   https://sepolia.basescan.org/tx/${tx}`);
  if (result.response !== undefined) console.log("  Response:  ", JSON.stringify(result.response));
} finally {
  server.close();
}

const [ferbyUsdcAfter, payerUsdcAfter] = await Promise.all([usdc(ferby.address), usdc(payer.address)]);
console.log(`\n  Ferby test USDC:    ${(Number(ferbyUsdcAfter) / 1e6).toFixed(6)}`);
console.log(`  Customer test USDC: ${(Number(payerUsdcAfter) / 1e6).toFixed(6)}\n`);
