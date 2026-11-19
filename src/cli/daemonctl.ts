import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerPath, socketPath } from "../core/paths.js";
import { callDaemon } from "../daemon/client.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface DaemonHandle {
  run: string;
  socket: string;
  /** Stops the daemon if this call started it. A daemon that was already running is left alone. */
  stop(): Promise<void>;
}

/**
 * Gives an operator command a daemon to talk to. The daemon of a run ends with `candor run`, so the
 * commands that work on a finished or paused run start it again from the ledger, and stop it when done.
 */
export async function ensureDaemon(home: string, run: string | undefined, waitForDaemon: (socket: string, child: ChildProcess) => Promise<void>): Promise<DaemonHandle> {
  const socket = socketPath(home);
  const live = await callDaemon({ socket, method: "GET", path: "/state" }).then(
    (r) => r.body as { run?: string },
    () => null,
  );
  if (live?.run) {
    if (run && live.run !== run) throw new Error(`candord is serving run ${live.run}, not ${run}. Stop it first.`);
    return { run: live.run, socket, stop: async () => undefined };
  }
  if (!run) throw new Error("Which run? Give --run <id>. No candord is running to say which one.");
  if (!existsSync(ledgerPath(home, run))) throw new Error(`Run ${run} does not exist.`);
  if (!existsSync(join(root, "dist", "cli", "main.js"))) throw new Error("Candor is not built. Run: npm run build");
  const child = spawn(process.execPath, [join(root, "bin", "candord.js"), "--run", run], { env: { ...process.env, CANDOR_HOME: home }, stdio: ["ignore", "inherit", "inherit"] });
  const kill = (): void => {
    child.kill("SIGTERM");
  };
  process.once("SIGINT", kill);
  try {
    await waitForDaemon(socket, child);
  } catch (error) {
    kill();
    throw error;
  }
  return {
    run,
    socket,
    stop: async () => {
      process.removeListener("SIGINT", kill);
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      kill();
      await Promise.race([exited, new Promise<void>((done) => setTimeout(done, 3000))]);
    },
  };
}
