/**
 * State Versioning
 *
 * Version control the automaton's own state files (~/.automaton/).
 * Every self-modification triggers a git commit with a descriptive message.
 * The automaton's entire identity history is version-controlled and replayable.
 */

import type { ConwayClient, AutomatonDatabase } from "../types.js";
import { gitInit, gitCommit, gitStatus, gitLog } from "./tools.js";

const AUTOMATON_DIR = "~/.automaton";

function resolveHome(p: string): string {
  const home = process.env.HOME || "/root";
  if (p.startsWith("~")) {
    return `${home}${p.slice(1)}`;
  }
  return p;
}

/**
 * Initialize git repo for the automaton's state directory.
 * Creates .gitignore to exclude sensitive files.
 */
export async function initStateRepo(
  conway: ConwayClient,
): Promise<void> {
  const dir = resolveHome(AUTOMATON_DIR);

  // Check if already initialized
  const checkResult = await conway.exec(
    `test -d ${dir}/.git && echo "exists" || echo "nope"`,
    5000,
  );

  if (checkResult.stdout.trim() === "exists") {
    return;
  }

  // Initialize
  await gitInit(conway, dir);

  // Create .gitignore for sensitive files.
  //
  // The list must name the files this codebase actually writes, not files we
  // assume exist. In particular the runtime config is `automaton.json`
  // (src/config.ts CONFIG_FILENAME) and it holds `conwayApiKey` plus any
  // provider keys. `config.json` is a *different*, much smaller file written
  // only by identity/provision.ts, so listing it alone left the real secrets
  // tracked and eligible for the genesis commit.
  //
  // `inference-providers.json` lives at ~/.automaton/ and carries BYOK keys,
  // so it is listed for the same reason.
  //
  // Deliberately an explicit list rather than `*.json`: the state repo exists
  // to version an agent's evolution (SOUL.md, WORKLOG.md, skills, heartbeat
  // config, and non-secret JSON like genesis.json), so a blanket ignore would
  // silently drop legitimate state and make commits appear to be no-ops.
  const gitignore = `# Sensitive files - never commit
wallet.json
config.json
automaton.json
inference-providers.json
state.db
state.db-wal
state.db-shm
*.db
*.db-journal
*.db-wal
*.db-shm
logs/
*.log
*.err
.env
`;

  await conway.writeFile(`${dir}/.gitignore`, gitignore);

  // Configure git user
  await conway.exec(
    `cd ${dir} && git config user.name "Automaton" && git config user.email "automaton@conway.tech"`,
    5000,
  );

  // Initial commit
  await gitCommit(conway, dir, "genesis: automaton state repository initialized");
}

/**
 * Commit a state change with a descriptive message.
 * Called after any self-modification.
 */
export async function commitStateChange(
  conway: ConwayClient,
  description: string,
  category: string = "state",
): Promise<string> {
  const dir = resolveHome(AUTOMATON_DIR);

  // Check if there are changes
  const status = await gitStatus(conway, dir);
  if (status.clean) {
    return "No changes to commit";
  }

  const message = `${category}: ${description}`;
  const result = await gitCommit(conway, dir, message);
  return result;
}

/**
 * Commit after a SOUL.md update.
 */
export async function commitSoulUpdate(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "soul");
}

/**
 * Commit after a skill installation or removal.
 */
export async function commitSkillChange(
  conway: ConwayClient,
  skillName: string,
  action: "install" | "remove" | "update",
): Promise<string> {
  return commitStateChange(
    conway,
    `${action} skill: ${skillName}`,
    "skill",
  );
}

/**
 * Commit after heartbeat config change.
 */
export async function commitHeartbeatChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "heartbeat");
}

/**
 * Commit after config change.
 */
export async function commitConfigChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "config");
}

/**
 * Get the state repo history.
 */
export async function getStateHistory(
  conway: ConwayClient,
  limit: number = 20,
) {
  const dir = resolveHome(AUTOMATON_DIR);
  return gitLog(conway, dir, limit);
}
