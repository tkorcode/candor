import { createHash } from "node:crypto";
import { canonicalJson } from "../core/canonical.js";
import { createRedactor, type Redactor } from "../core/ledger/redact.js";
import { type Actor, ALLOWED_ACTORS, BODY_SCHEMAS, type EntryType, GENESIS, type LedgerEntry } from "../core/ledger/types.js";
import { entryHash } from "../core/ledger/verify.js";

/**
 * The ledger of a hosted job. It writes the same entries as the file ledger of the local product
 * (src/core/ledger/ledger.ts): the same actors per entry type, the same body schemas, the same redaction, the
 * same blob rule for long strings, and the same hash chain, so `candor verify` accepts what it writes. It keeps
 * the lines and blobs in memory, so a Durable Object can store them as plain values. Like the file ledger it has
 * no method that edits or removes an entry.
 */

const MAX_INLINE_BYTES = 4096;
const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export interface HostedLedgerState {
  run: string;
  lines: string[];
  blobs: Record<string, string>;
  anchors: { run: string; seq: number; head: string; ts: string }[];
}

export class HostedLedger {
  private readonly redactor: Redactor;
  constructor(
    readonly state: HostedLedgerState,
    private readonly now: () => Date = () => new Date(),
    extraSecrets: string[] = [],
  ) {
    this.redactor = createRedactor(extraSecrets);
  }

  static create(run: string, now?: () => Date): HostedLedger {
    return new HostedLedger({ run, lines: [], blobs: {}, anchors: [] }, now);
  }

  head(): { seq: number; hash: string } {
    const last = this.state.lines.at(-1);
    if (!last) return { seq: 0, hash: GENESIS };
    const entry = JSON.parse(last) as LedgerEntry;
    return { seq: entry.seq, hash: entry.hash };
  }

  entries(): LedgerEntry[] {
    return this.state.lines.map((l) => JSON.parse(l) as LedgerEntry);
  }

  append(input: { type: EntryType; actor: Actor; body: Record<string, unknown>; branch?: string }): LedgerEntry {
    if (!ALLOWED_ACTORS[input.type].includes(input.actor)) throw new Error(`The actor ${input.actor} may not write an entry of type ${input.type}.`);
    const body = this.externalise(this.redactor.value(input.body)) as Record<string, unknown>;
    const schema = BODY_SCHEMAS[input.type];
    if (schema && !schema.safeParse(body).success) throw new Error(`The body of a ${input.type} entry is not valid.`);
    const { seq, hash } = this.head();
    const unsigned: Omit<LedgerEntry, "hash"> = {
      seq: seq + 1,
      ts: this.now().toISOString(),
      run: this.state.run,
      ...(input.branch && input.branch !== "A" ? { branch: input.branch } : {}),
      type: input.type,
      actor: input.actor,
      body,
      prev: hash,
    };
    const entry = { ...unsigned, hash: entryHash(unsigned) } as LedgerEntry;
    this.state.lines.push(canonicalJson(entry));
    return entry;
  }

  /** Records the head in the anchor list, the hosted copy of the anchor file. */
  anchor(): { seq: number; head: string } {
    const { seq, hash } = this.head();
    this.state.anchors.push({ run: this.state.run, seq, head: hash, ts: this.now().toISOString() });
    return { seq, head: hash };
  }

  blob(ref: string): string | undefined {
    return this.state.blobs[ref.replace("sha256:", "")];
  }

  private externalise(value: unknown): unknown {
    if (typeof value === "string" && new TextEncoder().encode(value).length > MAX_INLINE_BYTES) {
      const hex = sha256Hex(value);
      this.state.blobs[hex] = value;
      return { $blob: `sha256:${hex}`, bytes: new TextEncoder().encode(value).length };
    }
    if (Array.isArray(value)) return value.map((v) => this.externalise(v));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.externalise(v)]));
    return value;
  }
}
