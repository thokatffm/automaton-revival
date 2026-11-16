/**
 * Local x402 seller: the real client (x402Fetch) pays it, and tampered,
 * replayed, mis-priced or unsettled payments are refused.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSeller, type Authorization, type Settler } from "../conway/x402-seller.js";
import { x402Fetch } from "../conway/x402.js";

const SEP_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const URL = "https://seller.test/ping";
const PRICE = 1000n;

const payer = privateKeyToAccount(generatePrivateKey());
const payTo = privateKeyToAccount(generatePrivateKey()).address;

function makeSeller(overrides: { settle?: Settler; now?: () => number } = {}) {
  const settled: Array<{ auth: Authorization; sig: string }> = [];
  const settle: Settler =
    overrides.settle ??
    (async (auth, sig) => {
      settled.push({ auth, sig });
      return "0xtxhash";
    });
  const handle = createSeller({
    payTo,
    asset: SEP_USDC,
    network: "eip155:84532",
    chainId: 84532,
    priceAtomic: PRICE,
    domainName: "USD Coin",
    domainVersion: "2",
    maxTimeoutSeconds: 300,
    resourceUrl: URL,
    settle,
    now: overrides.now,
  });
  return { handle, settled };
}

async function signPayment(over: Partial<Record<string, unknown>> = {}, sigOverride?: string) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
  const message = {
    from: payer.address,
    to: payTo,
    value: PRICE,
    validAfter: now - 60n,
    validBefore: now + 120n,
    nonce: nonce as `0x${string}`,
    ...over,
  } as any;
  const signature =
    sigOverride ??
    (await payer.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: SEP_USDC },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message,
    }));
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: SEP_USDC,
      payTo,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    },
    payload: {
      signature,
      authorization: {
        from: message.from,
        to: message.to,
        value: message.value.toString(),
        validAfter: message.validAfter.toString(),
        validBefore: message.validBefore.toString(),
        nonce: message.nonce,
      },
    },
  };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

describe("x402 seller", () => {
  it("answers an unpaid request with a v2 challenge", async () => {
    const { handle } = makeSeller();
    const res = await handle({});
    expect(res.status).toBe(402);
    const challenge = JSON.parse(Buffer.from(res.headers["PAYMENT-REQUIRED"], "base64").toString("utf8"));
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "1000", payTo });
  });

  it("accepts a payment from the real client and settles it once", async () => {
    const { handle, settled } = makeSeller();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const headers = Object.fromEntries(new Headers(init.headers).entries());
        const out = await handle(headers);
        return new Response(JSON.stringify(out.body), { status: out.status, headers: out.headers });
      }),
    );
    try {
      const res = await x402Fetch(URL, payer, "GET", undefined, undefined, 1, "evm");
      expect(res.success).toBe(true);
      expect(res.response).toMatchObject({ ok: true, transaction: "0xtxhash", payer: payer.address });
      expect(res.settlement).toMatchObject({ success: true, transaction: "0xtxhash", network: "eip155:84532" });
      expect(settled).toHaveLength(1);
      expect(settled[0].auth.from).toBe(payer.address);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a replayed payment", async () => {
    const { handle, settled } = makeSeller();
    const payment = await signPayment();
    const headers = { "payment-signature": b64(payment) };
    expect((await handle(headers)).status).toBe(200);
    const again = await handle(headers);
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: "nonce_already_used" });
    expect(settled).toHaveLength(1);
  });

  it("refuses a payment of the wrong amount", async () => {
    const { handle, settled } = makeSeller();
    const payment = await signPayment({ value: 2000n });
    const res = await handle({ "payment-signature": b64(payment) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_exact_evm_payload_authorization_value_mismatch" });
    expect(settled).toHaveLength(0);
  });

  it("refuses a payment sent to someone else", async () => {
    const { handle } = makeSeller();
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const payment = await signPayment({ to: other });
    const res = await handle({ "payment-signature": b64(payment) });
    expect(res.body).toEqual({ error: "invalid_exact_evm_payload_recipient_mismatch" });
  });

  it("refuses a forged or tampered signature", async () => {
    const { handle, settled } = makeSeller();
    const imposter = privateKeyToAccount(generatePrivateKey());
    const payment = await signPayment();
    // Signed by someone else, but claiming the payer's address
    const forged = await imposter.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: SEP_USDC },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: payer.address,
        to: payTo,
        value: PRICE,
        validAfter: BigInt(payment.payload.authorization.validAfter),
        validBefore: BigInt(payment.payload.authorization.validBefore),
        nonce: payment.payload.authorization.nonce as `0x${string}`,
      },
    });
    const res = await handle({ "payment-signature": b64({ ...payment, payload: { ...payment.payload, signature: forged } }) });
    expect(res.body).toEqual({ error: "invalid_exact_evm_payload_signature" });
    expect(settled).toHaveLength(0);
  });

  it("refuses expired authorizations", async () => {
    const { handle } = makeSeller();
    const payment = await signPayment();
    const late = () => Number(payment.payload.authorization.validBefore) + 10;
    const { handle: lateHandle } = makeSeller({ now: late });
    const res = await lateHandle({ "payment-signature": b64(payment) });
    expect(res.body).toEqual({ error: "invalid_exact_evm_payload_authorization_valid_before" });
    expect(handle).toBeTypeOf("function");
  });

  it("releases the nonce when settlement fails, so the payer can retry", async () => {
    let fail = true;
    const { handle } = makeSeller({
      settle: async () => {
        if (fail) throw new Error("rpc unavailable");
        return "0xlater";
      },
    });
    const payment = await signPayment();
    const headers = { "payment-signature": b64(payment) };
    const first = await handle(headers);
    expect(first.status).toBe(402);
    expect(first.body).toEqual({ error: "settlement_failed" });
    fail = false;
    const second = await handle(headers);
    expect(second.status).toBe(200);
  });
});

describe("x402 seller guards", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("refuses unknown payloads", async () => {
    const { handle } = makeSeller();
    const res = await handle({ "payment-signature": "not-base64-json" });
    expect(res.status).toBe(400);
  });
});
