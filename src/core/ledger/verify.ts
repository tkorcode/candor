import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, digest } from "../canonical.js";
import { type AnchorRecord, readAnchors } from "../anchor/file.js";
import { ALLOWED_ACTORS, BODY_SCHEMAS, EntrySchema, GENESIS, type LedgerEntry } from "./types.js";

export type VerifyResult =
  | { ok: true; entries: number; head: string; anchorEntries: number }
  | { ok: false; firstBadSeq: number; reason: string };

/** The hash of an entry: SHA-256 over the canonical JSON of the entry without `hash`. */
export function entryHash(entry: Omit<LedgerEntry, "hash">): string {
  return digest(entry);
}

export interface VerifyOptions {
  /** Anchor records from outside the run store. Without them only the internal chain is checked. */
  anchors?: AnchorRecord[];
  /** The run the ledger must belong to. Without it the run of the first entry is trusted. */
  expectedRun?: string;
  /** Blob store folder. When given, every blob an entry names must exist and match its digest. */
  blobDir?: string;
}

function blobRefs(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) blobRefs(item, found);
  else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$blob === "string" && typeof record.bytes === "number") found.push(record.$blob);
    else for (const item of Object.values(record)) blobRefs(item, found);
  }
  return found;
}

/**
 * Checks the chain, entry by entry, and names the first bad sequence number.
 * An edit, a deletion, an insertion and a swap all break the chain at the
 * position where they happen. A chain rewritten from some point on with fresh
 * hashes passes the internal checks, so only an anchor kept elsewhere can
 * catch it. That is what tamper-evident means here.
 */
/** Splits file text into lines. Only the final newline is dropped, so a blank line in the middle fails verification. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function verifyLines(lines: string[], options: VerifyOptions = {}): VerifyResult {
  const bad = (firstBadSeq: number, reason: string): VerifyResult => ({ ok: false, firstBadSeq, reason });
  let prev = GENESIS;
  let run: string | null = options.expectedRun ?? null;
  const entries: LedgerEntry[] = [];

  for (const [index, line] of lines.entries()) {
    const expected = index + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return bad(expected, `Line ${expected} is not valid JSON.`);
    }
    const parsed = EntrySchema.safeParse(raw);
    if (!parsed.success) return bad(expected, `Entry ${expected} does not match the entry schema: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
    const entry = parsed.data;
    if (line !== canonicalJson(entry)) return bad(expected, `Line ${expected} is not in canonical form, so the file was rewritten by something other than the ledger writer.`);
    if (entry.seq !== expected) return bad(expected, `Expected sequence number ${expected} and found ${entry.seq}. An entry was removed, inserted or moved.`);
    if (entry.prev !== prev) return bad(expected, `Entry ${expected} does not point at the hash of the entry before it.`);
    const { hash, ...rest } = entry;
    if (entryHash(rest) !== hash) return bad(expected, `Entry ${expected} was changed: its hash does not match its content.`);
    if (run === null) run = entry.run;
    else if (entry.run !== run) return bad(expected, `Entry ${expected} belongs to run ${entry.run}, not run ${run}.`);
    if (!ALLOWED_ACTORS[entry.type].includes(entry.actor)) return bad(expected, `Entry ${expected} has type ${entry.type} written by ${entry.actor}, which is not allowed to write it.`);
    const bodySchema = BODY_SCHEMAS[entry.type];
    if (bodySchema && !bodySchema.safeParse(entry.body).success) return bad(expected, `Entry ${expected} has a ${entry.type} body that does not match its schema.`);
    if (entry.type === "anchor") {
      const at = entry.body.anchored_seq as number;
      if (at >= entry.seq || entries[at - 1]?.hash !== entry.body.anchored_hash) return bad(expected, `Entry ${expected} is an anchor that does not match the entry it names.`);
    }
    if (options.blobDir) {
      for (const ref of blobRefs(entry.body)) {
        const file = join(options.blobDir, ref.replace("sha256:", ""));
        if (!existsSync(file)) return bad(expected, `Entry ${expected} names blob ${ref}, which is missing.`);
        if (`sha256:${digestBytes(readFileSync(file))}` !== ref) return bad(expected, `Entry ${expected} names blob ${ref}, whose content has changed.`);
      }
    }
    entries.push(entry);
    prev = hash;
  }

  for (const anchor of options.anchors ?? []) {
    if (run !== null && anchor.run !== run) continue;
    if (anchor.seq > entries.length) return bad(entries.length + 1, `The ledger ends at entry ${entries.length}, but an anchor was recorded at entry ${anchor.seq}. The ledger was cut short.`);
    if (entries[anchor.seq - 1]?.hash !== anchor.head) return bad(anchor.seq, `The ledger at entry ${anchor.seq} does not match the anchor recorded outside it. The chain up to that point was rewritten.`);
  }
  if (options.anchors) {
    for (const entry of entries) {
      if (entry.type !== "anchor") continue;
      const seq = entry.body.anchored_seq;
      const known = options.anchors.some((a) => a.run === entry.run && a.seq === seq && a.head === entry.body.anchored_hash);
      if (!known) return bad(entry.seq, `Entry ${entry.seq} records an anchor that is missing from the anchor file.`);
    }
  }
  return { ok: true, entries: entries.length, head: prev, anchorEntries: entries.filter((e) => e.type === "anchor").length };
}

function digestBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads a ledger file and verifies it. A missing file is a failure, not an empty ledger. */
export function verifyFile(path: string, options: { anchorsPath?: string; blobDir?: string; expectedRun?: string } = {}): VerifyResult {
  if (!existsSync(path)) return { ok: false, firstBadSeq: 1, reason: `There is no ledger at ${path}.` };
  const lines = splitLines(readFileSync(path, "utf8"));
  let anchors: AnchorRecord[] | undefined;
  if (options.anchorsPath && existsSync(options.anchorsPath)) {
    try {
      anchors = readAnchors(options.anchorsPath);
    } catch (error) {
      return { ok: false, firstBadSeq: 1, reason: `The anchor file ${options.anchorsPath} cannot be read: ${error instanceof Error ? error.message : "invalid"}` };
    }
  }
  const result = verifyLines(lines, { anchors, blobDir: options.blobDir, expectedRun: options.expectedRun });
  if (result.ok && result.anchorEntries > 0 && anchors === undefined) {
    return { ok: false, firstBadSeq: 1, reason: `The ledger records ${result.anchorEntries} anchor${result.anchorEntries === 1 ? "" : "s"}, but there is no anchor file to check them against. A missing anchor file is treated as a failure, not as no anchors.` };
  }
  return result;
}

export { canonicalJson };
