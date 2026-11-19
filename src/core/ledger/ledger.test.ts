import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../canonical.js";
import { anchorHead, readAnchors } from "../anchor/file.js";
import { Ledger, LedgerCorrupt, MAX_INLINE_BYTES } from "./ledger.js";
import { createRedactor } from "./redact.js";
import { FAKE_SECRET, fixedClock, scriptedStream } from "./testing.js";
import { GENESIS, type LedgerEntry } from "./types.js";
import { entryHash, verifyFile, verifyLines } from "./verify.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-"));
  path = join(dir, "ledger.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build(): Ledger {
  const ledger = Ledger.open({ path, run: "r_test", now: fixedClock() });
  for (const event of scriptedStream()) ledger.append(event);
  return ledger;
}
const lines = (): string[] => readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
/** Rewrites every hash from index `from` on, as an attacker who can write the file would. */
function rechain(all: LedgerEntry[], from: number): string[] {
  let prev = from === 0 ? GENESIS : (all[from - 1]?.hash ?? GENESIS);
  return all.map((entry, i) => {
    if (i < from) return canonicalJson(entry);
    const { hash: _old, ...rest } = { ...entry, seq: i + 1, prev };
    const hash = entryHash(rest);
    prev = hash;
    return canonicalJson({ ...rest, hash });
  });
}

describe("ledger", () => {
  it("turns a scripted event stream into a ledger that verifies", () => {
    build();
    const result = verifyFile(path);
    expect(result).toMatchObject({ ok: true, entries: scriptedStream().length });
    expect(JSON.parse(lines()[0] as string).prev).toBe(GENESIS);
  });

  it("gives the same hashes for the same stream with a fixed clock", () => {
    const first = build().head();
    rmSync(path);
    const second = build().head();
    expect(second).toEqual(first);
  });

  it("continues the chain when reopened", () => {
    const ledger = build();
    const reopened = Ledger.open({ path, run: "r_test", now: fixedClock("2026-11-18T14:00:00.000Z") });
    expect(reopened.head()).toEqual(ledger.head());
    reopened.append({ type: "heartbeat", actor: "candord", body: {} });
    expect(verifyFile(path)).toMatchObject({ ok: true, entries: scriptedStream().length + 1 });
  });

  it("refuses to open and append to a ledger that does not verify", () => {
    build();
    const all = lines();
    all[3] = all[3]?.replace("Bash", "Edit") as string;
    writeFileSync(path, `${all.join("\n")}\n`);
    expect(() => Ledger.open({ path, run: "r_test" })).toThrow(LedgerCorrupt);
  });

  it("has no method that edits, removes or reorders an entry", () => {
    const names = Object.getOwnPropertyNames(Ledger.prototype);
    expect(names.filter((n) => /^(edit|update|delete|remove|set|replace|truncate|insert|reorder)/i.test(n))).toEqual([]);
  });

  it("refuses an entry written by an actor that may not write that type", () => {
    const ledger = Ledger.open({ path, run: "r_test" });
    expect(() => ledger.append({ type: "charter_approved", actor: "worker", body: {} })).toThrow(/may not write/);
    expect(() => ledger.append({ type: "drift_score", actor: "worker", body: {} })).toThrow(/may not write/);
  });

  it("flags a forged actor found in a file", () => {
    build();
    const all = lines().map((l) => JSON.parse(l) as LedgerEntry);
    const forged = { ...all[2], actor: "operator" } as LedgerEntry; // tool_intent written by the operator
    all[2] = forged;
    const result = verifyLines(rechain(all, 2));
    expect(result).toMatchObject({ ok: false, firstBadSeq: 3 });
  });

  it("refuses a body that is not valid JSON", () => {
    const ledger = Ledger.open({ path, run: "r_test" });
    expect(() => ledger.append({ type: "heartbeat", actor: "candord", body: { n: Number.NaN } })).toThrow(/NaN/);
  });
});

describe("tamper tests", () => {
  // The third value is where the chain breaks, counted from the position of the change.
  const mutations: Array<[string, (all: string[], i: number) => string[]] | [string, (all: string[], i: number) => string[], number]> = [
    ["edit the time", (all, i) => all.map((l, j) => (j === i ? l.replace(/"ts":"2026/, '"ts":"2027') : l))],
    ["edit the body", (all, i) => all.map((l, j) => (j === i ? (l.includes('"body":{') ? l.replace('"body":{', '"body":{"tampered":true,') : l) : l))],
    ["delete", (all, i) => all.filter((_, j) => j !== i)],
    ["insert a copy", (all, i) => [...all.slice(0, i), all[i] as string, ...all.slice(i)], 1],
    ["insert a forged entry", (all, i) => [...all.slice(0, i), all[i]?.replace(/"hash":"sha256:[0-9a-f]{64}"/, `"hash":"sha256:${"b".repeat(64)}"`) as string, ...all.slice(i)]],
    ["swap with the next", (all, i) => all.map((l, j) => (j === i ? (all[i + 1] as string) : j === i + 1 ? (all[i] as string) : l))],
    ["blank a line", (all, i) => all.map((l, j) => (j === i ? "{" : l))],
  ];

  for (const [name, mutate, offset = 0] of mutations) {
    it(`fails verification and names the first bad entry: ${name}, at every position`, () => {
      build();
      const original = lines();
      const total = original.length;
      for (let i = 0; i < total; i++) {
        if (name === "swap with the next" && i === total - 1) continue;
        if (name === "delete" && i === total - 1) continue; // dropping the tail is caught by an anchor, tested below
        const result = verifyLines(mutate(original, i));
        expect(result.ok, `${name} at ${i + 1}`).toBe(false);
        if (!result.ok) expect(result.firstBadSeq, `${name} at ${i + 1}`).toBe(i + 1 + offset);
      }
    });
  }

  it("catches a truncated ledger against its last anchor", () => {
    const ledger = build();
    anchorHead(ledger, join(dir, "anchors", "r_test.jsonl"), fixedClock());
    ledger.append({ type: "heartbeat", actor: "candord", body: {} });
    const anchorPath = join(dir, "anchors", "r_test.jsonl");
    const all = lines();
    expect(verifyFile(path, { anchorsPath: anchorPath })).toMatchObject({ ok: true });
    const cut = all.slice(0, scriptedStream().length - 3);
    writeFileSync(path, `${cut.join("\n")}\n`);
    const result = verifyFile(path, { anchorsPath: anchorPath });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/cut short/);
  });

  it("passes a rewritten chain without an anchor and fails it with one", () => {
    const ledger = build();
    const anchorPath = join(dir, "anchors", "r_test.jsonl");
    anchorHead(ledger, anchorPath, fixedClock());
    const all = lines().map((l) => JSON.parse(l) as LedgerEntry);
    const target = all[4] as LedgerEntry;
    all[4] = { ...target, body: { ...target.body, tool: "Edit" } };
    // The attacker must also repair the anchor entry inside the ledger, which names the old hash.
    const once = rechain(all, 4).map((l) => JSON.parse(l) as LedgerEntry);
    const anchorEntry = once.at(-1) as LedgerEntry;
    expect(verifyLines(once.map((e) => canonicalJson(e)))).toMatchObject({ ok: false });
    once[once.length - 1] = { ...anchorEntry, body: { ...anchorEntry.body, anchored_hash: once[scriptedStream().length - 1]?.hash } };
    writeFileSync(path, `${rechain(once, once.length - 1).join("\n")}\n`);
    // The internal chain alone is fooled. Without the anchor file, verifyFile refuses to call it good.
    expect(verifyLines(lines())).toMatchObject({ ok: true });
    expect(verifyFile(path)).toMatchObject({ ok: false });
    const anchored = verifyFile(path, { anchorsPath: anchorPath });
    expect(anchored).toMatchObject({ ok: false });
    if (!anchored.ok) expect(anchored.firstBadSeq).toBe(scriptedStream().length);
  });

  it("flags an anchor entry whose record was removed from the anchor file", () => {
    const ledger = build();
    const anchorPath = join(dir, "anchors", "r_test.jsonl");
    anchorHead(ledger, anchorPath, fixedClock());
    writeFileSync(anchorPath, "");
    expect(verifyFile(path, { anchorsPath: anchorPath })).toMatchObject({ ok: false, firstBadSeq: scriptedStream().length + 1 });
  });

  it("writes an anchor entry that names the head it anchored", () => {
    const ledger = build();
    const before = ledger.head();
    const record = anchorHead(ledger, join(dir, "anchors", "r_test.jsonl"), fixedClock());
    expect(record).toMatchObject({ seq: before.seq, head: before.hash });
    expect(readAnchors(join(dir, "anchors", "r_test.jsonl"))).toEqual([record]);
    expect(ledger.entries().at(-1)).toMatchObject({ type: "anchor", actor: "candord", body: { anchored_seq: before.seq, anchored_hash: before.hash, kind: "file" } });
  });

  it("refuses to anchor an empty ledger", () => {
    const ledger = Ledger.open({ path, run: "r_test" });
    expect(() => anchorHead(ledger, join(dir, "a.jsonl"))).toThrow(/empty/);
  });
});

describe("findings from the independent review", () => {
  it("fails when the blob folder is deleted, not only one blob", () => {
    const ledger = Ledger.open({ path, run: "r_test" });
    ledger.append({ type: "tool_result", actor: "worker", body: { output: "y".repeat(MAX_INLINE_BYTES + 1) } });
    rmSync(ledger.blobDir, { recursive: true, force: true });
    expect(verifyFile(path, { blobDir: ledger.blobDir })).toMatchObject({ ok: false, firstBadSeq: 1 });
  });

  it("fails when the anchor file is deleted but the ledger records anchors", () => {
    const ledger = build();
    const anchorFile = join(dir, "anchors", "r_test.jsonl");
    anchorHead(ledger, anchorFile, fixedClock());
    rmSync(anchorFile);
    const result = verifyFile(path, { anchorsPath: anchorFile });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/no anchor file/);
  });

  it("fails on a malformed anchor file instead of crashing", () => {
    build();
    const anchorFile = join(dir, "bad.jsonl");
    writeFileSync(anchorFile, '{"nope":1}\n');
    expect(verifyFile(path, { anchorsPath: anchorFile })).toMatchObject({ ok: false });
  });

  it("fails a ledger relabelled with another run id when the run is expected", () => {
    build();
    const all = lines().map((l) => ({ ...(JSON.parse(l) as LedgerEntry), run: "r_other" }));
    writeFileSync(path, `${rechain(all, 0).join("\n")}\n`);
    expect(verifyFile(path)).toMatchObject({ ok: true });
    expect(verifyFile(path, { expectedRun: "r_test" })).toMatchObject({ ok: false, firstBadSeq: 1 });
  });

  it("fails an anchor entry that names a hash the chain does not hold", () => {
    const ledger = build();
    const head = ledger.head();
    ledger.append({ type: "anchor", actor: "candord", body: { anchored_seq: head.seq, anchored_hash: `sha256:${"c".repeat(64)}`, kind: "file" } });
    expect(verifyFile(path)).toMatchObject({ ok: false, firstBadSeq: head.seq + 1 });
  });

  it("refuses a caller that sends a blob reference of its own", () => {
    const ledger = Ledger.open({ path, run: "r_test" });
    expect(() => ledger.append({ type: "tool_intent", actor: "worker", body: { x: { $blob: `sha256:${"d".repeat(64)}`, bytes: 1 } } })).toThrow(/\$blob/);
    expect(ledger.head().seq).toBe(0);
  });

  it("fails a file that is not in canonical form or has a blank line", () => {
    build();
    const all = lines();
    writeFileSync(path, `${JSON.stringify(JSON.parse(all[0] as string), null, 1)}\n${all.slice(1).join("\n")}\n`);
    expect(verifyFile(path)).toMatchObject({ ok: false });
    writeFileSync(path, `${all[0]}\n\n${all.slice(1).join("\n")}\n`);
    expect(verifyFile(path)).toMatchObject({ ok: false, firstBadSeq: 2 });
  });

  it("redacts a secret held under a key name, a quoted JSON form, a URL password and a short key", () => {
    const out = createRedactor().value({ password: "hunter2hunter2", note: '{"api_key": "abcd1234efgh"}', url: "postgres://u:pw123456@host/db", k: FAKE_SECRET.anthropic("abc") });
    const text = JSON.stringify(out);
    for (const secret of ["hunter2hunter2", "abcd1234efgh", "pw123456", FAKE_SECRET.anthropic("abc")]) expect(text).not.toContain(secret);
  });
});

describe("redaction and blobs", () => {
  const secrets = [
    FAKE_SECRET.anthropic(),
    FAKE_SECRET.aws,
    FAKE_SECRET.github,
    "Authorization: Bearer abcdefghijklmnop1234567890",
    "API_KEY=hunter2hunter2",
    'password: "correct horse"',
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    FAKE_SECRET.pem("MIIEvQIBADANBgkq"),
  ];
  const personal = ["jane.doe@example.org", "123-45-6789"];

  it("keeps secrets and personal data off the disk, including the ledger, the blobs and keys", () => {
    const ledger = Ledger.open({ path, run: "r_test", redactor: createRedactor(["operator-secret-value-0123456789"]) });
    ledger.append({
      type: "tool_intent",
      actor: "worker",
      body: { cmd: [...secrets, ...personal, "operator-secret-value-0123456789"].join("\n"), nested: { list: [secrets[0]] }, [personal[0] as string]: 1, big: `${secrets[0]} ${"x".repeat(MAX_INLINE_BYTES + 10)}` },
    });
    const onDisk = [readFileSync(path, "utf8"), ...readdirSync(ledger.blobDir).map((f) => readFileSync(join(ledger.blobDir, f), "utf8"))].join("\n");
    for (const secret of [...secrets, ...personal, "operator-secret-value-0123456789"]) {
      const core = secret.split(/[\s:=]+/).pop() as string;
      expect(onDisk, secret).not.toContain(core.replace(/^"|"$/g, ""));
    }
    expect(onDisk).toContain("[REDACTED:");
    expect(verifyFile(path, { blobDir: ledger.blobDir })).toMatchObject({ ok: true });
  });

  it("keeps the name of an assignment and removes only its value", () => {
    expect(createRedactor().text("run with API_KEY=abc123abc123 now")).toBe("run with API_KEY=[REDACTED:secret_assignment] now");
  });

  it("moves a large payload to the blob store and carries its digest", () => {
    const ledger = Ledger.open({ path, run: "r_test" });
    const entry = ledger.append({ type: "tool_result", actor: "worker", body: { output: "y".repeat(MAX_INLINE_BYTES + 1) } });
    const ref = entry.body.output as { $blob: string; bytes: number };
    expect(ref.$blob).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readFileSync(join(ledger.blobDir, ref.$blob.replace("sha256:", "")), "utf8")).toHaveLength(MAX_INLINE_BYTES + 1);
  });

  it("detects a changed or missing blob", () => {
    const ledger = Ledger.open({ path, run: "r_test" });
    const entry = ledger.append({ type: "tool_result", actor: "worker", body: { output: "y".repeat(MAX_INLINE_BYTES + 1) } });
    const file = join(ledger.blobDir, (entry.body.output as { $blob: string }).$blob.replace("sha256:", ""));
    rmSync(file);
    expect(verifyFile(path, { blobDir: ledger.blobDir })).toMatchObject({ ok: false, firstBadSeq: 1 });
    writeFileSync(file, "different");
    expect(verifyFile(path, { blobDir: ledger.blobDir })).toMatchObject({ ok: false, firstBadSeq: 1 });
  });
});
