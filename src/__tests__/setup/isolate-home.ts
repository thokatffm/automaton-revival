/**
 * Keep the test suite out of the developer's real home directory.
 *
 * Several components default their on-disk root to the user's home:
 * `AgentWorkspace` falls back to `os.homedir()/.automaton/workspace`, and
 * `src/identity/wallet.ts` to `$HOME/.automaton`. Tests that drive the
 * orchestrator without an explicit basePath therefore wrote real
 * directories into `~/.automaton/workspace/` on every run.
 *
 * Pointing HOME at a per-run temp directory fixes this for both code paths:
 * Node's `os.homedir()` returns `$HOME` when it is set on POSIX platforms.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll } from "vitest";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-test-home-"));

process.env.HOME = tmpHome;
if (process.env.USERPROFILE !== undefined) {
  process.env.USERPROFILE = tmpHome;
}

afterAll(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover temp directory is harmless.
  }
});
