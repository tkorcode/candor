import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "../canonical.js";
import { createRedactor, type Redactor } from "./redact.js";
import { ALLOWED_ACTORS, BODY_SCHEMAS, type Actor, type BlobRef, type EntryType, type LedgerEntry, GENESIS } from "./types.js";
import { entryHash, splitLines, verifyLines } from "./verify.js";

/** Strings longer than this go to the blob store and the entry carries the digest. */
export const MAX_INLINE_BYTES = 4096;

export interface LedgerOptions {
  path: string;
  run: string;
  /** Folder for large payloads. Defaults to `blobs` beside the ledger. */
  blobDir?: string;
  now?: () => Date;
  redactor?: Redactor;
}

export interface AppendInput {
  type: EntryType;
  actor: Actor;
  body: Record<string, unknown>;
  branch?: string;
}

function hasBlobKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasBlobKey);
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, item]) => key === "$blob" || hasBlobKey(item));
  return false;
}

export class LedgerCorrupt extends Error {
  constructor(
    readonly firstBadSeq: number,
    message: string,
  ) {
    super(message);
    this.name = "LedgerCorrupt";
  }
}

/**
 * The one writer of a ledger file. There is no method that edits, removes or
 * reorders an entry: a correction is a new entry that names the old one by
 * sequence number. Only the daemon process should hold an instance for a live
 * run. Nothing enforces that: the head is cached in memory, so a second writer
 * on the same file would fork the chain. Verification would catch the fork.
 */
export class Ledger {
  readonly run: string;
  readonly path: string;
  readonly blobDir: string;
  private readonly now: () => Date;
  private readonly redactor: Redactor;
  private seq = 0;
  private hash: string = GENESIS;

  private constructor(options: LedgerOptions) {
    this.run = options.run;
    this.path = options.path;
    this.blobDir = options.blobDir ?? join(dirname(options.path), "blobs");
    this.now = options.now ?? (() => new Date());
    this.redactor = options.redactor ?? createRedactor();
  }

  /** Opens a ledger. An existing file is verified first, and a broken chain is refused. */
  static open(options: LedgerOptions): Ledger {
    const ledger = new Ledger(options);
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    if (existsSync(options.path)) {
      const lines = splitLines(readFileSync(options.path, "utf8"));
      const result = verifyLines(lines, { blobDir: ledger.blobDir });
      if (!result.ok) {
        throw new LedgerCorrupt(result.firstBadSeq, `The ledger at ${options.path} does not verify: ${result.reason} Do not append to it. Start a new run, and keep this file as evidence.`);
      }
      ledger.seq = result.entries;
      ledger.hash = result.head;
    }
    return ledger;
  }

  head(): { seq: number; hash: string } {
    return { seq: this.seq, hash: this.hash };
  }

  entries(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    return splitLines(readFileSync(this.path, "utf8")).map((line) => JSON.parse(line) as LedgerEntry);
  }

  /** Stores a payload by its digest. The content is redacted first, so a secret never reaches disk. */
  putBlob(content: string): BlobRef {
    const clean = this.redactor.text(content);
    const hex = createHash("sha256").update(clean, "utf8").digest("hex");
    mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    const file = join(this.blobDir, hex);
    if (!existsSync(file)) writeFileSync(file, clean, { mode: 0o400 });
    return { $blob: `sha256:${hex}`, bytes: Buffer.byteLength(clean, "utf8") };
  }

  append(input: AppendInput): LedgerEntry {
    if (!ALLOWED_ACTORS[input.type].includes(input.actor)) {
      throw new Error(`The actor ${input.actor} may not write an entry of type ${input.type}. Allowed: ${ALLOWED_ACTORS[input.type].join(", ")}.`);
    }
    if (hasBlobKey(input.body)) throw new Error("A ledger body cannot contain a $blob key. The ledger writer creates those itself.");
    // Redact first, then move large strings out, then hash what will be stored.
    const body = this.externalise(this.redactor.value(input.body)) as Record<string, unknown>;
    const schema = BODY_SCHEMAS[input.type];
    if (schema) {
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new Error(`The body of a ${input.type} entry is not valid: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
    }
    const unsigned: Omit<LedgerEntry, "hash"> = {
      seq: this.seq + 1,
      ts: this.now().toISOString(),
      run: this.run,
      ...(input.branch ? { branch: input.branch } : {}),
      type: input.type,
      actor: input.actor,
      body,
      prev: this.hash,
    };
    const entry = { ...unsigned, hash: entryHash(unsigned) } as LedgerEntry;
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${canonicalJson(entry)}\n`);
    } finally {
      closeSync(fd);
    }
    this.seq = entry.seq;
    this.hash = entry.hash;
    return entry;
  }

  private externalise(value: unknown): unknown {
    if (typeof value === "string") return Buffer.byteLength(value, "utf8") > MAX_INLINE_BYTES ? this.putBlob(value) : value;
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("A ledger body cannot hold NaN or Infinity, because JSON cannot store them. Convert the value first.");
    if (Array.isArray(value)) return value.map((item) => this.externalise(item));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.externalise(item)]));
    }
    return value;
  }
}
