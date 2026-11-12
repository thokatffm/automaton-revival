/**
 * Signed Credit Vouchers (self-hosted backend)
 *
 * Without Conway's hosted ledger there is no shared authority that can move
 * credits between automatons. A child runs in its own sandbox with shell
 * access and can self-modify, so any unsigned hand-off (a file, a CLI flag,
 * a DB row) would let it mint credits for itself.
 *
 * Instead, the sender signs a voucher with its wallet key. The recipient
 * imports a voucher only if
 *   - it is addressed to the recipient's own wallet,
 *   - its signature recovers to an allowed signer (the recipient's parent or
 *     creator, both fixed in its protected automaton.json), and
 *   - its id has not been imported before (the id doubles as the ledger
 *     entry id, so replays are rejected by the PRIMARY KEY).
 *
 * EVM wallets only (EIP-191 personal_sign); Solana wallets cannot send or
 * receive vouchers yet.
 */

import fs from "fs";
import path from "path";
import { ulid } from "ulid";
import { verifyMessage, getAddress, isAddress } from "viem";
import type { PrivateKeyAccount } from "viem";
import type { CreditLedger } from "./ledger.js";

export const VOUCHER_VERSION = 1;
export const VOUCHER_DIR_NAME = "credit-vouchers";

export interface CreditVoucherPayload {
  v: number;
  id: string;
  from: string;
  to: string;
  amountCents: number;
  note?: string;
  issuedAt: string;
}

export interface CreditVoucher {
  payload: CreditVoucherPayload;
  signature: `0x${string}`;
}

/** Deterministic message that is signed: fixed key order, no whitespace. */
export function voucherMessage(p: CreditVoucherPayload): string {
  return `automaton-credit-voucher:${JSON.stringify({
    v: p.v,
    id: p.id,
    from: p.from,
    to: p.to,
    amountCents: p.amountCents,
    note: p.note ?? "",
    issuedAt: p.issuedAt,
  })}`;
}

export async function createVoucher(
  account: PrivateKeyAccount,
  params: { to: string; amountCents: number; note?: string },
): Promise<CreditVoucher> {
  if (!isAddress(params.to)) {
    throw new Error(`Vouchers require an EVM recipient address, got ${params.to}`);
  }
  if (!Number.isSafeInteger(params.amountCents) || params.amountCents <= 0) {
    throw new Error(`Voucher amount must be a positive integer number of cents`);
  }
  const payload: CreditVoucherPayload = {
    v: VOUCHER_VERSION,
    id: ulid(),
    from: getAddress(account.address),
    to: getAddress(params.to),
    amountCents: params.amountCents,
    note: params.note,
    issuedAt: new Date().toISOString(),
  };
  const signature = await account.signMessage({ message: voucherMessage(payload) });
  return { payload, signature };
}

export type VoucherCheck = { ok: true } | { ok: false; reason: string };

export async function verifyVoucher(
  voucher: CreditVoucher,
  expectedRecipient: string,
  allowedSigners: string[],
): Promise<VoucherCheck> {
  const p = voucher?.payload;
  if (!p || p.v !== VOUCHER_VERSION) return { ok: false, reason: "unsupported voucher version" };
  if (typeof p.id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(p.id)) {
    return { ok: false, reason: "invalid voucher id" };
  }
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) {
    return { ok: false, reason: "invalid amount" };
  }
  if (!isAddress(p.from) || !isAddress(p.to) || !isAddress(expectedRecipient)) {
    return { ok: false, reason: "invalid address" };
  }
  if (getAddress(p.to) !== getAddress(expectedRecipient)) {
    return { ok: false, reason: "voucher is addressed to a different wallet" };
  }
  const signers = allowedSigners.filter((a) => isAddress(a)).map((a) => getAddress(a));
  if (!signers.includes(getAddress(p.from))) {
    return { ok: false, reason: `signer ${p.from} is not an allowed funder` };
  }
  try {
    const valid = await verifyMessage({
      address: getAddress(p.from),
      message: voucherMessage(p),
      signature: voucher.signature,
    });
    return valid ? { ok: true } : { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "bad signature" };
  }
}

export interface VoucherImportResult {
  imported: number;
  rejected: Array<{ file: string; reason: string }>;
}

/**
 * Import every valid voucher in `dir` into the ledger. Imported and rejected
 * files are moved to `processed/` / `rejected/` so they are looked at once.
 */
export async function importVouchers(
  dir: string,
  ledger: CreditLedger,
  selfAddress: string,
  allowedSigners: string[],
): Promise<VoucherImportResult> {
  const result: VoucherImportResult = { imported: 0, rejected: [] };
  if (!fs.existsSync(dir)) return result;

  const processedDir = path.join(dir, "processed");
  const rejectedDir = path.join(dir, "rejected");

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(dir, file);
    let reason: string | null = null;
    try {
      const voucher = JSON.parse(fs.readFileSync(full, "utf-8")) as CreditVoucher;
      const check = await verifyVoucher(voucher, selfAddress, allowedSigners);
      if (!check.ok) {
        reason = check.reason;
      } else if (ledger.hasEntry(voucher.payload.id)) {
        reason = "voucher already imported";
      } else {
        ledger.record({
          id: voucher.payload.id,
          kind: "transfer_in",
          deltaCents: voucher.payload.amountCents,
          counterparty: voucher.payload.from,
          note: voucher.payload.note || "credit voucher",
        });
        result.imported++;
      }
    } catch (err: any) {
      reason = `unreadable voucher: ${err?.message || err}`;
    }

    const targetDir = reason ? rejectedDir : processedDir;
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.renameSync(full, path.join(targetDir, file));
    } catch {
      // If the move fails the PRIMARY KEY still prevents a double import.
    }
    if (reason) result.rejected.push({ file, reason });
  }
  return result;
}
