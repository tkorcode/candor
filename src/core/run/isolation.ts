import { chmodSync, chownSync, copyFileSync, lchownSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * How the worker is kept away from Candor. On a computer, Claude Code's own sandbox does it (D-024). In a container
 * where that sandbox cannot start, the operating system does it with separate users instead:
 * - Candor, its secret, its ledger and its check scripts belong to root.
 * - Claude Code runs as the agent user. Its hooks run as agent too, and only agent may open the daemon socket.
 * - Every shell command of Claude Code runs as the worker user, through CLAUDE_CODE_SHELL_PREFIX, so the worker's
 *   commands can open neither the secret nor the socket.
 * - Checks run project code as the worker user, never as root.
 * The container entrypoint sets these variables. With CANDOR_ISOLATION unset, nothing here changes anything.
 */

export interface UserIsolation {
  agent: { uid: number; gid: number; home: string };
  /** gid is the project group: worker and agent both belong to it, so each can change what the other wrote. */
  worker: { uid: number; gid: number };
  shellPrefix: string;
}

const num = (value: string | undefined, name: string): number => {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n <= 0) throw new Error(`CANDOR_ISOLATION=users needs ${name}, a user or group id other than root.`);
  return n;
};

/** The user isolation of this process, or null when the worker is kept away by the sandbox. */
export function userIsolation(env: NodeJS.ProcessEnv = process.env): UserIsolation | null {
  if (env.CANDOR_ISOLATION !== "users") return null;
  if (typeof process.getuid === "function" && process.getuid() !== 0) throw new Error("CANDOR_ISOLATION=users needs Candor to run as root, so the worker cannot reach its files.");
  return {
    agent: { uid: num(env.CANDOR_AGENT_UID, "CANDOR_AGENT_UID"), gid: num(env.CANDOR_AGENT_GID, "CANDOR_AGENT_GID"), home: env.CANDOR_AGENT_HOME ?? "/home/agent" },
    worker: { uid: num(env.CANDOR_WORKER_UID, "CANDOR_WORKER_UID"), gid: num(env.CANDOR_WORKER_GID, "CANDOR_WORKER_GID") },
    shellPrefix: env.CANDOR_SHELL_PREFIX ?? "/opt/candor/as-worker",
  };
}

/**
 * Lets the agent user open the daemon socket, and nobody else but root. The Candor home becomes 0711, so the agent
 * can pass through it to the socket but cannot list it, and every file in it stays readable by root only.
 */
export function shareSocket(socket: string, iso: UserIsolation): void {
  chmodSync(dirname(socket), 0o711);
  chownSync(socket, 0, iso.agent.gid);
  chmodSync(socket, 0o660);
}

/**
 * A copy of the worker settings the agent user can read. Claude Code examines every folder on the path of its
 * settings file and refuses one it cannot examine, and the agent may not examine the Candor home. The copy goes in a
 * folder that root owns and anyone may examine, readable by the agent group and writable only by root.
 */
export function shareWithAgent(file: string, iso: UserIsolation, folder = "/etc/candor"): string {
  mkdirSync(folder, { recursive: true, mode: 0o755 });
  chmodSync(folder, 0o755);
  const copy = join(folder, basename(file));
  copyFileSync(file, copy);
  chownSync(copy, 0, iso.agent.gid);
  chmodSync(copy, 0o640);
  return copy;
}

/** Gives a disposable copy of the workspace to the worker user, so a check runs its code without root. */
export function handToWorker(dir: string, iso: UserIsolation): void {
  lchownSync(dir, iso.worker.uid, iso.worker.gid);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) handToWorker(full, iso);
    else lchownSync(full, iso.worker.uid, iso.worker.gid);
  }
}

/** Gives a project folder to the worker user and the project group, writable by both, as a restart worktree needs. */
export function shareProject(dir: string, iso: UserIsolation): void {
  lchownSync(dir, iso.worker.uid, iso.worker.gid);
  chmodSync(dir, 0o2775);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) shareProject(full, iso);
    else if (entry.isFile()) {
      lchownSync(full, iso.worker.uid, iso.worker.gid);
      chmodSync(full, 0o664);
    }
  }
}

/** Gives a file Candor copied into the agent's Claude Code folder, such as a forked conversation, to the agent user. */
export function giveToAgent(path: string, iso: UserIsolation): void {
  lchownSync(path, iso.agent.uid, iso.agent.gid);
}
