import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ledgerPath } from "../paths.js";
import { verifyFile } from "../ledger/verify.js";
import { FAKE_SECRET, fixedClock } from "../ledger/testing.js";
import { approveCharterFile, reviewCharterFile } from "./approve.js";
import { draftCharter } from "./draft.js";
import { loadCharterFile, writeCharterFile } from "./file.js";
import { reviewCharter } from "./review.js";
import { CharterInvalid, charterHash, parseCharter } from "./schema.js";

const FIXTURE = new URL("./fixtures/migrate-customers.yaml", import.meta.url).pathname;
let home: string;
let work: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "charter-home-"));
  work = mkdtempSync(join(tmpdir(), "charter-work-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const kinds = (items: Array<{ kind: string; subject: string }>): string[] => items.map((i) => `${i.kind}:${i.subject}`);
const raw = (): Record<string, unknown> => parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;

describe("charter schema", () => {
  it("accepts the sample charter of the spec", () => {
    expect(loadCharterFile(FIXTURE)).toMatchObject({ id: "migrate-customers", version: 1 });
  });

  it("rejects a criterion that names a check the charter does not define", () => {
    const data = raw() as { success: Array<Record<string, unknown>> };
    (data.success[0] as Record<string, unknown>).check = "missing-check";
    expect(() => parseCharter(data)).toThrow(CharterInvalid);
    expect(() => parseCharter(data)).toThrow(/missing-check/);
  });

  it("rejects duplicate ids, an unknown exit check, and thresholds in the wrong order", () => {
    const data = raw() as { success: unknown[]; stages: Array<Record<string, unknown>>; thresholds: Record<string, number> };
    data.success.push(data.success[0]);
    (data.stages[0] as Record<string, unknown>).exit_checks = ["nope"];
    data.thresholds = { warn: 0.7, pause: 0.6 };
    try {
      parseCharter(data);
      expect.unreachable();
    } catch (error) {
      const text = (error as CharterInvalid).message;
      expect(text).toMatch(/used twice/);
      expect(text).toMatch(/nope/);
      expect(text).toMatch(/warn threshold/);
    }
  });

  it("rejects an unknown field, so a typo does not silently drop a rule", () => {
    expect(() => parseCharter({ ...raw(), scop: {} })).toThrow(CharterInvalid);
  });

  it("gives the same hash whatever the key order and comments in the file", () => {
    const original = loadCharterFile(FIXTURE);
    const shuffled = Object.fromEntries(Object.entries(raw()).reverse());
    const file = join(work, "shuffled.yaml");
    writeFileSync(file, `# a comment\n${stringify(shuffled)}`);
    expect(charterHash(loadCharterFile(file))).toBe(charterHash(original));
  });

  it("changes the hash when any rule changes", () => {
    const original = charterHash(loadCharterFile(FIXTURE));
    const data = raw() as { thresholds: Record<string, number> };
    data.thresholds.pause = 0.61;
    expect(charterHash(parseCharter(data))).not.toBe(original);
  });
});

describe("charter review", () => {
  it("flags a vague goal", () => {
    for (const goal of ["Improve the data.", "Clean up the customer table and handle stuff as needed.", "Fix it."]) {
      const items = reviewCharter({ ...draftCharter(goal) });
      expect(kinds(items), goal).toContain("vague_goal:goal");
    }
  });

  it("does not flag a specific goal", () => {
    const items = reviewCharter(loadCharterFile(FIXTURE));
    expect(kinds(items)).not.toContain("vague_goal:goal");
  });

  it("flags a success criterion with no check", () => {
    const items = reviewCharter(loadCharterFile(FIXTURE));
    expect(kinds(items)).toContain("unchecked_criterion:s3");
    expect(kinds(items)).not.toContain("unchecked_criterion:s1");
  });

  it("flags a vague success criterion", () => {
    const data = raw() as { success: Array<Record<string, unknown>> };
    data.success.push({ id: "s4", text: "Data quality is improved.", check: "no-duplicates" });
    expect(kinds(reviewCharter(parseCharter(data)))).toContain("vague_criterion:s4");
  });

  it("flags a check with no planted fault", () => {
    expect(kinds(reviewCharter(loadCharterFile(FIXTURE)))).toEqual(expect.arrayContaining(["check_without_fault:no-pii-in-logs"]));
    expect(kinds(reviewCharter(loadCharterFile(FIXTURE)))).not.toContain("check_without_fault:row-conservation");
  });

  it("flags every gap of a fresh draft, as the story needs", () => {
    const draft = draftCharter("Migrate customers_v1 to the customers_v2 schema. Remove duplicate customers.");
    expect(draft.success).toHaveLength(2);
    expect(kinds(reviewCharter(draft))).toEqual(expect.arrayContaining(["unchecked_criterion:s1", "unchecked_criterion:s2", "stage_without_exit_check:work", "broad_scope:allow_paths"]));
  });

  it("gives the sample charter exactly the two items the spec expects to see", () => {
    expect(kinds(reviewCharter(loadCharterFile(FIXTURE))).sort()).toEqual(["check_without_fault:no-pii-in-logs", "unchecked_criterion:s3"]);
  });
});

describe("charter approval", () => {
  const draftFile = (): string => {
    const file = join(work, "charter.yaml");
    writeFileSync(file, readFileSync(FIXTURE, "utf8"));
    return file;
  };

  it("refuses to approve a charter that has not been reviewed", () => {
    expect(() => approveCharterFile(home, draftFile())).toThrow(/has not been reviewed/);
  });

  it("refuses to approve while items are open, and names them", () => {
    const file = draftFile();
    reviewCharterFile(home, file);
    expect(() => approveCharterFile(home, file)).toThrow(/unchecked_criterion:s3/);
  });

  it("refuses an acceptance with no reason or for an item that does not exist", () => {
    const file = draftFile();
    reviewCharterFile(home, file);
    expect(() => reviewCharterFile(home, file, { "unchecked_criterion:s3": "  " })).toThrow(/needs a reason/);
    expect(() => reviewCharterFile(home, file, { "unchecked_criterion:s9": "x" })).toThrow(/no open review item/);
  });

  it("approves once every item is accepted, and writes the charter hash as the first entry", () => {
    const file = draftFile();
    reviewCharterFile(home, file);
    reviewCharterFile(home, file, { "unchecked_criterion:s3": "Contact recency has no automated check yet.", "check_without_fault:no-pii-in-logs": "A pattern check has no fault command." });
    const approval = approveCharterFile(home, file, { run: "r_abcd", now: fixedClock() });
    const lines = readFileSync(ledgerPath(home, "r_abcd"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ seq: 1, type: "charter_approved", actor: "operator", body: { charter_hash: charterHash(loadCharterFile(file)), version: 1 } });
    expect(lines[1]).toMatchObject({ seq: 2, type: "charter_review", body: { review_digest: lines[0].body.review_digest } });
    expect(lines[1].body.items.map((i: { resolution: { status: string } }) => i.resolution.status)).toEqual(["accepted", "accepted"]);
    expect(approval.run).toBe("r_abcd");
    expect(verifyFile(ledgerPath(home, "r_abcd"))).toMatchObject({ ok: true, entries: 2 });
  });

  it("records an item as fixed when the operator edits the charter, and as accepted when they accept it", () => {
    const file = draftFile();
    reviewCharterFile(home, file);
    const data = raw() as { checks: Array<Record<string, unknown>> };
    (data.checks.find((c) => c.id === "no-pii-in-logs") as Record<string, unknown>).fault = "node checks/faults/email-in-log.js";
    writeFileSync(file, stringify(data));
    const { open } = reviewCharterFile(home, file, { "unchecked_criterion:s3": "No check yet." });
    expect(open).toEqual([]);
    approveCharterFile(home, file, { run: "r_abce" });
    const review = readFileSync(ledgerPath(home, "r_abce"), "utf8").trim().split("\n").map((l) => JSON.parse(l))[1];
    const byId = Object.fromEntries(review.body.items.map((i: { id: string; resolution: { status: string } }) => [i.id, i.resolution.status]));
    expect(byId).toEqual({ "unchecked_criterion:s3": "accepted", "check_without_fault:no-pii-in-logs": "fixed" });
  });

  it("catches a new problem introduced by an edit after the last review", () => {
    const file = draftFile();
    reviewCharterFile(home, file, {});
    reviewCharterFile(home, file, { "unchecked_criterion:s3": "x", "check_without_fault:no-pii-in-logs": "y" });
    const data = raw() as { goal: string };
    data.goal = "Improve the data.";
    writeFileSync(file, stringify(data));
    expect(() => approveCharterFile(home, file)).toThrow(/vague_goal:goal/);
  });

  it("does not write a ledger for a charter that fails to parse, and does not reuse a run", () => {
    const file = join(work, "bad.yaml");
    writeFileSync(file, "id: x\n");
    expect(() => reviewCharterFile(home, file)).toThrow(CharterInvalid);
    const ok = draftFile();
    reviewCharterFile(home, ok, { "unchecked_criterion:s3": "x", "check_without_fault:no-pii-in-logs": "y" });
    approveCharterFile(home, ok, { run: "r_dup1" });
    expect(() => approveCharterFile(home, ok, { run: "r_dup1" })).toThrow(/already has a ledger/);
    expect(() => approveCharterFile(home, ok, { run: "../escape" })).toThrow(/not valid/);
  });

  it("does not honour an acceptance written by hand, and does not keep one after the text changes", () => {
    const file = draftFile();
    reviewCharterFile(home, file);
    const store = join(home, "reviews", "migrate-customers.json");
    const record = JSON.parse(readFileSync(store, "utf8"));
    for (const item of record.items) item.resolution = { status: "accepted" };
    writeFileSync(store, JSON.stringify(record));
    expect(() => reviewCharterFile(home, file)).toThrow(/cannot be trusted/);
    rmSync(store);
    reviewCharterFile(home, file, { "unchecked_criterion:s3": "No check yet." });
    const data = raw() as { success: Array<Record<string, unknown>> };
    (data.success[2] as Record<string, unknown>).text = "Merged records keep whatever contact details look best.";
    writeFileSync(file, stringify(data));
    const { open } = reviewCharterFile(home, file);
    expect(open.map((i) => i.id)).toContain("unchecked_criterion:s3");
  });

  it("refuses a charter that contains a secret, and keeps the secret out of the review store", () => {
    const file = draftFile();
    const data = raw() as { goal: string };
    data.goal = `Migrate customers_v1 to customers_v2 with key ${FAKE_SECRET.anthropic("abcdefghijklmnop")} and remove duplicates.`;
    writeFileSync(file, stringify(data));
    expect(() => reviewCharterFile(home, file)).toThrow(/looks like a secret/);
    expect(() => approveCharterFile(home, file)).toThrow(/looks like a secret/);
    writeFileSync(file, readFileSync(FIXTURE, "utf8"));
    reviewCharterFile(home, file, { "unchecked_criterion:s3": "Ask jane@example.org about it." });
    expect(readFileSync(join(home, "reviews", "migrate-customers.json"), "utf8")).not.toContain("jane@example.org");
  });

  it("does not overwrite an existing draft", () => {
    const file = join(work, "draft.yaml");
    writeCharterFile(file, draftCharter("Migrate customers_v1 to customers_v2 and remove duplicates."));
    expect(() => writeCharterFile(file, draftCharter("Another goal that is long enough."))).toThrow(/already exists/);
  });
});

describe("stage descriptions", () => {
  const demo = join(new URL("../../..", import.meta.url).pathname, "demo", "charter.yaml");

  it("loads the demo charter, where every stage says what it is for", () => {
    const charter = loadCharterFile(demo);
    expect(charter.stages.every((stage) => typeof stage.description === "string" && stage.description.length > 20)).toBe(true);
  });

  it("refuses an empty description, and a charter without descriptions still loads", () => {
    const raw = parse(readFileSync(demo, "utf8")) as { stages: { description?: string }[] };
    const dir = mkdtempSync(join(tmpdir(), "desc-"));
    try {
      const empty = structuredClone(raw);
      if (empty.stages[0]) empty.stages[0].description = "";
      writeFileSync(join(dir, "empty.yaml"), stringify(empty));
      expect(() => loadCharterFile(join(dir, "empty.yaml"))).toThrow();
      const none = structuredClone(raw);
      for (const stage of none.stages) delete stage.description;
      writeFileSync(join(dir, "none.yaml"), stringify(none));
      expect(loadCharterFile(join(dir, "none.yaml")).stages[0]?.description).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
