import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../cli/main.js";
import { anchorHead } from "../anchor/file.js";
import { withRule, writeCharterVersion } from "../charter/rules.js";
import { testCharter, seedApprovedRun } from "../charter/testing.js";
import { compareWithAnswerKey } from "../checks/answerkey.js";
import { Ledger } from "../ledger/ledger.js";
import { FAKE_SECRET, fixedClock } from "../ledger/testing.js";
import { anchorPath, ledgerPath, receiptKeyPath, runDir } from "../paths.js";
import { composeReceipt, renderReceiptHtml, writeReceipt } from "./receipt.js";
import { checkSignature } from "./sign.js";

/**
 * Tests for the full receipt. The ledgers are built from scripted entries with a fixed clock and a fixed
 * signing key, so the golden files stay byte for byte the same. Run with UPDATE_GOLDEN=1 to rewrite them.
 */

const GOLDEN = join(dirname(new URL(import.meta.url).pathname), "golden");
const COVERAGE = join(dirname(new URL(import.meta.url).pathname), "../../../docs/COVERAGE.md");
const RUN = "r_gold";
const T0 = "2026-11-18T12:00:00.000Z";
// An Ed25519 key made from a fixed seed. It signs nothing outside these tests.
const FIXED_SEED = Buffer.alloc(32, 7);
const FIXED_PEM = `${FAKE_SECRET.pem(Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), FIXED_SEED]).toString("base64"))}\n`;

let home: string;
let out = "";

interface Scenario {
  stageOk?: boolean;
  s1?: "verified" | "failed" | "not_verified";
  key?: "matches" | "differs" | "error" | null;
  drift?: boolean;
  /** A rule change, the re-scores that follow it, and a restart from A1 to branch B. */
  m4?: boolean;
}

/** One run: three stages, every exit check passed, checkpoints anchored, then the final checks. */
function buildRun(scenario: Scenario = {}): void {
  const now = fixedClock(T0);
  seedApprovedRun(home, RUN, testCharter(), now);
  const ledger = Ledger.open({ path: ledgerPath(home, RUN), run: RUN, now });
  ledger.append({ type: "run_start", actor: "candord", body: { workspace: "/work", baseline_commit: "base", checks_digest: `sha256:${"1".repeat(64)}` } });
  ledger.append({ type: "session_start", actor: "candord", body: { source: "harness_init", session: "s1", claude_code_version: "2.1.300", model: "worker-model", plugins: [{ name: "example-mod", version: "1.0.0" }], mods_and_plugins_complete: true, tools: [], workspace: "/work" } });
  for (const id of ["has-output", "no-pii"]) ledger.append({ type: "check_strength", actor: "candord", body: { check: id, status: "proven", reason: "The check failed on its planted fault." } });
  const stages = ["profile", "map", "migrate"];
  stages.forEach((stage, i) => {
    ledger.append({ type: "stage_report", actor: "worker", body: { stage, accepted: true, done: !(scenario.stageOk === false && stage === "migrate"), confidence: 0.8, deviations: [], report_digest: `sha256:${String(i + 2).repeat(64)}` } });
    if (stage === "profile") ledger.append({ type: "check_result", actor: "candord", body: { check: "has-output", stage, status: "passed" } });
    ledger.append({ type: "checkpoint", actor: "candord", body: { id: `A${i + 1}`, n: i + 1, parent: i === 0 ? null : `A${i}`, stage, trigger: "stage_done", commit: `c${i}`, safety: "safe_to_restart" } });
    if (scenario.drift) ledger.append({ type: "drift_score", actor: "watcher", body: { checkpoint: `A${i + 1}`, status: "scored", charter_version: 1, judge_model: "judge-model", dimensions: { goal: 0.1, scope: i === 1 ? 0.4 : 0.1, plan: 0.1, evidence: 0.1 }, overall: i === 1 ? 0.4 : 0.1, level: i === 1 ? "warn" : "ok", findings: [] } });
    anchorHead(ledger, anchorPath(home, RUN), now);
  });
  if (scenario.m4) {
    const change = withRule(testCharter(), { text: "Do not modify records that are not duplicates.", dimension: "scope", source: "operator" });
    writeCharterVersion(runDir(home, RUN), change.charter);
    const rc = ledger.append({ type: "rule_change", actor: "operator", body: { author: "operator", source: "operator", reason: "Stage two touched rows that are not duplicates.", rule: change.rule, from_version: 1, version: 2, charter_hash: change.hash, previous_hash: change.previousHash } });
    const later = [0.7, 0.2, 0.1];
    ["A1", "A2", "A3"].forEach((id, i) => {
      const first = scenario.drift ? { overall: i === 1 ? 0.4 : 0.1, level: i === 1 ? "warn" : "ok" } : null;
      ledger.append({ type: "rescore", actor: "watcher", body: { checkpoint: id, status: "scored", charter_version: 2, previous_charter_version: 1, rule_change_seq: rc.seq, first, previous: first, dimensions: { goal: 0.1, scope: later[i], plan: 0.1, evidence: 0.1 }, overall: later[i], level: (later[i] ?? 0) >= 0.6 ? "pause" : "ok", findings: i === 0 ? [{ rule: "op-1", severity: "high", summary: "Early work touched records that are not duplicates.", entries: [1] }] : [] } });
    });
    const rule = withRule(change.charter, { text: "Restart from A1: Stage two touched rows that are not duplicates.", dimension: "scope", source: "restart" });
    writeCharterVersion(runDir(home, RUN), rule.charter);
    ledger.append({ type: "rule_change", actor: "operator", branch: "B", body: { author: "operator", source: "restart", reason: "Stage two touched rows that are not duplicates.", rule: rule.rule, from_version: 2, version: 3, charter_hash: rule.hash, previous_hash: rule.previousHash, branch: "B", restart_from: "A1" } });
    ledger.append({ type: "restart", actor: "operator", branch: "B", body: { from: "A1", from_branch: "A", to_branch: "B", reason: "Stage two touched rows that are not duplicates.", conversation: "fork", charter_version: 3, rule: rule.rule.id, workspace: "/work.B" } });
    ledger.append({ type: "check_result", actor: "candord", branch: "B", body: { check: "fork", ok: true, reason: "The conversation was forked at the message of the checkpoint." } });
  }
  ledger.append({ type: "effect", actor: "candord", body: { kind: "network", summary: "git push origin main", reversible: false, blocked: true, performed: false } });
  const s1 = scenario.s1 ?? "verified";
  ledger.append({ type: "acceptance_result", actor: "candord", body: { criterion: "s1", check: "has-output", status: s1, check_status: s1 === "failed" ? "failed" : "passed", strength: "proven", reason: "" } });
  ledger.append({ type: "acceptance_result", actor: "candord", body: { criterion: "s2", check: null, status: "not_verified", reason: "No check is named for this criterion." } });
  if (scenario.key !== null) {
    const key = scenario.key ?? "matches";
    ledger.append({ type: "acceptance_result", actor: "candord", body: { criterion: "answer-key", scope: "answer_key", check: null, status: key, reason: key === "matches" ? "The final state matches the answer key." : key === "differs" ? "The final state differs from the answer key." : "The comparison with the answer key did not finish." } });
  }
  ledger.append({ type: "run_end", actor: "candord", body: { reason: "done" } });
  anchorHead(ledger, anchorPath(home, RUN), now);
}

const options = { label: "scripted" as const, now: () => new Date("2026-11-18T13:00:00.000Z"), coverageFile: COVERAGE };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "receipt-home-"));
  writeFileSync(receiptKeyPath(home), FIXED_PEM, { mode: 0o600 });
  process.env.CANDOR_HOME = home;
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  // Error output is silenced. The tests read the exit code and stdout.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CANDOR_HOME;
  rmSync(home, { recursive: true, force: true });
});

function issue(scenario: Scenario = {}): { json: string; html: string; dir: string } {
  buildRun(scenario);
  const dir = join(home, "out");
  const written = writeReceipt(home, RUN, dir, options);
  return { json: written.json, html: written.html, dir };
}

describe("the receipt of a run with a rule change, re-scores and a restart", () => {
  it("shows the rule, each checkpoint with its first score and its re-score side by side, and the restart with its reason", () => {
    buildRun({ drift: true, m4: true });
    const receipt = composeReceipt(home, RUN, options);
    expect(receipt.rules_added.map((r) => [r.version, r.rule, r.source, r.branch])).toEqual([[2, "op-1", "operator", "A"], [3, "restart-1", "restart", "B"]]);
    expect(receipt.charter_versions.map((c) => c.version)).toEqual([1, 2, 3]);
    expect(receipt.job.charter_version).toBe(3);
    const a1 = receipt.rescores.find((r) => r.checkpoint === "A1");
    expect(a1?.scores.map((x) => [x.kind, x.version, x.overall, x.level])).toEqual([["first", 1, 0.1, "ok"], ["re-score", 2, 0.7, "pause"]]);
    expect(a1?.change).toBe("The level moved from ok to pause.");
    expect(receipt.rescores).toHaveLength(3);
    expect(receipt.corrections).toHaveLength(1);
    expect(receipt.corrections[0]?.detail).toMatch(/From checkpoint A1 on branch A to branch B\. Reason: Stage two touched rows.*restart-1 in charter version 3.*The conversation was forked at the checkpoint\. Branch A was kept\./);
    // It says what a fork keeps and what it cannot, and it does not say the run was reproduced.
    expect(receipt.restart_note).toMatch(/A restart is a fork, not a replay\. It keeps:.*It cannot: Reproduce the old run/);
    expect(receipt.verdicts.stayed_on_course.reasons.join(" ")).toMatch(/restarted once.*every branch count/);
    const html = readFileSync(writeReceipt(home, RUN, join(home, "out-m4"), options).html, "utf8");
    expect(html).toContain("Scores before and after each rule change");
    expect(html).toMatch(/First score, charter version 1: <strong>0\.1 ok<\/strong>/);
    expect(html).toMatch(/Re-score, charter version 2: <strong>0\.7 pause<\/strong>/);
    expect(html).toContain("What the fork keeps.");
    expect(html).toContain("Do not modify records that are not duplicates.");
    expect(html).not.toMatch(/reproduces the old run|identical to the old run/);
  });

  it("states that a checkpoint was not scored again, and does not invent a score for it", () => {
    buildRun({ m4: true });
    const receipt = composeReceipt(home, RUN, options);
    // No drift_score existed for these checkpoints, but each re-score entry stands as written.
    expect(receipt.rescores.map((r) => r.scores.map((x) => x.kind))).toEqual([["re-score"], ["re-score"], ["re-score"]]);
    expect(receipt.rescores[0]?.change).toBe("Not scored again, so there is nothing to compare.");
  });
});

describe("the full receipt", () => {
  it("matches the golden files, byte for byte", () => {
    const { json, html } = issue({ drift: true });
    const files: [string, string][] = [
      [join(GOLDEN, "receipt.json"), readFileSync(json, "utf8")],
      [join(GOLDEN, "receipt.html"), readFileSync(html, "utf8")],
    ];
    if (process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(GOLDEN, { recursive: true });
      for (const [file, content] of files) writeFileSync(file, content);
    }
    for (const [file, content] of files) {
      expect(existsSync(file), `${file} is missing. Run with UPDATE_GOLDEN=1 once and review it.`).toBe(true);
      expect(content).toBe(readFileSync(file, "utf8"));
    }
  });

  it("follows the section order of spec 4.3 and carries every part the spec lists", () => {
    const { html } = issue({ drift: true });
    const page = readFileSync(html, "utf8");
    const order = ["Job and the two verdicts", "Success criteria and their checks", "Charter and its versions", "Run map", "Stages with drift and checks", "Corrections with reasons", "Rule changes and re-scores", "Actions that left the workspace", "Plugins and mods loaded", "Coverage statement", "Overhead", "Integrity and how to verify", "Limits"];
    const at = order.map((h) => page.indexOf(`<h2>${h}</h2>`));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(page).not.toMatch(/<script|<link|src=|http:\/\/|https:\/\//);
    expect(page).toContain("example-mod");
    expect(page).toContain("git push origin main");
    // Colour is never the only signal: each verdict carries a mark and a word.
    expect(page).toMatch(/✔ Yes/);
    expect(page).toMatch(/◐ Partly|✖ No/);
    // Drift appears per stage when the ledger holds scores.
    expect(page).toContain("warn 0.4");
  });

  it("says not scored for drift when the ledger has no drift_score entry", () => {
    buildRun({ drift: false });
    const r = composeReceipt(home, RUN, options);
    expect(r.drift).toEqual({ judged: false, scores: 0 });
    expect(r.stages.every((s) => s.drift.length === 0)).toBe(true);
    expect(r.verdicts.stayed_on_course.not_judged).toMatch(/was not scored/);
    expect(renderReceiptHtml(r)).toMatch(/not scored/);
  });

  it("never claims a run was secure, safe, correct or compliant, and never says proof", () => {
    const { html } = issue({ drift: true });
    // The field value safe_to_restart is a safety class name, and "not tamper-proof" is the one allowed use of that word.
    const page = readFileSync(html, "utf8").replaceAll("safe_to_restart", "").replaceAll("not tamper-proof", "");
    expect(page).not.toMatch(/\b(secure|safe|correct|compliant|proof|tamper-proof)\b/i);
    expect(page).not.toMatch(/\b\w+'\w+\b/);
  });

  it("shows result not verified for a clean process and a wrong result (F19), whichever way the wrong result is found", () => {
    // The key says the final state is wrong although the check of s1 passed.
    buildRun({ s1: "verified", key: "differs" });
    const viaKey = composeReceipt(home, RUN, options);
    expect(viaKey.verdicts.stayed_on_course.verdict).toBe("yes");
    expect(viaKey.verdicts.result_verified.verdict).toBe("no");
    // Both verdicts stay in the record: the checks alone, and the final one after the key. s2 has no check, so the checks alone say partly.
    expect(viaKey.verdicts.result_verified_by_checks.verdict).toBe("partly");
    expect(viaKey.criteria.find((c) => c.id === "s1")?.outcome).toBe("verified_but_wrong");
    expect(viaKey.criteria.find((c) => c.id === "s2")?.outcome).toBe("not_verified");
    rmSync(home, { recursive: true, force: true });
    home = mkdtempSync(join(tmpdir(), "receipt-home-"));
    writeFileSync(receiptKeyPath(home), FIXED_PEM, { mode: 0o600 });
    // The acceptance check itself fails on the final state.
    buildRun({ s1: "failed", key: null });
    const viaCheck = composeReceipt(home, RUN, options);
    expect(viaCheck.verdicts.stayed_on_course.verdict).toBe("yes");
    expect(viaCheck.verdicts.result_verified.verdict).toBe("no");
    expect(viaCheck.criteria.find((c) => c.id === "s1")?.outcome).toBe("not_verified");
  });

  it("keeps the verdict of the checks alone apart from the final verdict, so verified by checks and wrong by key can be counted", () => {
    buildRun({ s1: "verified", key: "differs" });
    const r = composeReceipt(home, RUN, options);
    expect(r.verdicts.result_verified_by_checks.reasons.join(" ")).not.toMatch(/differs/);
    expect(r.verdicts.result_verified.reasons.join(" ")).toMatch(/differs from the answer key/);
    expect(r.criteria.filter((c) => c.outcome === "verified_but_wrong").map((c) => c.id)).toEqual(["s1"]);
  });

  it("prints the verify command with the key id, and that command exits 0 on a copy in a folder with no Candor home", async () => {
    buildRun();
    const dir = join(home, "issued");
    expect(await main(["receipt", RUN, "--out", dir, "--label", "scripted"])).toBe(0);
    const printed = /candor verify (\S+) --key-id (sha256:[0-9a-f]{64})/.exec(out);
    expect(printed).not.toBeNull();
    const keyId = printed?.[2] ?? "";
    const receipt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")) as { integrity: { key_id: string; command: string } };
    expect(receipt.integrity.key_id).toBe(keyId);
    expect(receipt.integrity.command).toBe(`candor verify receipt.json --key-id ${keyId}`);
    expect(readFileSync(join(dir, "receipt.html"), "utf8")).toContain(keyId);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain(`candor verify receipt.json --key-id ${keyId}`);
    // Copy the folder where there is no Candor home and no key.
    const { cpSync } = await import("node:fs");
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    cpSync(dir, join(elsewhere, "folder"), { recursive: true });
    process.env.CANDOR_HOME = mkdtempSync(join(tmpdir(), "no-home-"));
    out = "";
    expect(await main(["verify", join(elsewhere, "folder", "receipt.json"), "--key-id", keyId])).toBe(0);
    expect(out).toMatch(/PASS\s+signer/);
    expect(out).toMatch(/RESULT: PASSED/);
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(process.env.CANDOR_HOME, { recursive: true, force: true });
  });

  it("flags a ledger whose checks verdict disagrees with its criteria, and verify refuses an empty --key-id", async () => {
    buildRun({ s1: "verified" });
    const ledger = Ledger.open({ path: ledgerPath(home, RUN), run: RUN, now: fixedClock("2026-11-18T14:00:00.000Z") });
    ledger.append({ type: "acceptance_result", actor: "candord", body: { criterion: "checks-verdict", scope: "checks_verdict", check: null, status: "yes", reason: "" } });
    const r = composeReceipt(home, RUN, options);
    expect(r.findings.some((f) => f.kind === "record")).toBe(true);
    expect(r.verdicts.result_verified.verdict).toBe("partly");
    const dir = join(home, "o2");
    writeReceipt(home, RUN, dir, options);
    expect(await main(["verify", join(dir, "receipt.json"), "--key-id"])).toBe(2);
  });

  it("does not create a signing key when it only reads the receipt", () => {
    buildRun();
    rmSync(receiptKeyPath(home));
    composeReceipt(home, RUN, options);
    expect(existsSync(receiptKeyPath(home))).toBe(false);
  });

  it("reports verified and right, verified but wrong, and not verified for each criterion", () => {
    buildRun({ key: "matches" });
    const r = composeReceipt(home, RUN, options);
    expect(r.criteria.map((c) => [c.id, c.outcome])).toEqual([["s1", "verified_and_right"], ["s2", "not_verified"]]);
    expect(r.verdicts.result_verified.verdict).toBe("partly");
    expect(r.verdicts.stayed_on_course.verdict).toBe("yes");
  });

  it("says plainly when no answer key was compared", () => {
    buildRun({ key: null });
    const r = composeReceipt(home, RUN, options);
    expect(r.answer_key.status).toBe("not_compared");
    expect(r.criteria[0]?.outcome).toBe("verified_no_second_look");
    expect(r.criteria[0]?.outcome_text).toMatch(/no second look/);
    expect(renderReceiptHtml(r)).not.toMatch(/Verified, matches the answer key/);
  });

  it("includes the coverage statement from docs/COVERAGE.md", () => {
    buildRun();
    const r = composeReceipt(home, RUN, options);
    expect(r.coverage).toContain("The reasoning of the worker. Only actions, outputs and reports are seen.");
    expect(r.coverage_source.file).toBe("docs/COVERAGE.md");
  });
});

describe("signing and candor verify receipt.json", () => {
  it("signs with Ed25519 and detects any changed field", () => {
    const { json } = issue();
    const receipt = JSON.parse(readFileSync(json, "utf8")) as Record<string, unknown>;
    expect(checkSignature(receipt).ok).toBe(true);
    const changed = structuredClone(receipt) as { verdicts: { result_verified: { verdict: string } } };
    changed.verdicts.result_verified.verdict = "yes";
    expect(checkSignature(changed as unknown as Record<string, unknown>)).toMatchObject({ ok: false });
    expect(checkSignature({ ...receipt, signature: null })).toMatchObject({ ok: false });
  });

  it("keeps the private key out of the receipt and the key file private", () => {
    const { json } = issue();
    const raw = readFileSync(json, "utf8");
    expect(raw).not.toContain("PRIVATE KEY");
    expect(raw).not.toContain(FIXED_SEED.toString("base64"));
  });

  it("passes on an untouched receipt and says what it does and does not show", async () => {
    const { json } = issue();
    expect(await main(["verify", json])).toBe(0);
    expect(out).toMatch(/PASS\s+signature/);
    expect(out).toMatch(/PASS\s+chain/);
    expect(out).toMatch(/PASS\s+anchors/);
    expect(out).toMatch(/PASS\s+verdicts/);
    expect(out).toMatch(/What this shows/);
    expect(out).toMatch(/What this does not show/);
    expect(out).toMatch(/tamper-evident on one machine, not tamper-proof/);
  });

  it("fails when the receipt is edited", async () => {
    const { json } = issue();
    writeFileSync(json, readFileSync(json, "utf8").replace('"result_verified": {\n      "verdict": "partly"', '"result_verified": {\n      "verdict": "yes"'));
    expect(await main(["verify", json])).toBe(1);
    expect(out).toMatch(/FAIL\s+signature/);
    expect(out).toMatch(/RESULT: FAILED/);
  });

  it("fails and names the first bad entry when the ledger is edited, even if the receipt is untouched", async () => {
    const { json } = issue();
    const file = ledgerPath(home, RUN);
    chmodSync(file, 0o600);
    writeFileSync(file, readFileSync(file, "utf8").replace('"actor":"operator"', '"actor":"operatoR"'));
    expect(await main(["verify", json])).toBe(1);
    expect(out).toMatch(/FAIL\s+chain: first bad entry \d+/);
  });

  it("fails when the ledger was cut back and rewritten but the anchors remember", async () => {
    const { json } = issue();
    const file = ledgerPath(home, RUN);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeFileSync(file, `${lines.slice(0, lines.length - 3).join("\n")}\n`);
    expect(await main(["verify", json])).toBe(1);
    expect(out).toMatch(/FAIL/);
  });

  it("flags a receipt re-signed with another key: the signature passes and the key is not the key of this machine", async () => {
    const { json } = issue();
    const { generateKeyPairSync, createPublicKey, sign } = await import("node:crypto");
    const { signedBytes } = await import("./sign.js");
    const receipt = JSON.parse(readFileSync(json, "utf8")) as Record<string, unknown>;
    (receipt.verdicts as { result_verified: { verdict: string } }).result_verified.verdict = "yes";
    const pair = generateKeyPairSync("ed25519");
    receipt.signature = {
      alg: "ed25519",
      public_key: createPublicKey(pair.privateKey).export({ type: "spki", format: "der" }).toString("base64"),
      key_id: "x",
      value: sign(null, signedBytes(receipt), pair.privateKey).toString("base64"),
    };
    writeFileSync(json, JSON.stringify(receipt));
    await main(["verify", json]);
    expect(out).toMatch(/PASS\s+signature/);
    expect(out).toMatch(/FAIL\s+signer: this is NOT the signing key of this machine/);
    expect(out).toMatch(/FAIL\s+verdicts/);
    expect(out).toMatch(/RESULT: FAILED/);
  });

  it("checks the chain from the copies beside the receipt on a machine with no Candor home, and says the anchors are copies", async () => {
    const { json, dir } = issue();
    process.env.CANDOR_HOME = mkdtempSync(join(tmpdir(), "empty-home-"));
    // No key to compare with: not a pass, because a forged receipt could be re-signed with any key.
    expect(await main(["verify", json])).toBe(3);
    expect(out).toMatch(/SKIP\s+signer/);
    out = "";
    const id = (JSON.parse(readFileSync(json, "utf8")) as { signature: { key_id: string } }).signature.key_id;
    expect(await main(["verify", json, "--key-id", id])).toBe(0);
    expect(await main(["verify", json, "--key-id", "sha256:00"])).toBe(1);
    expect(out).toMatch(/copies beside the receipt/);
    expect(out).not.toMatch(/PASS\s+verdicts/);
    expect(existsSync(join(dir, "ledger.jsonl"))).toBe(true);
    rmSync(process.env.CANDOR_HOME, { recursive: true, force: true });
  });

  it("exits 3 and says only the signature was checked when no ledger can be found", async () => {
    const { json, dir } = issue();
    rmSync(join(dir, "ledger.jsonl"));
    rmSync(join(dir, "anchors.jsonl"));
    rmSync(join(home, "runs"), { recursive: true, force: true });
    expect(await main(["verify", json])).toBe(3);
    expect(out).toMatch(/SKIP\s+chain and anchors/);
    expect(out).toMatch(/PARTLY CHECKED/);
  });

  it("creates the signing key with mode 0600 outside any workspace the first time", async () => {
    rmSync(receiptKeyPath(home));
    buildRun();
    writeReceipt(home, RUN, join(home, "out"), options);
    expect(existsSync(receiptKeyPath(home))).toBe(true);
    const { statSync } = await import("node:fs");
    expect(statSync(receiptKeyPath(home)).mode & 0o777).toBe(0o600);
  });
});

describe("the answer key comparison", () => {
  it("runs compare.js on a copy of the final workspace and reads its exit code", async () => {
    const oracle = mkdtempSync(join(tmpdir(), "oracle-"));
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    writeFileSync(join(ws, "state.txt"), "good\n");
    writeFileSync(join(oracle, "compare.js"), 'const fs=require("fs");process.exit(fs.readFileSync("state.txt","utf8").trim()==="good"?0:1)');
    expect((await compareWithAnswerKey(oracle, ws, null, 10000)).status).toBe("matches");
    writeFileSync(join(ws, "state.txt"), "bad\n");
    expect((await compareWithAnswerKey(oracle, ws, null, 10000)).status).toBe("differs");
    writeFileSync(join(oracle, "compare.js"), "process.exit(7)");
    expect((await compareWithAnswerKey(oracle, ws, null, 10000)).status).toBe("error");
    rmSync(join(oracle, "compare.js"));
    expect((await compareWithAnswerKey(oracle, ws, null, 10000)).status).toBe("not_compared");
    // The run left the workspace untouched.
    expect(readFileSync(join(ws, "state.txt"), "utf8")).toBe("bad\n");
    rmSync(oracle, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
});
