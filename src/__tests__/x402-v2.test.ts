/**
 * x402 protocol v2 client (PAYMENT-REQUIRED / PAYMENT-SIGNATURE), plus the
 * guard that only canonical USDC is ever signed for.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyTypedData } from "viem";
import { x402Fetch } from "../conway/x402.js";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0xb8003C6190AA56EA25309B36107FA41bB9518A5F";
const URL = "https://x402.example.test/ping";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf-8"));

function requirementV2(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000",
    asset: BASE_USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  };
}

describe("x402Fetch with a v2 server", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const requests: Array<{ headers: Record<string, string> }> = [];
  let accepts: Record<string, unknown>[];

  beforeEach(() => {
    requests.length = 0;
    accepts = [requirementV2()];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      requests.push({ headers });
      if (!headers["payment-signature"]) {
        const required = { x402Version: 2, error: "Payment required", resource: { url: URL, description: "ping" }, accepts };
        return new Response(JSON.stringify(required), {
          status: 402,
          headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64(required) },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xabc", network: "eip155:8453", payer: account.address }),
        },
      });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pays with a valid EIP-3009 signature in the PAYMENT-SIGNATURE header", async () => {
    const res = await x402Fetch(URL, account, "GET", undefined, undefined, 1);
    expect(res.success).toBe(true);
    expect(res.settlement).toEqual({ success: true, transaction: "0xabc", network: "eip155:8453", payer: account.address });

    const paid = requests[1].headers;
    expect(paid["x-payment"]).toBeUndefined();
    const payload = unb64(paid["payment-signature"]);
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(requirementV2());
    expect(payload.resource).toEqual({ url: URL, description: "ping" });

    const auth = payload.payload.authorization;
    expect(auth).toMatchObject({ from: account.address, to: PAY_TO, value: "1000" });
    for (const k of ["value", "validAfter", "validBefore", "nonce"]) expect(typeof auth[k]).toBe("string");

    const valid = await verifyTypedData({
      address: account.address,
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC },
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
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature: payload.payload.signature,
    });
    expect(valid).toBe(true);
  });

  it("refuses to sign for anything but canonical USDC", async () => {
    accepts = [requirementV2({ asset: "0x1111111111111111111111111111111111111111" })];
    const res = await x402Fetch(URL, account, "GET", undefined, undefined, 1);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Could not parse payment requirements/);
    expect(requests).toHaveLength(1);
  });

  it("refuses amounts above the limit before signing", async () => {
    accepts = [requirementV2({ amount: "50000" })]; // 0.05 USDC = 5 cents
    const res = await x402Fetch(URL, account, "GET", undefined, undefined, 1);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/exceeds max allowed 1 cents/);
    expect(requests).toHaveLength(1);
  });

  it("skips payment flows it does not implement", async () => {
    accepts = [requirementV2({ extra: { name: "USD Coin", version: "2", paymentFlow: "escrow" } })];
    const res = await x402Fetch(URL, account, "GET", undefined, undefined, 1);
    expect(res.success).toBe(false);
    expect(requests).toHaveLength(1);
  });
});
