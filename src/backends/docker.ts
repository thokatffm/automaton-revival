/**
 * Docker Sandbox Driver (self-hosted backend)
 *
 * Runs an automaton's shell and file operations inside a Docker container
 * and creates/lists/deletes child sandboxes as containers. This replaces
 * Conway Cloud VMs when running self-hosted.
 *
 * Every docker invocation passes its arguments as an argv array (never a
 * host shell string), so values chosen by the agent — container names,
 * file paths, commands — cannot inject into the host shell. Commands the
 * agent runs *inside* the container go through `sh -c`, which is the same
 * trust level as a Conway sandbox.
 */

import { spawn } from "child_process";
import type { ExecResult, SandboxInfo, CreateSandboxOptions } from "../types.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string; timeoutMs?: number },
) => Promise<RunResult>;

/** Label that marks containers managed by this runtime. */
export const SANDBOX_LABEL = "dev.automaton.sandbox";
export const PARENT_LABEL = "dev.automaton.parent";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Default runner: spawn without a shell, capture output, enforce a timeout. */
export const spawnRunner: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ stdout, stderr: `${stderr}\nTimed out after ${options.timeoutMs}ms`, exitCode: 124 });
    }, options.timeoutMs ?? 30_000);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString("utf-8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString("utf-8");
    });
    child.on("error", (err) => finish({ stdout, stderr: err.message, exitCode: 127 }));
    child.on("close", (code) => finish({ stdout, stderr, exitCode: code ?? 1 }));

    if (options.input !== undefined) {
      child.stdin.end(options.input, "utf-8");
    } else {
      child.stdin.end();
    }
  });

/** Docker container names: [a-zA-Z0-9][a-zA-Z0-9_.-]* */
export function isValidContainerName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name);
}

/** Turn an arbitrary label into a safe container-name fragment. */
export function toContainerName(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return (cleaned || "sandbox").slice(0, 100);
}

/** Map "~" to /root, the sandbox home used throughout the runtime. */
export function toContainerPath(filePath: string): string {
  if (filePath === "~") return "/root";
  if (filePath.startsWith("~/")) return `/root/${filePath.slice(2)}`;
  return filePath;
}

export class DockerSandboxDriver {
  constructor(
    private readonly runner: CommandRunner = spawnRunner,
    private readonly dockerBin: string = process.env.DOCKER_BIN || "docker",
  ) {}

  private assertName(name: string): void {
    if (!isValidContainerName(name)) {
      throw new Error(`Invalid container name: ${JSON.stringify(name)}`);
    }
  }

  async exec(container: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    this.assertName(container);
    return this.runner(
      this.dockerBin,
      ["exec", "-w", "/root", container, "sh", "-c", command],
      { timeoutMs: timeoutMs ?? 30_000 },
    );
  }

  async writeFile(container: string, filePath: string, content: string): Promise<void> {
    this.assertName(container);
    const target = toContainerPath(filePath);
    // The path is passed as a positional argument ($1), never spliced into
    // the script, so it cannot break out of the quoting.
    const result = await this.runner(
      this.dockerBin,
      ["exec", "-i", container, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", target],
      { input: content, timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`writeFile ${target} in ${container} failed: ${result.stderr.trim()}`);
    }
  }

  async readFile(container: string, filePath: string): Promise<string> {
    this.assertName(container);
    const target = toContainerPath(filePath);
    const result = await this.runner(this.dockerBin, ["exec", container, "cat", "--", target], {
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`readFile ${target} in ${container} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  /** Start a long-running container that acts as a sandbox. */
  async createSandbox(
    options: CreateSandboxOptions & { image: string; parentId?: string },
  ): Promise<SandboxInfo> {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const name = toContainerName(`${options.name || "automaton-sandbox"}-${suffix}`);
    this.assertName(name);

    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `${SANDBOX_LABEL}=1`,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-w",
      "/root",
    ];
    if (options.parentId) {
      args.push("--label", `${PARENT_LABEL}=${options.parentId}`);
    }
    if (options.memoryMb && options.memoryMb > 0) {
      args.push("--memory", `${Math.floor(options.memoryMb)}m`);
    }
    if (options.vcpu && options.vcpu > 0) {
      args.push("--cpus", String(options.vcpu));
    }
    args.push(options.image, "sleep", "infinity");

    const result = await this.runner(this.dockerBin, args, { timeoutMs: 300_000 });
    if (result.exitCode !== 0) {
      throw new Error(`docker run failed: ${result.stderr.trim()}`);
    }
    return {
      id: name,
      status: "running",
      region: "local-docker",
      vcpu: options.vcpu ?? 0,
      memoryMb: options.memoryMb ?? 0,
      diskGb: options.diskGb ?? 0,
      createdAt: new Date().toISOString(),
    };
  }

  async deleteSandbox(container: string): Promise<void> {
    this.assertName(container);
    const result = await this.runner(this.dockerBin, ["rm", "-f", container], { timeoutMs: 60_000 });
    if (result.exitCode !== 0 && !/No such container/i.test(result.stderr)) {
      throw new Error(`docker rm failed: ${result.stderr.trim()}`);
    }
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const result = await this.runner(
      this.dockerBin,
      ["ps", "-a", "--filter", `label=${SANDBOX_LABEL}=1`, "--format", "{{json .}}"],
      { timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`docker ps failed: ${result.stderr.trim()}`);
    }
    const sandboxes: SandboxInfo[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { Names?: string; State?: string; CreatedAt?: string };
        if (!row.Names) continue;
        sandboxes.push({
          id: row.Names,
          status: row.State || "unknown",
          region: "local-docker",
          vcpu: 0,
          memoryMb: 0,
          diskGb: 0,
          createdAt: row.CreatedAt || "",
        });
      } catch {
        // skip malformed lines
      }
    }
    return sandboxes;
  }

  /** True if the docker CLI is installed and the daemon answers. */
  async isAvailable(): Promise<boolean> {
    const result = await this.runner(this.dockerBin, ["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: 15_000,
    });
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  }
}
