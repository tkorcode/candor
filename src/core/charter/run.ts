import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEntry } from "../ledger/types.js";
import { loadCharterFile } from "./file.js";
import { type Charter, charterHash } from "./schema.js";

/**
 * Loads the charter a run was approved with. The stored file must match the hash in the first ledger
 * entry. A file that does not match is refused, so an edit made behind the daemon is not obeyed.
 */
export function loadApprovedCharter(runFolder: string, entries: readonly LedgerEntry[]): { charter: Charter; hash: string; file: string } {
  // The charter in force is the last version the operator wrote: the approval, or a later rule_change (R1, D-070).
  if (!entries.some((entry) => entry.type === "charter_approved")) throw new Error("This run has no charter_approved entry, so it was never approved. Approve a charter first: candor charter approve <file>");
  const approved = entries.filter((entry) => (entry.type === "charter_approved" || entry.type === "rule_change") && entry.actor === "operator" && typeof entry.body.version === "number" && typeof entry.body.charter_hash === "string").at(-1);
  if (!approved) throw new Error("This run has no charter version written by the operator.");
  const version = approved.body.version;
  const file = join(runFolder, `charter.v${String(version)}.json`);
  const found = readdirSync(runFolder).includes(`charter.v${String(version)}.json`);
  if (!found) throw new Error(`The charter file ${file} is missing. The run cannot start without the charter it was approved with.`);
  const charter = loadCharterFile(file);
  const hash = charterHash(charter);
  if (hash !== approved.body.charter_hash) {
    throw new Error(`The charter file ${file} does not match the hash recorded when the run was approved. Someone changed it. Do not start the run. Keep both as evidence.`);
  }
  return { charter, hash, file };
}
