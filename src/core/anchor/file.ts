import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Ledger } from "../ledger/ledger.js";
import { Digest } from "../ledger/types.js";

/**
 * The file anchor. Calling `anchorHead` copies the head hash to a file outside
 * the run store and adds an `anchor` entry to the ledger. The daemon
 * calls it at every checkpoint. Anyone
 * who rewrites the ledger must also rewrite this file. On one machine under
 * one user that is a hurdle, not a wall: the entry is tamper-evident, not
 * tamper-proof. A git anchor is a later step.
 */
export const AnchorRecordSchema = z.object({ run: z.string(), seq: z.number().int().positive(), head: Digest, ts: z.string() }).strict();
export type AnchorRecord = z.infer<typeof AnchorRecordSchema>;

export function readAnchors(path: string): AnchorRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed = AnchorRecordSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error("an anchor line does not match the anchor format");
      return parsed.data;
    });
}

/** Writes the anchor file line first, then the ledger entry, so an anchor never names a head that did not exist. */
export function anchorHead(ledger: Ledger, anchorPath: string, now: () => Date = () => new Date()): AnchorRecord {
  const head = ledger.head();
  if (head.seq === 0) throw new Error("The ledger is empty, so there is nothing to anchor. Append an entry first.");
  const record: AnchorRecord = { run: ledger.run, seq: head.seq, head: head.hash, ts: now().toISOString() };
  mkdirSync(dirname(anchorPath), { recursive: true, mode: 0o700 });
  appendFileSync(anchorPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  ledger.append({ type: "anchor", actor: "candord", body: { anchored_seq: record.seq, anchored_hash: record.head, kind: "file" } });
  return record;
}
