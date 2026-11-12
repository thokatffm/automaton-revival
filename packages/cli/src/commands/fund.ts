/**
 * automaton-cli fund <amount> [--to 0x...]
 *
 * Transfer Conway credits using the configured Conway API key.
 */

import { loadConfig, resolvePath } from "@conway/automaton/config.js";
import { CreditLedger } from "@conway/automaton/backends/ledger.js";

const args = process.argv.slice(3);
const amount = args[0];
const toIndex = args.indexOf("--to");
const toAddress = toIndex >= 0 ? args[toIndex + 1] : undefined;

if (!amount) {
  console.log("Usage: automaton-cli fund <amount> [--to 0x...]");
  console.log("Examples:");
  console.log("  automaton-cli fund 5.00");
  console.log("  automaton-cli fund 500 --to 0xabc...");
  process.exit(1);
}

const config = loadConfig();
if (!config) {
  console.log("No automaton configuration found.");
  process.exit(1);
}

const amountCents = parseAmountToCents(amount);
if (amountCents <= 0) {
  console.log(`Invalid amount: ${amount}`);
  process.exit(1);
}

// Self-hosted backend: credits are a local ledger in the automaton's state.db.
// The creator funds it directly from the host; there is no Conway account.
if (config.backend === "self-hosted") {
  if (toAddress) {
    console.log("--to is not supported on the self-hosted backend: run fund on the host of the target automaton.");
    process.exit(1);
  }
  const dbPath = resolvePath(config.dbPath);
  const { entry, balanceCents } = CreditLedger.fundDatabase(
    dbPath,
    amountCents,
    `fund via automaton-cli (${config.name})`,
  );
  console.log(`
Ledger funded.
Automaton: ${config.name} (${config.walletAddress})
Amount:    $${(amountCents / 100).toFixed(2)} (${amountCents} cents)
Entry:     ${entry.id}
Balance:   $${(balanceCents / 100).toFixed(2)} after funding
`);
  process.exit(0);
}

if (!config.conwayApiKey) {
  console.log("No Conway API key found in automaton config.");
  process.exit(1);
}

const destination = toAddress || config.walletAddress;

const payload = {
  to_address: destination,
  amount_cents: amountCents,
  note: `fund via automaton-cli (${config.name})`,
};

const apiUrl = config.conwayApiUrl || "https://api.conway.tech";
const paths = ["/v1/credits/transfer", "/v1/credits/transfers"];

let success: any | null = null;
let lastError = "";

for (const path of paths) {
  const resp = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: config.conwayApiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    lastError = `${resp.status}: ${text}`;
    if (resp.status === 404) {
      continue;
    }
    console.log(`Credit transfer failed (${path}): ${lastError}`);
    process.exit(1);
  }

  success = await resp.json().catch(() => ({}));
  break;
}

if (!success) {
  console.log(`Credit transfer failed: ${lastError || "unknown error"}`);
  process.exit(1);
}

const transferId = success.transfer_id || success.id || "n/a";
const status = success.status || "submitted";
const balanceAfter = success.balance_after_cents ?? success.new_balance_cents;

console.log(`
Transfer submitted.
From key:  ${maskKey(config.conwayApiKey)}
To:        ${destination}
Amount:    $${(amountCents / 100).toFixed(2)} (${amountCents} cents)
Status:    ${status}
Transfer:  ${transferId}
${balanceAfter !== undefined ? `Balance:   $${(Number(balanceAfter) / 100).toFixed(2)} after transfer` : ""}
`);

function parseAmountToCents(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;

  // If user provides integer >= 100, treat as cents.
  if (/^\d+$/.test(trimmed) && Number(trimmed) >= 100) {
    return Number(trimmed);
  }

  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars)) return 0;
  return Math.round(dollars * 100);
}

function maskKey(key: string): string {
  if (key.length < 8) return "***";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
