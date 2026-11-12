/**
 * Real-Docker integration test for the self-hosted backend.
 *
 * Opt-in: it starts and removes real containers, so it only runs with
 *   AUTOMATON_DOCKER_IT=1 pnpm vitest run src/__tests__/backends/docker.integration.test.ts
 * The image defaults to alpine:3.20 (small); override with AUTOMATON_DOCKER_IT_IMAGE.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { DockerSandboxDriver } from "../../backends/docker.js";
import { createSelfHostedClient } from "../../backends/self-hosted-client.js";
import { CreditLedger } from "../../backends/ledger.js";
import { verifyVoucher } from "../../backends/vouchers.js";

const ENABLED = process.env.AUTOMATON_DOCKER_IT === "1";
const IMAGE = process.env.AUTOMATON_DOCKER_IT_IMAGE || "alpine:3.20";

describe.skipIf(!ENABLED)("Docker sandbox driver (real daemon)", () => {
  const driver = new DockerSandboxDriver();
  const created: string[] = [];
  let box: string;

  beforeAll(async () => {
    expect(await driver.isAvailable()).toBe(true);
    const info = await driver.createSandbox({
      name: "automaton-it",
      memoryMb: 256,
      vcpu: 1,
      image: IMAGE,
      parentId: "0xintegration",
    });
    box = info.id;
    created.push(box);
  }, 300_000);

  afterAll(async () => {
    for (const name of created) {
      await driver.deleteSandbox(name).catch(() => {});
    }
  }, 120_000);

  it("runs shell commands in /root", async () => {
    const res = await driver.exec(box, "pwd && echo $((6 * 7))");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim().split(/\r?\n/)).toEqual(["/root", "42"]);
  });

  it("reports non-zero exit codes and stderr", async () => {
    const res = await driver.exec(box, "echo oops >&2; exit 3");
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("oops");
  });

  it("writes and reads files, creating parent directories", async () => {
    const content = "line 1\nümlaut ✓\n$(not expanded) `nor this`\n";
    await driver.writeFile(box, "~/deep/nested/dir/file.txt", content);
    expect(await driver.readFile(box, "/root/deep/nested/dir/file.txt")).toBe(content);
  });

  it("treats a hostile path as a literal filename", async () => {
    const evil = `~/x"; touch /root/pwned; echo "`;
    await driver.writeFile(box, evil, "safe");
    const pwned = await driver.exec(box, "test -e /root/pwned && echo yes || echo no");
    expect(pwned.stdout.trim()).toBe("no");
    expect(await driver.readFile(box, evil)).toBe("safe");
  });

  it("lists the container with its sandbox label", async () => {
    const list = await driver.listSandboxes();
    expect(list.find((s) => s.id === box)?.status).toBe("running");
  });

  it("delivers a signed credit voucher into a child container", async () => {
    const parent = privateKeyToAccount(generatePrivateKey());
    const child = privateKeyToAccount(generatePrivateKey());
    const db = new Database(":memory:");
    const ledger = new CreditLedger(db);
    ledger.record({ kind: "fund", deltaCents: 1000 });

    const client = createSelfHostedClient({
      mode: "docker",
      containerName: "unused-parent-box",
      dockerImage: IMAGE,
      selfAddress: parent.address,
      account: parent,
      ledger,
      driver,
      resolveSandboxForAddress: (a) => (a === child.address ? box : undefined),
    });

    const res = await client.transferCredits(child.address, 250, "allowance");
    expect(ledger.getBalanceCents()).toBe(750);

    const raw = await driver.readFile(box, `/root/.automaton/credit-vouchers/${res.transferId}.json`);
    expect(await verifyVoucher(JSON.parse(raw), child.address, [parent.address])).toEqual({ ok: true });
    db.close();
  });

  it("deletes the container and tolerates deleting it twice", async () => {
    const extra = await driver.createSandbox({ name: "automaton-it-del", image: IMAGE });
    created.push(extra.id);
    await driver.deleteSandbox(extra.id);
    await driver.deleteSandbox(extra.id);
    const list = await driver.listSandboxes();
    expect(list.some((s) => s.id === extra.id)).toBe(false);
  }, 120_000);
});
