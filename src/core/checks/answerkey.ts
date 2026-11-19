import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeCopy, removeCopy, runShell } from "./run.js";

/**
 * The answer key comparison. The answer key folder in the run store may hold `compare.js`. At the end of a
 * run it is run against a disposable copy of the final workspace, with CANDOR_ORACLE_DIR set. Exit 0 means the
 * final state matches the answer key, 1 means it differs, anything else means the comparison broke. It is
 * separate from the acceptance checks of the charter, so a weak check shows up as a verified result that the
 * key says is wrong. It never reaches the worker: the folder is outside the workspace and denied to reads.
 */
export type KeyComparison = { status: "matches" | "differs" | "error" | "not_compared"; detail: string; output: string };

export async function compareWithAnswerKey(oracleDir: string, workspace: string, pristineChecks: string | null, timeoutMs: number): Promise<KeyComparison> {
  const script = join(oracleDir, "compare.js");
  if (!existsSync(script)) return { status: "not_compared", detail: "The answer key folder has no compare.js, so the final state was not compared with the answer key.", output: "" };
  const copy = makeCopy(workspace, pristineChecks);
  try {
    const result = await runShell(`"${process.execPath}" "${script}"`, copy, { CANDOR_ORACLE_DIR: oracleDir }, timeoutMs);
    if (result.exitCode === 0) return { status: "matches", detail: "The final state matches the answer key.", output: result.output };
    if (result.exitCode === 1) return { status: "differs", detail: "The final state differs from the answer key.", output: result.output };
    return { status: "error", detail: "The comparison with the answer key did not finish.", output: result.output };
  } finally {
    removeCopy(copy);
  }
}
