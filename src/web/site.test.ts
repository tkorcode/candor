import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalJson as coreCanonical } from "../core/canonical.js";
import { checkSignature } from "../core/report/sign.js";

/**
 * The hosted console verifies runs in the browser with its own code in site/js. These tests run that code under
 * Node on the recorded runs and hold it to the engine: the same canonical form, the same hashes, the same
 * signature result, and the same first bad entry when something was changed.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (file: string) => import(pathToFileURL(join(root, "site", "js", file)).href);
const RUNS = [
  { id: "r_m4live", folder: "results/runs/2026-11-18-rule-change-and-restart", receipt: "receipt" },
  { id: "r_live3", folder: "results/runs/2026-11-18-watched-migration", receipt: "receipt" },
];
const linesOf = (run: (typeof RUNS)[number]) => readFileSync(join(root, run.folder, run.receipt, "ledger.jsonl"), "utf8").split("\n").filter(Boolean);
const receiptOf = (run: (typeof RUNS)[number]) => JSON.parse(readFileSync(join(root, run.folder, run.receipt, "receipt.json"), "utf8"));
const anchorsOf = (run: (typeof RUNS)[number]) => readFileSync(join(root, run.folder, run.receipt, "anchors.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// biome-ignore lint/suspicious/noExplicitAny: the site modules are plain JavaScript with no type declarations.
let canonical: any, verify: any, model: any;
beforeAll(async () => {
  canonical = await load("canonical.js");
  verify = await load("verify.js");
  model = await load("model.js");
});

describe("the console verifies runs in the browser exactly as candor verify does", () => {
  it.each(RUNS)("writes the canonical form of every entry of $id as the engine does", (run) => {
    for (const line of linesOf(run)) {
      const entry = JSON.parse(line);
      expect(canonical.canonicalJson(entry)).toBe(coreCanonical(entry));
    }
  });

  it.each(RUNS)("accepts the chain, the anchors, the blobs and the signed receipt of $id", async (run) => {
    const lines = linesOf(run);
    const entries = lines.map((l) => JSON.parse(l));
    const chain = await verify.verifyChain(lines);
    expect(chain).toMatchObject({ ok: true, entries: lines.length });
    expect(verify.verifyAnchors(anchorsOf(run), entries).ok).toBe(true);
    const blobs = await verify.verifyBlobs(entries, async (hex: string) => {
      try {
        return readFileSync(join(root, run.folder, run.receipt, "blobs", hex), "utf8");
      } catch {
        return null;
      }
    });
    expect(blobs.ok).toBe(true);
    const receipt = receiptOf(run);
    const signature = await verify.verifyReceiptSignature(receipt);
    expect(signature).toMatchObject({ ok: true, keyId: receipt.signature.key_id });
    expect(checkSignature(receipt).ok).toBe(true);
    expect(verify.verifyReceiptHead(receipt, entries).ok).toBe(true);
  });

  it("names the first bad entry after an edit, and notices a ledger cut short", async () => {
    const run = RUNS[0] as (typeof RUNS)[number];
    const lines = linesOf(run);
    const edited = [...lines];
    const victim = JSON.parse(edited[40] as string);
    victim.body = { ...victim.body, summary: "edited" };
    edited[40] = coreCanonical(victim);
    expect(await verify.verifyChain(edited)).toMatchObject({ ok: false, firstBadSeq: victim.seq });
    const entries = lines.slice(0, 60).map((l) => JSON.parse(l));
    expect(verify.verifyAnchors(anchorsOf(run), entries).ok).toBe(false);
  });

  it("refuses a receipt changed after signing", async () => {
    const receipt = receiptOf(RUNS[0] as (typeof RUNS)[number]);
    receipt.verdicts.result_verified.verdict = "yes";
    expect((await verify.verifyReceiptSignature(receipt)).ok).toBe(false);
  });
});

describe("the run model of the console", () => {
  const build = (run: (typeof RUNS)[number]) => {
    const entries = linesOf(run).map((l) => JSON.parse(l));
    const charters = JSON.parse(
      JSON.stringify(
        RUNS.indexOf(run) === 0
          ? [1, 2, 3].map((v) => JSON.parse(readFileSync(join(root, run.folder, `charter.v${v}.json`), "utf8")))
          : [JSON.parse(readFileSync(join(root, run.folder, "charter.v1.json"), "utf8"))],
      ),
    );
    return model.buildModel({ entries, charters, receipt: receiptOf(run), meta: { id: run.id } });
  };

  it("lays out the restart run as branch A, superseded, and branch B forked from A1", () => {
    const m = build(RUNS[0] as (typeof RUNS)[number]);
    expect(m.activeBranch).toBe("B");
    expect(m.branches.get("A").superseded).toBe(true);
    expect(m.branches.get("B")).toMatchObject({ from: "A1", superseded: false });
    const b1 = m.byId.get("B1");
    expect(b1).toMatchObject({ parent: "A1", branch: "B", column: 1 });
    expect(m.lineageOf("B").map((c: { id: string }) => c.id)).toEqual(["A1", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"]);
  });

  it("suggests restarting from the last checkpoint scored on course before drift first reached warn", () => {
    const m = build(RUNS[0] as (typeof RUNS)[number]);
    const suggestion = model.suggestRestart(m, m.thresholds);
    // B2 is the first checkpoint on branch B at warn. B1 was not scored, so the suggestion is A1.
    expect(suggestion.kind).toBe("suggested");
    expect(suggestion.flagged.id).toBe("B2");
    expect(suggestion.checkpoint.id).toBe("A1");
    // With a higher warn threshold nothing is flagged, and the answer says so.
    expect(model.suggestRestart(m, { warn: 0.6, pause: 0.8 }).kind).toBe("on_course");
  });

  it.each(RUNS)("gives the same suggested restart point as the engine on $id, at several thresholds", async (run) => {
    const { suggestRestart: engine } = await import("../core/restart-point.js");
    const m = build(run);
    const entries = linesOf(run).map((l) => JSON.parse(l));
    for (const t of [m.thresholds, { warn: 0.1, pause: 0.3 }, { warn: 0.2, pause: 0.5 }, { warn: 0.6, pause: 0.8 }]) {
      const site = model.suggestRestart(m, t);
      const core = engine(entries, t, m.activeBranch);
      expect(site.kind).toBe(core.kind);
      expect(site.checkpoint?.id ?? null).toBe("checkpoint" in core ? core.checkpoint : null);
      expect(site.flagged?.id ?? null).toBe("flagged" in core ? core.flagged : null);
      expect(site.text).toBe(core.text);
    }
  });

  it("describes every entry type of the recorded runs in words", () => {
    for (const run of RUNS) {
      for (const line of linesOf(run)) {
        const entry = JSON.parse(line);
        const text = model.describe(entry);
        expect(typeof text).toBe("string");
        expect(text).not.toBe(entry.type);
        expect(text).not.toMatch(/undefined/);
      }
    }
  });
});
