/**
 * Docker driver argv handling + self-hosted ConwayClient behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { DockerSandboxDriver, type CommandRunner, type RunResult } from "../../backends/docker.js";
import { createSelfHostedClient, SelfHostedUnsupportedError } from "../../backends/self-hosted-client.js";
import { CreditLedger } from "../../backends/ledger.js";
import { verifyVoucher } from "../../backends/vouchers.js";

interface Call {
  command: string;
  args: string[];
  input?: string;
}

function fakeRunner(respond: (call: Call) => Partial<RunResult> = () => ({})) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    const call = { command, args, input: options?.input };
    calls.push(call);
    return { stdout: "", stderr: "", exitCode: 0, ...respond(call) };
  };
  return { calls, runner };
}

describe("DockerSandboxDriver", () => {
  it("passes commands and paths as argv, never through a host shell", async () => {
    const { calls, runner } = fakeRunner();
    const driver = new DockerSandboxDriver(runner, "docker");

    await driver.exec("agent-1", "echo hi; rm -rf /tmp/x");
    expect(calls[0].args).toEqual(["exec", "-w", "/root", "agent-1", "sh", "-c", "echo hi; rm -rf /tmp/x"]);

    const evilPath = `~/x"; touch /pwned; echo "`;
    await driver.writeFile("agent-1", evilPath, "content");
    const w = calls[1];
    // script is constant, the path is a separate positional argument
    expect(w.args.slice(0, 6)).toEqual(["exec", "-i", "agent-1", "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"']);
    expect(w.args[7]).toBe(`/root/x"; touch /pwned; echo "`);
    expect(w.input).toBe("content");
  });

  it("rejects container names that are not plain docker names", async () => {
    const { runner } = fakeRunner();
    const driver = new DockerSandboxDriver(runner);
    await expect(driver.exec("--privileged", "id")).rejects.toThrow(/Invalid container name/);
    await expect(driver.deleteSandbox("a b")).rejects.toThrow(/Invalid container name/);
  });

  it("creates labelled, resource-limited child containers", async () => {
    const { calls, runner } = fakeRunner();
    const driver = new DockerSandboxDriver(runner);
    const info = await driver.createSandbox({
      name: "Automaton Child!",
      memoryMb: 1024,
      vcpu: 1,
      image: "node:22-bookworm",
      parentId: "0xparent",
    });
    expect(info.id).toMatch(/^automaton-child-/);
    const args = calls[0].args;
    expect(args).toContain("dev.automaton.sandbox=1");
    expect(args).toContain("dev.automaton.parent=0xparent");
    expect(args.join(" ")).toContain("--memory 1024m");
    expect(args.slice(-3)).toEqual(["node:22-bookworm", "sleep", "infinity"]);
  });

  it("parses docker ps JSON lines", async () => {
    const { runner } = fakeRunner(() => ({
      stdout: '{"Names":"child-a","State":"running"}\n{"Names":"child-b","State":"exited"}\nnot json\n',
    }));
    const list = await new DockerSandboxDriver(runner).listSandboxes();
    expect(list.map((s) => [s.id, s.status])).toEqual([
      ["child-a", "running"],
      ["child-b", "exited"],
    ]);
  });
});

describe("createSelfHostedClient", () => {
  const parent = privateKeyToAccount(generatePrivateKey());
  const child = privateKeyToAccount(generatePrivateKey());
  let home: string;
  let db: Database.Database;
  let ledger: CreditLedger;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "selfhosted-home-"));
    db = new Database(":memory:");
    ledger = new CreditLedger(db);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("local mode maps the sandbox home /root and ~ to the host home", async () => {
    const client = createSelfHostedClient({
      mode: "local",
      dockerImage: "node:22",
      selfAddress: parent.address,
      ledger,
      home,
    });
    await client.writeFile("/root/notes/a.txt", "one");
    await client.writeFile("~/notes/b.txt", "two");
    expect(fs.readFileSync(path.join(home, "notes", "a.txt"), "utf-8")).toBe("one");
    expect(await client.readFile("/root/notes/b.txt")).toBe("two");
  });

  it("reports the ledger balance as credits", async () => {
    ledger.record({ kind: "fund", deltaCents: 700 });
    const client = createSelfHostedClient({ mode: "local", dockerImage: "x", selfAddress: parent.address, ledger, home });
    expect(await client.getCreditsBalance()).toBe(700);
  });

  it("transfers credits to a known child as a signed voucher", async () => {
    ledger.record({ kind: "fund", deltaCents: 1000 });
    const { calls, runner } = fakeRunner();
    const client = createSelfHostedClient({
      mode: "local",
      dockerImage: "x",
      selfAddress: parent.address,
      account: parent,
      ledger,
      home,
      driver: new DockerSandboxDriver(runner),
      resolveSandboxForAddress: (a) => (a === child.address ? "child-box" : undefined),
    });

    const res = await client.transferCredits(child.address, 400, "allowance");
    expect(res.balanceAfterCents).toBe(600);
    expect(ledger.getBalanceCents()).toBe(600);

    const write = calls.find((c) => c.args[0] === "exec" && c.args[1] === "-i")!;
    expect(write.args[2]).toBe("child-box");
    expect(write.args[7]).toBe(`/root/.automaton/credit-vouchers/${res.transferId}.json`);
    const voucher = JSON.parse(write.input!);
    expect(await verifyVoucher(voucher, child.address, [parent.address])).toEqual({ ok: true });
  });

  it("refuses transfers to unknown addresses without debiting", async () => {
    ledger.record({ kind: "fund", deltaCents: 1000 });
    const client = createSelfHostedClient({
      mode: "local",
      dockerImage: "x",
      selfAddress: parent.address,
      account: parent,
      ledger,
      home,
      resolveSandboxForAddress: () => undefined,
    });
    await expect(client.transferCredits(child.address, 100)).rejects.toThrow(/No known sandbox/);
    expect(ledger.getBalanceCents()).toBe(1000);
  });

  it("refunds the debit when the voucher cannot be delivered", async () => {
    ledger.record({ kind: "fund", deltaCents: 1000 });
    const { runner } = fakeRunner(() => ({ exitCode: 1, stderr: "No such container" }));
    const client = createSelfHostedClient({
      mode: "local",
      dockerImage: "x",
      selfAddress: parent.address,
      account: parent,
      ledger,
      home,
      driver: new DockerSandboxDriver(runner),
      resolveSandboxForAddress: () => "gone-box",
    });
    await expect(client.transferCredits(child.address, 300)).rejects.toThrow();
    expect(ledger.getBalanceCents()).toBe(1000);
  });

  it("scoped child clients cannot touch the parent's credits", async () => {
    ledger.record({ kind: "fund", deltaCents: 1000 });
    const client = createSelfHostedClient({ mode: "local", dockerImage: "x", selfAddress: parent.address, ledger, home });
    const scoped = client.createScopedClient("child-box");
    await expect(scoped.getCreditsBalance()).rejects.toThrow(/scoped/);
    await expect(scoped.transferCredits(child.address, 1)).rejects.toThrow(/scoped/);
  });

  it("domains are unsupported with a clear error, registration is a local no-op", async () => {
    const client = createSelfHostedClient({ mode: "local", dockerImage: "x", selfAddress: parent.address, ledger, home });
    await expect(client.searchDomains("x")).rejects.toBeInstanceOf(SelfHostedUnsupportedError);
    const reg = await client.registerAutomaton({
      automatonId: "id",
      automatonAddress: parent.address,
      creatorAddress: parent.address,
      name: "n",
      account: parent,
    });
    expect(reg.automaton.backend).toBe("self-hosted");
  });

  it("docker mode refuses to delete its own container", async () => {
    const { runner } = fakeRunner();
    const client = createSelfHostedClient({
      mode: "docker",
      containerName: "me",
      dockerImage: "x",
      selfAddress: parent.address,
      ledger,
      driver: new DockerSandboxDriver(runner),
    });
    await expect(client.deleteSandbox("me")).rejects.toThrow(/own sandbox/);
  });
});
