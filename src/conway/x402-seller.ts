/**
 * x402 v2 seller: answers unpaid requests with HTTP 402, verifies the EIP-3009
 * payment a client signs, and settles it through a pluggable settler.
 *
 * Local only. Nothing here opens a port; startLocalSeller binds to 127.0.0.1.
 */

import http from "http";
import {
  createPublicClient,
  createWalletClient,
  http as viemHttp,
  parseSignature,
  verifyTypedData,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { baseSepolia } from "viem/chains";

export interface Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export type Settler = (authorization: Authorization, signature: Hex) => Promise<string>;

export interface SellerOptions {
  /** Address that receives the payment (the automaton's own wallet). */
  payTo: Address;
  /** Token contract (USDC). */
  asset: Address;
  /** CAIP-2 network id, e.g. "eip155:84532". */
  network: string;
  chainId: number;
  /** Price in atomic units (6 decimals): 1000 = 0.001 USDC. */
  priceAtomic: bigint;
  /** EIP-712 domain name and version of the token. */
  domainName: string;
  domainVersion: string;
  maxTimeoutSeconds: number;
  resourceUrl: string;
  settle: Settler;
  now?: () => number;
}

export interface SellerResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function unb64(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function createSeller(opts: SellerOptions): (headers: Record<string, string | undefined>) => Promise<SellerResponse> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const usedNonces = new Set<string>();

  const requirement = {
    scheme: "exact",
    network: opts.network,
    amount: opts.priceAtomic.toString(),
    asset: opts.asset,
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds,
    extra: { name: opts.domainName, version: opts.domainVersion },
  };
  const challenge = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: opts.resourceUrl, mimeType: "application/json" },
    accepts: [requirement],
  };
  const challengeHeader = b64(challenge);

  const reject = (status: number, reason: string, extra: Record<string, unknown> = {}): SellerResponse => ({
    status,
    headers: {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": challengeHeader,
      "PAYMENT-RESPONSE": b64({ success: false, errorReason: reason, transaction: "", network: opts.network, ...extra }),
    },
    body: { error: reason },
  });

  return async function handle(headers) {
    const signature = headers["payment-signature"];
    if (!signature) {
      return { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": challengeHeader }, body: challenge };
    }

    const payload = unb64(signature) as any;
    if (!payload || typeof payload !== "object") return reject(400, "invalid_payload");
    if (payload.x402Version !== 2) return reject(400, "invalid_x402_version");

    const accepted = payload.accepted ?? {};
    if (accepted.scheme !== "exact") return reject(400, "invalid_scheme");
    if (accepted.network !== opts.network) return reject(400, "invalid_network");
    if (String(accepted.payTo ?? "").toLowerCase() !== opts.payTo.toLowerCase()) return reject(400, "invalid_recipient");
    if (String(accepted.asset ?? "").toLowerCase() !== opts.asset.toLowerCase()) return reject(400, "invalid_asset");
    if (String(accepted.amount) !== opts.priceAtomic.toString()) return reject(400, "invalid_amount");

    const inner = payload.payload ?? {};
    const a = inner.authorization ?? {};
    const sig = inner.signature as Hex | undefined;
    if (!sig || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return reject(400, "invalid_exact_evm_payload_signature");

    let authorization: Authorization;
    try {
      authorization = {
        from: a.from as Address,
        to: a.to as Address,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce as Hex,
      };
    } catch {
      return reject(400, "invalid_exact_evm_payload_authorization");
    }

    if (authorization.to.toLowerCase() !== opts.payTo.toLowerCase()) {
      return reject(400, "invalid_exact_evm_payload_recipient_mismatch");
    }
    if (authorization.value !== opts.priceAtomic) {
      return reject(400, "invalid_exact_evm_payload_authorization_value_mismatch");
    }
    const t = now();
    if (authorization.validAfter > BigInt(t)) return reject(400, "invalid_exact_evm_payload_authorization_valid_after");
    if (authorization.validBefore <= BigInt(t)) return reject(400, "invalid_exact_evm_payload_authorization_valid_before");
    if (!/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)) return reject(400, "invalid_exact_evm_payload_authorization");

    const valid = await verifyTypedData({
      address: authorization.from,
      domain: {
        name: opts.domainName,
        version: opts.domainVersion,
        chainId: opts.chainId,
        verifyingContract: opts.asset,
      },
      types: TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization",
      message: authorization,
      signature: sig,
    }).catch(() => false);
    if (!valid) return reject(400, "invalid_exact_evm_payload_signature");

    // A nonce can only be spent once. Reserve it before settling, release it
    // only if the settlement itself fails (then no money has moved).
    const nonceKey = authorization.nonce.toLowerCase();
    if (usedNonces.has(nonceKey)) return reject(400, "nonce_already_used");
    usedNonces.add(nonceKey);

    let transaction: string;
    try {
      transaction = await opts.settle(authorization, sig);
    } catch (err: any) {
      usedNonces.delete(nonceKey);
      return reject(402, "settlement_failed", { message: String(err?.message ?? err).slice(0, 200) });
    }

    return {
      status: 200,
      headers: {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": b64({ success: true, transaction, network: opts.network, payer: authorization.from }),
      },
      body: { ok: true, message: "Payment verified and settled.", transaction, payer: authorization.from },
    };
  };
}

/**
 * Start the seller on 127.0.0.1 only. Not started anywhere automatically.
 */
export function startLocalSeller(
  handle: (headers: Record<string, string | undefined>) => Promise<SellerResponse>,
  port: number,
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }
    const out = await handle(headers);
    res.writeHead(out.status, out.headers);
    res.end(JSON.stringify(out.body));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/** EIP-3009 entry point of USDC (FiatToken v2), v/r/s overload. */
const USDC_TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/** Minimal client surface the settler needs; injectable for tests. */
export interface SettlerClients {
  writeContract: (args: any) => Promise<Hex>;
  waitForTransactionReceipt: (args: { hash: Hex }) => Promise<{ status: "success" | "reverted" }>;
}

export interface OnchainSettlerOptions {
  /** Wallet that submits the transaction and pays its gas (the seller). */
  account: PrivateKeyAccount;
  /** USDC contract on the chosen chain. */
  asset: Address;
  /** Defaults to Base Sepolia (testnet). */
  chain?: Chain;
  rpcUrl?: string;
  /** Settling real money is refused unless this is set explicitly. */
  allowMainnet?: boolean;
  clients?: SettlerClients;
}

/**
 * Settle a verified payment by submitting the payer's signed authorization to
 * the USDC contract. The seller pays the gas; the USDC moves from payer to
 * payTo as signed. Testnet only unless allowMainnet is set.
 */
export function makeOnchainSettler(opts: OnchainSettlerOptions): Settler {
  const chain = opts.chain ?? baseSepolia;
  if (chain.id !== baseSepolia.id && !opts.allowMainnet) {
    throw new Error(`On-chain settlement on chain ${chain.id} needs allowMainnet: true. Only Base Sepolia is allowed by default.`);
  }

  const clients: SettlerClients =
    opts.clients ??
    (() => {
      const transport = viemHttp(opts.rpcUrl);
      const wallet = createWalletClient({ account: opts.account, chain, transport });
      const pub = createPublicClient({ chain, transport });
      return {
        writeContract: (args) => wallet.writeContract(args),
        waitForTransactionReceipt: (args) => pub.waitForTransactionReceipt(args),
      };
    })();

  return async (auth, signature) => {
    const { r, s, v, yParity } = parseSignature(signature);
    const vNumber = v !== undefined ? Number(v) : yParity + 27;
    const hash = await clients.writeContract({
      address: opts.asset,
      abi: USDC_TRANSFER_WITH_AUTHORIZATION_ABI,
      functionName: "transferWithAuthorization",
      args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, vNumber, r, s],
      account: opts.account,
      chain,
    });
    const receipt = await clients.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Settlement transaction reverted: ${hash}`);
    }
    return hash;
  };
}
