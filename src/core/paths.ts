import { homedir } from "node:os";
import { join } from "node:path";

/** Everything that must be trusted lives here, outside any workspace. */
export function candorHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CANDOR_HOME && env.CANDOR_HOME.length > 0 ? env.CANDOR_HOME : join(homedir(), ".candor");
}

export const socketPath = (home: string): string => join(home, "candord.sock");
export const operatorKeyPath = (home: string): string => join(home, "operator.key");
export const statePath = (home: string): string => join(home, "state.json");
export const runDir = (home: string, run: string): string => join(home, "runs", run);
export const ledgerPath = (home: string, run: string): string => join(runDir(home, run), "ledger.jsonl");
export const anchorPath = (home: string, run: string): string => join(home, "anchors", `${run}.jsonl`);
export const blobDirPath = (home: string, run: string): string => join(runDir(home, run), "blobs");
export const receiptKeyPath = (home: string): string => join(home, "receipt.key");
