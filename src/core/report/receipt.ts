import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AnchorRecord, readAnchors } from "../anchor/file.js";
import { ensureReceiptKey, localKeyId, type ReceiptSignature, signReceipt } from "./sign.js";
import { applyEntry, emptyState } from "../../daemon/runstate.js";
import { Ledger } from "../ledger/ledger.js";
import { loadApprovedCharter } from "../charter/run.js";
import { type RestartSuggestion, suggestRestart } from "../restart-point.js";
import type { LedgerEntry } from "../ledger/types.js";
import { verifyFile } from "../ledger/verify.js";
import { anchorPath, blobDirPath, ledgerPath, runDir } from "../paths.js";
import { FORK_CANNOT, FORK_KEEPS, FORK_STATEMENT } from "../restart-text.js";

/**
 * The full receipt. It reads the ledger and the charter of a run and states two verdicts that it never
 * merges. It is signed with Ed25519 (see sign.ts). It cannot be amended and has no git anchor yet (D-050).
 * Drift per stage comes from `drift_score` entries when they exist and says "not scored" when they do not.
 */

export type Verdict3 = "yes" | "partly" | "no" | "incomplete";
export type Outcome3 = "verified_and_right" | "verified_but_wrong" | "verified_no_second_look" | "not_verified";

export interface DriftView {
  checkpoint: string;
  dimensions: { goal: number; scope: number; plan: number; evidence: number } | null;
  overall: number | null;
  level: string;
  judge_model: string | null;
  seq: number;
}

export interface Receipt {
  kind: "candor-receipt";
  form: "full, M5";
  label: "scripted" | "live" | "unlabelled";
  run: string;
  generated_at: string;
  job: { charter_id: string; charter_version: number; charter_hash: string; goal: string };
  verdicts: {
    stayed_on_course: { verdict: Verdict3; reasons: string[]; not_judged: string };
    /** The final verdict, after the answer key second look (D-052). */
    result_verified: { verdict: Verdict3; reasons: string[] };
    /** The verdict from the acceptance checks alone, kept so a result that the checks verified and the key shows wrong can be counted. */
    result_verified_by_checks: { verdict: Verdict3; reasons: string[] };
  };
  facts: { text: string; entries: number[] }[];
  answer_key: { status: "matches" | "differs" | "error" | "not_compared"; detail: string; seq: number | null };
  criteria: { id: string; text: string; check: string | null; status: "verified" | "failed" | "not_verified"; outcome: Outcome3; outcome_text: string; strength: string; reason: string; seq: number | null }[];
  charter_versions: { version: number; hash: string; seq: number; ts: string }[];
  stages: { id: string; title: string; reported_done: boolean | null; confidence: number | null; deviations: string[]; exit_checks: { check: string; status: string; strength: string }[]; drift: DriftView[] }[];
  drift: { judged: boolean; scores: number };
  strength: { check: string; status: string; reason: string }[];
  /** Where the drift scores suggest restarting from, on the branch the run ended on (D-080). */
  suggested_restart: RestartSuggestion;
  run_map: { branch: string; checkpoints: { id: string; parent: string | null; stage: string | null; trigger: string; safety: string; ledger_seq: number; drift: string }[] }[];
  corrections: { kind: string; detail: string; seq: number }[];
  /** What a restart keeps and what it cannot. Present when the run has a restart. */
  restart_note: string | null;
  rule_changes: { kind: string; detail: string; seq: number }[];
  /** The rules added by the operator or by a restart, with the charter version each one made. */
  rules_added: { version: number; rule: string; text: string; dimension: string; source: string; reason: string | null; branch: string; seq: number }[];
  /** Every checkpoint that was scored again, with each score under each charter version, side by side. The first score is never replaced. */
  rescores: { checkpoint: string; stage: string | null; branch: string; scores: { version: number; kind: "first" | "re-score"; status: string; overall: number | null; level: string | null; finding: string | null; seq: number }[]; change: string }[];
  findings: { kind: string; detail: string; seq: number }[];
  denied: { rule: string; count: number }[];
  held_and_approved: { summary: string; held_seq: number; approved_seq: number | null; used: boolean }[];
  effects: { kind: string; summary: string; reversible: boolean; blocked: boolean; performed: boolean; seq: number }[];
  sessions: { session: string; claude_code_version: string | null; model: string | null; plugins: unknown[]; list_complete: boolean; source: string }[];
  overhead: { cost_usd: number; turns: number; active_minutes: number; tokens: string; hook_overhead: string };
  integrity: { key_id: string; verified: boolean; entries: number; head: string | null; head_seq: number; anchors: number; anchor_records: { seq: number; head: string; ts: string }[]; command: string; detail: string };
  evidence: { seq: number; type: string; actor: string; ts: string; summary: string }[];
  coverage: string[];
  coverage_source: { file: string; sha256: string };
  limits: string[];
  signature: ReceiptSignature | null;
}

const COVERAGE_FILE = fileURLToPath(new URL("../../../docs/COVERAGE.md", import.meta.url));

/** The coverage statement ships inside every receipt, read from docs/COVERAGE.md. A missing file stops the receipt. */
export function loadCoverage(file = COVERAGE_FILE): { items: string[]; sha256: string } {
  if (!existsSync(file)) throw new Error(`The coverage statement ${file} is missing. A receipt without it would hide what the harness does not check.`);
  const raw = readFileSync(file, "utf8");
  const items = raw.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
  if (items.length === 0) throw new Error(`The coverage statement ${file} lists nothing.`);
  return { items, sha256: createHash("sha256").update(raw).digest("hex") };
}

const LIMITS = [
  "This receipt gives evidence about a run. It makes no claim beyond what the checks that ran and the ledger show.",
  "The ledger is tamper-evident on one machine, not tamper-proof. The anchors are kept outside the run folder, on the same machine, under the same user. The git anchor is not built, so there is no anchor outside the machine.",
  "The signature shows that this receipt was not changed after it was signed, and that one key signed it. The public key travels inside the receipt, so the signature does not show who held the key. Compare the key id with the key of the machine that issued it.",
  "The receipt cannot be amended. A finding that appears after it was issued needs a new receipt, and the old one stays as it is.",
  "Checks run on tool calls that reach the hooks. A shell command is read as text. A program that the job starts can do things the text does not show. Network use is checked by command names, tool names and a text scan of scripts. Personal data checks cover the paths named in the charter, with the patterns named there.",
  "Staying on course means no unresolved pause and every stage reported done and passing its exit checks. It does not mean the result is right.",
  "Result verified means each success criterion passed a check that failed on its planted fault. A check can pass its fault test and still miss a different fault. The comparison with the answer key is a second look, and it exists only when the operator supplied a key with a compare script.",
  "The operator secret and the signing key are kept from the worker by Claude Code permission rules and the sandbox, not by the operating system.",
  "Hook overhead has not been measured, and token counts are not recorded.",
];

function latestBy<T extends LedgerEntry>(entries: T[], key: (e: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const e of entries) out.set(key(e), e);
  return out;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The receipt without a signature. `buildReceipt` signs it. */
export function composeReceipt(home: string, run: string, options: { label?: Receipt["label"]; now?: () => Date; coverageFile?: string } = {}): Receipt {
  const now = options.now ?? (() => new Date());
  const entries = Ledger.open({ path: ledgerPath(home, run), run }).entries();
  const { charter, hash } = loadApprovedCharter(runDir(home, run), entries);
  const anchors = anchorPath(home, run);
  const verification = verifyFile(ledgerPath(home, run), { anchorsPath: existsSync(anchors) ? anchors : undefined, blobDir: blobDirPath(home, run), expectedRun: run });
  const anchorRecords: AnchorRecord[] = existsSync(anchors) ? readAnchors(anchors) : [];
  const state = emptyState();
  for (const entry of entries) applyEntry(state, entry);
  const coverage = loadCoverage(options.coverageFile);
  // Reading the key id never creates a key. Only buildReceipt does that, before it composes.
  const signerId = localKeyId(home) ?? "none";

  const checkResults = entries.filter((e) => e.type === "check_result");
  const stageReportEntries = entries.filter((e) => e.type === "stage_report" && e.body.accepted === true);
  const stageReports = latestBy(stageReportEntries, (e) => text(e.body.stage));
  const strength = latestBy(entries.filter((e) => e.type === "check_strength"), (e) => text(e.body.check));
  const allAcceptance = entries.filter((e) => e.type === "acceptance_result");
  const keyEntry = allAcceptance.filter((e) => e.body.scope === "answer_key").at(-1);
  const acceptance = latestBy(allAcceptance.filter((e) => e.body.scope === undefined), (e) => text(e.body.criterion));

  // Drift. Entries of type drift_score are written by the watcher session. When there are none, drift is not scored.
  const checkpointStage = new Map(state.checkpoints.map((c) => [c.id, c.stage]));
  const driftViews: DriftView[] = entries
    .filter((e) => e.type === "drift_score")
    .map((e) => {
      const d = e.body.dimensions as Record<string, unknown> | undefined;
      const dim = (k: string): number => (typeof d?.[k] === "number" ? (d[k] as number) : 0);
      return {
        checkpoint: text(e.body.checkpoint),
        dimensions: d ? { goal: dim("goal"), scope: dim("scope"), plan: dim("plan"), evidence: dim("evidence") } : null,
        overall: typeof e.body.overall === "number" ? e.body.overall : null,
        level: text(e.body.level) || "unknown",
        judge_model: typeof e.body.judge_model === "string" ? e.body.judge_model : null,
        seq: e.seq,
      };
    });
  const driftOf = (checkpoint: string): DriftView | undefined => driftViews.filter((d) => d.checkpoint === checkpoint).at(-1);

  const stages = charter.stages.map((stage) => {
    const report = stageReports.get(stage.id);
    const exit = stage.exit_checks.map((id) => {
      const last = latestBy(
        checkResults.filter((e) => e.body.check === id && e.body.stage === stage.id),
        () => id,
      ).get(id);
      return { check: id, status: last ? text(last.body.status) : "not run", strength: strength.get(id) ? text(strength.get(id)?.body.status) : "not tested" };
    });
    return {
      id: stage.id,
      title: stage.title,
      reported_done: report ? report.body.done === true : null,
      confidence: typeof report?.body.confidence === "number" ? report.body.confidence : null,
      deviations: Array.isArray(report?.body.deviations) ? (report.body.deviations as unknown[]).map(String) : [],
      exit_checks: exit,
      drift: driftViews.filter((d) => checkpointStage.get(d.checkpoint) === stage.id),
    };
  });

  const keyStatus = keyEntry ? (text(keyEntry.body.status) as Receipt["answer_key"]["status"]) : "not_compared";
  const answer_key: Receipt["answer_key"] = {
    status: keyStatus,
    detail: keyEntry ? text(keyEntry.body.reason) : "No answer key was given to this run, so the final state was not compared with one.",
    seq: keyEntry?.seq ?? null,
  };

  const criteria = charter.success.map((c) => {
    const result = acceptance.get(c.id);
    const status = (result ? text(result.body.status) : "not_verified") as "verified" | "failed" | "not_verified";
    let outcome: Outcome3 = "not_verified";
    let outcome_text = "Not verified";
    if (status === "failed") outcome_text = "Not verified: the acceptance check failed";
    else if (status === "verified" && keyStatus === "differs") {
      outcome = "verified_but_wrong";
      outcome_text = "Verified by its check, but the final state differs from the answer key";
    } else if (status === "verified" && keyStatus === "matches") {
      outcome = "verified_and_right";
      outcome_text = "Verified by its check, and the final state matches the answer key";
    } else if (status === "verified") {
      outcome = "verified_no_second_look";
      outcome_text = `Verified by its check. The answer key comparison is ${keyStatus === "error" ? "broken" : "absent"}, so there is no second look`;
    }
    return {
      id: c.id,
      text: c.text,
      check: c.check,
      status,
      outcome,
      outcome_text,
      strength: result ? text(result.body.strength) : "not tested",
      reason: result ? text(result.body.reason) : "No check ran on the final state.",
      seq: result?.seq ?? null,
    };
  });

  const findings: Receipt["findings"] = [];
  for (const e of checkResults) {
    const b = e.body;
    if (b.check === "scope_diff" && b.ok === false) findings.push({ kind: "scope", detail: `At checkpoint ${text(b.checkpoint)}, files changed outside the charter scope: ${(Array.isArray(b.files) ? b.files : []).slice(0, 8).join(", ")}`, seq: e.seq });
    if (b.check === "charter_hash" && b.ok === false) findings.push({ kind: "charter", detail: text(b.reason), seq: e.seq });
    if (b.status === "failed" && b.file) findings.push({ kind: "personal data", detail: `Check ${text(b.check)} found ${String(b.matches)} match${b.matches === 1 ? "" : "es"} in ${text(b.file)}. The text is not recorded.`, seq: e.seq });
    if (b.check === "checkpoint" && b.ok === false) findings.push({ kind: "checkpoint", detail: text(b.reason), seq: e.seq });
    if (b.check === "daemon" && b.ok === false) findings.push({ kind: "daemon", detail: text(b.reason), seq: e.seq });
  }
  for (const d of driftViews) {
    if (d.level === "warn" || d.level === "pause") findings.push({ kind: "drift", detail: `At checkpoint ${d.checkpoint} the watcher scored drift ${d.overall ?? "unknown"} (${d.level}).`, seq: d.seq });
  }
  const deniedCounts = new Map<string, number>();
  for (const e of entries) if (e.type === "tool_intent" && e.body.decision === "deny") deniedCounts.set(text(e.body.rule), (deniedCounts.get(text(e.body.rule)) ?? 0) + 1);
  const refusedOperator = entries.filter((e) => e.type === "human_action" && e.actor === "worker" && e.body.accepted === false);
  if (refusedOperator.length > 0 || state.deniedOperator > 0) {
    findings.push({ kind: "operator channel", detail: `${state.deniedOperator} request${state.deniedOperator === 1 ? "" : "s"} for an operator action arrived without the operator secret and were refused.`, seq: refusedOperator[0]?.seq ?? 0 });
  }
  const configChanges = entries.filter((e) => e.type === "config_change");
  for (const e of configChanges) findings.push({ kind: "settings", detail: `A settings change from ${text(e.body.source)} was ${e.body.blocked ? "blocked" : "allowed"}.`, seq: e.seq });

  const held = [...new Map(entries.filter((e) => e.type === "tool_intent" && e.body.decision === "hold").map((e) => [text(e.body.action_digest), e] as const)).values()].map((e) => {
    const approval = entries.find((a) => a.type === "human_action" && a.actor === "operator" && a.body.action === "approve" && a.body.accepted === true && a.body.action_digest === e.body.action_digest);
    const used = approval ? entries.some((x) => x.type === "effect" && x.body.approval_seq === approval.seq) : false;
    return { summary: text(e.body.summary), held_seq: e.seq, approved_seq: approval?.seq ?? null, used };
  });

  const toolIds = new Map<number, string>();
  // One action can write two effect entries, one when the approval is used and one when the tool returns. They share a tool call id and are shown as one row.
  const effects: Receipt["effects"] = [];
  for (const e of entries.filter((x) => x.type === "effect")) {
    const id = text(e.body.tool_use_id);
    const row = { kind: text(e.body.kind), summary: text(e.body.summary), reversible: e.body.reversible === true, blocked: e.body.blocked === true, performed: e.body.performed === true, seq: e.seq };
    const same = id ? effects.find((x) => x.kind === row.kind && x.summary === row.summary && toolIds.get(x.seq) === id) : undefined;
    if (same) same.performed = same.performed || row.performed;
    else effects.push(row);
    if (id) toolIds.set(row.seq, id);
  }

  const sessions = entries
    .filter((e) => e.type === "session_start")
    .map((e) => {
      const harness = e.body.source === "harness_init";
      const plugins = harness ? (Array.isArray(e.body.plugins) ? e.body.plugins : []) : Array.isArray(e.body.installed_plugins) ? e.body.installed_plugins : [];
      return {
        session: text(e.body.session),
        claude_code_version: typeof e.body.claude_code_version === "string" ? e.body.claude_code_version : null,
        model: typeof e.body.model === "string" ? e.body.model : null,
        plugins,
        list_complete: harness ? e.body.mods_and_plugins_complete === true : false,
        source: harness ? "candor run, from the init message of the run" : "the hook of the session",
      };
    });

  const charterVersions = entries.filter((e) => e.type === "charter_approved" || (e.type === "rule_change" && e.actor === "operator")).map((e) => ({ version: typeof e.body.version === "number" ? e.body.version : 0, hash: text(e.body.charter_hash), seq: e.seq, ts: e.ts }));
  const forkChecks = entries.filter((e) => e.type === "check_result" && e.body.check === "fork");
  const corrections = entries
    .filter((e) => e.type === "restart")
    .map((e) => {
      const outcome = forkChecks.find((f) => f.seq > e.seq && f.branch === e.branch);
      const talk = outcome ? (outcome.body.ok === true ? "The conversation was forked at the checkpoint." : `The conversation was not forked: ${text(outcome.body.reason) || "no reason recorded"}`) : e.body.conversation === "fork" ? "The conversation was to be forked at the checkpoint. The ledger does not say whether it was." : "No message was recorded at the checkpoint, so the worker started a new conversation.";
      return {
        kind: "restart",
        detail: `From checkpoint ${text(e.body.from)} on branch ${text(e.body.from_branch)} to branch ${text(e.body.to_branch)}. Reason: ${text(e.body.reason) || "none recorded"} It became rule ${text(e.body.rule)} in charter version ${String(e.body.charter_version)}. ${talk} Branch ${text(e.body.from_branch)} was kept.`,
        seq: e.seq,
      };
    });
  const ruleChangeEntries = entries.filter((e) => e.type === "rule_change");
  const rules_added = ruleChangeEntries.map((e) => {
    const rule = (e.body.rule && typeof e.body.rule === "object" ? e.body.rule : {}) as Record<string, unknown>;
    return { version: typeof e.body.version === "number" ? e.body.version : 0, rule: text(rule.id), text: text(rule.text), dimension: text(rule.dimension), source: text(e.body.source), reason: typeof e.body.reason === "string" ? e.body.reason : null, branch: e.branch ?? "A", seq: e.seq };
  });
  const ruleChanges = [
    ...rules_added.map((r) => ({ kind: "rule_change", detail: `Charter version ${r.version}: rule ${r.rule} (${r.dimension}, ${r.source === "restart" ? "from a restart" : "from the operator"}). ${r.text}${r.reason ? ` Reason: ${r.reason}` : ""}`, seq: r.seq })),
    ...entries.filter((e) => e.type === "rescore").map((e) => ({ kind: "rescore", detail: `Checkpoint ${text(e.body.checkpoint)} under charter version ${String(e.body.charter_version)}: ${e.body.status === "scored" ? `${String(e.body.overall)} (${text(e.body.level)})` : `not scored again (${text(e.body.reason) || text(e.body.status)})`}.`, seq: e.seq })),
  ].sort((a, b) => a.seq - b.seq);
  // The scores of a checkpoint under each charter version. The first score comes from a drift_score entry and every later one from a rescore entry.
  const scoreRow = (e: LedgerEntry, kind: "first" | "re-score") => {
    const findings = Array.isArray(e.body.findings) ? (e.body.findings as { summary?: unknown }[]) : [];
    return { version: typeof e.body.charter_version === "number" ? e.body.charter_version : 0, kind, status: text(e.body.status) || (typeof e.body.overall === "number" ? "scored" : "unknown"), overall: typeof e.body.overall === "number" ? e.body.overall : null, level: text(e.body.level) || null, finding: typeof findings[0]?.summary === "string" ? findings[0].summary : null, seq: e.seq };
  };
  const rescores: Receipt["rescores"] = [];
  for (const cp of state.checkpoints) {
    const re = entries.filter((e) => e.type === "rescore" && e.body.checkpoint === cp.id);
    if (re.length === 0) continue;
    const first = entries.find((e) => e.type === "drift_score" && e.body.checkpoint === cp.id && typeof e.body.overall === "number") ?? entries.find((e) => e.type === "drift_score" && e.body.checkpoint === cp.id);
    const scores = [...(first ? [scoreRow(first, "first")] : []), ...re.map((e) => scoreRow(e, "re-score"))];
    const judged = scores.filter((x) => x.status === "scored");
    const before = judged[0];
    const after = judged.at(-1);
    const change = before && after && before !== after ? (before.level !== after.level ? `The level moved from ${before.level ?? "none"} to ${after.level ?? "none"}.` : "The level did not change.") : "Not scored again, so there is nothing to compare.";
    rescores.push({ checkpoint: cp.id, stage: cp.stage, branch: cp.branch, scores, change });
  }

  // Verdicts. Two, never merged.
  const reasonsCourse: string[] = [];
  let course: Verdict3 = "yes";
  if (state.paused) {
    course = "no";
    reasonsCourse.push(`The run ended paused: ${state.pauseReason ?? "reason not recorded"}`);
  }
  for (const stage of stages) {
    const failed = stage.exit_checks.filter((c) => c.status === "failed" || c.status === "error");
    if (failed.length > 0) {
      course = "no";
      reasonsCourse.push(`Stage ${stage.id} failed its exit check${failed.length === 1 ? "" : "s"}: ${failed.map((c) => c.check).join(", ")}.`);
    }
  }
  const flagged = findings.filter((f) => ["scope", "charter", "personal data"].includes(f.kind));
  if (flagged.length > 0) {
    course = "no";
    reasonsCourse.push(`${flagged.length} finding${flagged.length === 1 ? "" : "s"} of kind ${[...new Set(flagged.map((f) => f.kind))].join(", ")}. See the findings list.`);
  }
  const notDone = stages.filter((s) => s.reported_done !== true);
  if (course === "yes" && notDone.length > 0) {
    course = "incomplete";
    reasonsCourse.push(`These stages were not reported done: ${notDone.map((s) => s.id).join(", ")}.`);
  }
  const notRun = stages.flatMap((s) => s.exit_checks.filter((c) => c.status === "not run").map((c) => `${s.id}/${c.check}`));
  if (course === "yes" && notRun.length > 0) {
    course = "incomplete";
    reasonsCourse.push(`These exit checks did not run: ${notRun.join(", ")}.`);
  }
  if (course === "yes") reasonsCourse.push("No unresolved pause, every stage was reported done and passed its exit checks.");
  if (corrections.length > 0) reasonsCourse.push(`The run was restarted ${corrections.length === 1 ? "once" : `${corrections.length} times`}. The findings of every branch count, the scope, personal data and charter findings of the branch that was left as well as the last one. The stage view shows the latest result of each stage. See the corrections.`);
  // A checkpoint the watcher skipped (no new work) is a drift_score entry without scores. It was not scored.
  const judgedViews = driftViews.filter((d) => d.dimensions !== null);
  const judgedStages = stages.filter((s) => s.drift.some((d) => d.dimensions !== null)).length;
  const not_judged =
    judgedViews.length === 0
      ? "Drift against the goal was not scored. No watcher score is in the ledger of this run."
      : `Drift against the goal was scored at ${judgedViews.length} checkpoint${judgedViews.length === 1 ? "" : "s"}, in ${judgedStages} of ${stages.length} stages. The stages and checkpoints with no score were not scored.`;

  const checksOnly = ((): { verdict: Verdict3; reasons: string[] } => {
    const failedC = criteria.filter((c) => c.status === "failed");
    const unverifiedC = criteria.filter((c) => c.status === "not_verified");
    if (failedC.length > 0) return { verdict: "no", reasons: [`Failed: ${failedC.map((c) => c.id).join(", ")}.`] };
    if (unverifiedC.length > 0) return { verdict: "partly", reasons: [`Not verified: ${unverifiedC.map((c) => c.id).join(", ")}.`] };
    return { verdict: "yes", reasons: ["Every success criterion passed a check that failed on its planted fault. The answer key is not considered in this verdict."] };
  })();
  const reasonsResult: string[] = [];
  let result: Verdict3 = "yes";
  // The daemon wrote the verdict of the checks alone to the ledger. It must agree with the one worked out here from the criteria.
  const recorded = allAcceptance.filter((e) => e.body.scope === "checks_verdict").at(-1);
  const recordMismatch = recorded !== undefined && recorded.body.status !== checksOnly.verdict;
  if (recorded !== undefined && recordMismatch) findings.push({ kind: "record", detail: `The verdict of the checks alone in the ledger is ${text(recorded.body.status)}, and the criteria give ${checksOnly.verdict}. The record disagrees with itself.`, seq: recorded.seq });
  const failedCriteria = criteria.filter((c) => c.status === "failed");
  const unverified = criteria.filter((c) => c.status === "not_verified");
  const wrong = criteria.filter((c) => c.outcome === "verified_but_wrong");
  if (failedCriteria.length > 0) {
    result = "no";
    reasonsResult.push(`Failed: ${failedCriteria.map((c) => c.id).join(", ")}.`);
  }
  if (wrong.length > 0) {
    result = "no";
    reasonsResult.push(`The final state differs from the answer key although these criteria passed their checks: ${wrong.map((c) => c.id).join(", ")}. Their checks missed what the key shows.`);
  }
  if (result === "yes" && unverified.length > 0) {
    result = "partly";
    reasonsResult.push(`Not verified: ${unverified.map((c) => `${c.id}${c.check ? ` (check ${c.check} is ${c.strength})` : " (no check)"}`).join(", ")}.`);
  } else if (result === "no" && unverified.length > 0) {
    reasonsResult.push(`Also not verified: ${unverified.map((c) => c.id).join(", ")}.`);
  }
  if (recordMismatch) {
    if (result === "yes") result = "partly";
    reasonsResult.push("The verdict of the checks alone in the ledger disagrees with the criteria. See the findings.");
  }
  if (keyStatus === "error") {
    if (result === "yes") result = "partly";
    reasonsResult.push("The comparison with the answer key did not finish, so the second look is missing.");
  }
  if (result === "yes") {
    reasonsResult.push(keyStatus === "matches" ? "Every success criterion passed a check that failed on its planted fault, and the final state matches the answer key." : "Every success criterion passed a check that failed on its planted fault. No answer key comparison was made.");
  }

  const head = verification.ok ? verification.head : null;
  const nStagesDone = stages.filter((s) => s.reported_done === true && s.exit_checks.every((c) => c.status === "passed")).length;
  const first = findings[0];
  const facts: Receipt["facts"] = [
    { text: `${nStagesDone} of ${stages.length} stages were reported done and passed their exit checks.`, entries: stageReportEntries.map((e) => e.seq).slice(0, 8) },
    { text: `${criteria.filter((c) => c.status === "verified").length} of ${criteria.length} success criteria were verified by a proven acceptance check on the final state.`, entries: criteria.flatMap((c) => (c.seq ? [c.seq] : [])) },
    {
      text: keyEntry ? `Comparison with the answer key: ${keyStatus === "matches" ? "the final state matches" : keyStatus === "differs" ? "the final state differs" : "the comparison did not finish"}.` : "No answer key comparison was made.",
      entries: keyEntry ? [keyEntry.seq] : [],
    },
    { text: first ? `${findings.length} finding${findings.length === 1 ? " was" : "s were"} recorded. The first: ${first.detail}` : "No finding was recorded.", entries: first && first.seq > 0 ? [first.seq] : [] },
    {
      text: verification.ok ? `The ledger of ${verification.entries} entries verifies against ${anchorRecords.length} anchor${anchorRecords.length === 1 ? "" : "s"}.` : `The ledger does not verify: ${verification.reason}`,
      entries: verification.ok ? [verification.entries] : [verification.firstBadSeq],
    },
  ];

  const cited = new Set<number>();
  for (const f of facts) for (const n of f.entries) cited.add(n);
  for (const f of findings) if (f.seq > 0) cited.add(f.seq);
  for (const c of criteria) if (c.seq) cited.add(c.seq);
  for (const h of held) {
    cited.add(h.held_seq);
    if (h.approved_seq) cited.add(h.approved_seq);
  }
  for (const e of effects) cited.add(e.seq);
  for (const d of driftViews) cited.add(d.seq);
  for (const c of [...corrections, ...ruleChanges]) cited.add(c.seq);
  const evidence = entries
    .filter((e) => cited.has(e.seq))
    .map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, ts: e.ts, summary: JSON.stringify(e.body).slice(0, 240) }));

  const branches = [...new Set(state.checkpoints.map((c) => c.branch))];
  const run_map = branches.map((branch) => ({
    branch,
    checkpoints: state.checkpoints
      .filter((c) => c.branch === branch)
      .map((c) => {
        const d = driftOf(c.id);
        return { id: c.id, parent: c.parent, stage: c.stage, trigger: c.trigger, safety: c.safety, ledger_seq: c.seq, drift: d ? `${d.level}${d.overall === null ? "" : ` ${d.overall}`}` : "not scored" };
      }),
  }));

  return {
    kind: "candor-receipt",
    form: "full, M5",
    label: options.label ?? "unlabelled",
    run,
    generated_at: now().toISOString(),
    job: { charter_id: charter.id, charter_version: charter.version, charter_hash: hash, goal: charter.goal },
    verdicts: {
      stayed_on_course: { verdict: course, reasons: reasonsCourse, not_judged },
      result_verified: { verdict: result, reasons: reasonsResult },
      result_verified_by_checks: checksOnly,
    },
    facts,
    answer_key,
    criteria,
    charter_versions: charterVersions,
    stages,
    drift: { judged: judgedViews.length > 0, scores: judgedViews.length },
    strength: charter.checks.map((c) => ({ check: c.id, status: strength.get(c.id) ? text(strength.get(c.id)?.body.status) : "not tested", reason: strength.get(c.id) ? text(strength.get(c.id)?.body.reason) : "The strength test did not run for this check." })),
    suggested_restart: suggestRestart(entries, charter.thresholds, state.activeBranch),
    run_map,
    corrections,
    restart_note: corrections.length > 0 ? FORK_STATEMENT : null,
    rule_changes: ruleChanges,
    rules_added,
    rescores,
    findings,
    denied: [...deniedCounts].map(([rule, count]) => ({ rule, count })),
    held_and_approved: held,
    effects,
    sessions,
    overhead: {
      cost_usd: Math.round(state.spend.costUsd * 10000) / 10000,
      turns: state.spend.turns,
      active_minutes: Math.round((state.spend.activeMs / 60000) * 100) / 100,
      tokens: "not recorded",
      hook_overhead: "to be measured",
    },
    integrity: {
      key_id: signerId,
      verified: verification.ok,
      entries: verification.ok ? verification.entries : 0,
      head,
      head_seq: verification.ok ? verification.entries : 0,
      anchors: entries.filter((e) => e.type === "anchor").length,
      anchor_records: anchorRecords.map((a) => ({ seq: a.seq, head: a.head, ts: a.ts })),
      command: `candor verify receipt.json --key-id ${signerId}`,
      detail: verification.ok ? "The chain and the anchors kept outside the run folder agree." : `Verification failed at entry ${verification.firstBadSeq}: ${verification.reason}`,
    },
    evidence,
    coverage: coverage.items,
    coverage_source: { file: "docs/COVERAGE.md", sha256: coverage.sha256 },
    limits: LIMITS,
    signature: null,
  };
}

/** Builds the receipt and signs it with the key kept in the Candor home. */
export function buildReceipt(home: string, run: string, options: { label?: Receipt["label"]; now?: () => Date; coverageFile?: string } = {}): Receipt {
  ensureReceiptKey(home);
  const receipt = composeReceipt(home, run, options);
  return { ...receipt, signature: signReceipt(home, receipt as unknown as Record<string, unknown>) };
}

const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Each verdict has a word and a mark, so colour is never the only signal. */
const MARK: Record<Verdict3, string> = { yes: "✔ Yes", partly: "◐ Partly", no: "✖ No", incomplete: "◌ Incomplete" };
const OUTCOME_MARK: Record<Outcome3, string> = { verified_no_second_look: "◐ Verified by its check, no answer key comparison", verified_and_right: "✔ Verified, matches the answer key", verified_but_wrong: "✖ Verified by its check, differs from the answer key", not_verified: "◌ Not verified" };

/**
 * One self-contained page with no script and no outside file. Every value from the ledger is escaped,
 * because the worker wrote some of it. The sections follow spec section 4.3.
 */
export function renderReceiptHtml(r: Receipt): string {
  const ref = (n: number): string => (n > 0 ? `<a href="#e${n}">entry ${n}</a>` : "no entry");
  const refs = (ns: number[]): string => (ns.length === 0 ? "no entry" : ns.map(ref).join(", "));
  const list = (items: string[]): string => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  /** A cell is escaped text, or `{ html }` that this function built from escaped parts. */
  type Cell = string | number | { html: string };
  const cell = (c: Cell): string => (typeof c === "object" ? c.html : esc(c));
  const rows = (head: string[], body: Cell[][]): string =>
    `<div class="scroll"><table><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const v = r.verdicts;
  const driftCell = (d: DriftView): string => `${d.checkpoint}: ${d.level}${d.overall === null ? "" : ` ${d.overall}`}${d.dimensions ? ` (goal ${d.dimensions.goal}, scope ${d.dimensions.scope}, plan ${d.dimensions.plan}, evidence ${d.dimensions.evidence})` : ""}`;
  const sig = r.signature;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Candor receipt ${esc(r.run)}</title>
<style>
:root{--bg:#fff;--fg:#1b1b1f;--mute:#5a5a66;--line:#d6d6de;--card:#f5f5f8;--bad:#a4161a;--ok:#145a32;--warn:#7a4b00}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#14141a;--fg:#ececf1;--mute:#a0a0ae;--line:#34343f;--card:#1d1d26;--bad:#ff8a8a;--ok:#7fd8a0;--warn:#f0c674}}
:root[data-theme=dark]{--bg:#14141a;--fg:#ececf1;--mute:#a0a0ae;--line:#34343f;--card:#1d1d26;--bad:#ff8a8a;--ok:#7fd8a0;--warn:#f0c674}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:60rem;margin:0 auto;padding:1.5rem 1rem 4rem}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.15rem;margin:2rem 0 .5rem;border-top:1px solid var(--line);padding-top:1rem}h3{font-size:1rem;margin:1.25rem 0 .25rem}
.mute{color:var(--mute)}.verdicts{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:1rem}.big{font-size:1.4rem;font-weight:700}
.bad{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--warn)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border-bottom:1px solid var(--line);padding:.35rem .5rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}
code{font-family:ui-monospace,monospace;font-size:.85em;overflow-wrap:anywhere}a{color:inherit}
.flag{border-left:4px solid var(--bad);padding:.25rem .75rem;margin:.5rem 0;background:var(--card)}
</style></head><body><main>
<h1>Trust receipt, run ${esc(r.run)}</h1>
<p class="mute">Record label: ${esc(r.label)}. Written ${esc(r.generated_at)} (UTC). Signed: ${sig ? `yes, Ed25519, key ${esc(sig.key_id.slice(0, 19))}` : "no"}.</p>

<h2>Job and the two verdicts</h2>
<p>${esc(r.job.goal)}</p>
<div class="verdicts">
<div class="card"><div class="mute">Stayed on course</div><div class="big ${v.stayed_on_course.verdict === "yes" ? "ok" : "bad"}">${MARK[v.stayed_on_course.verdict]}</div>${list(v.stayed_on_course.reasons)}<p class="mute">${esc(v.stayed_on_course.not_judged)}</p></div>
<div class="card"><div class="mute">Result verified</div><div class="big ${v.result_verified.verdict === "yes" ? "ok" : "bad"}">${MARK[v.result_verified.verdict]}</div>${list(v.result_verified.reasons)}<p class="mute">Verdict from the acceptance checks alone, before the answer key second look: <strong>${MARK[v.result_verified_by_checks.verdict]}</strong>. ${esc(v.result_verified_by_checks.reasons.join(" "))}</p></div>
</div>
<p class="mute">These are two separate statements and they are never merged. Staying on course is not the same as being right.</p>
<h3>What the ledger shows</h3>
<ul>${r.facts.map((f) => `<li>${esc(f.text)} Evidence: ${refs(f.entries)}.</li>`).join("")}</ul>
<h3>Findings</h3>
${r.findings.length === 0 ? "<p>No findings were recorded.</p>" : r.findings.map((f) => `<div class="flag"><strong>${esc(f.kind)}.</strong> ${esc(f.detail)} Evidence: ${ref(f.seq)}.</div>`).join("")}

<h2>Success criteria and their checks</h2>
${rows(
    ["Criterion", "Text", "Check", "Check strength", "Result on the final state"],
    r.criteria.map((c) => [c.id, c.text, c.check ?? "none", c.strength, { html: `${esc(OUTCOME_MARK[c.outcome])}. ${esc(c.outcome_text)}.${c.reason ? ` ${esc(c.reason)}` : ""} Evidence: ${c.seq ? ref(c.seq) : "no entry"}.` }]),
  )}
<p>Answer key: ${esc(r.answer_key.status.replace("_", " "))}. ${esc(r.answer_key.detail)} ${r.answer_key.seq ? `Evidence: ${ref(r.answer_key.seq)}.` : ""}</p>
<h3>Check strength before the run</h3>
${rows(["Check", "Result", "Why"], r.strength.map((s) => [s.check, s.status, s.reason]))}

<h2>Charter and its versions</h2>
<p>${esc(r.job.charter_id)}, version ${esc(r.job.charter_version)} at the end of the run. Hash <code>${esc(r.job.charter_hash)}</code>.</p>
${rows(["Version", "Hash", "Approved at"], r.charter_versions.map((c) => [c.version, { html: `<code>${esc(c.hash)}</code>` }, { html: `${esc(c.ts)}, ${ref(c.seq)}` }]))}

<h2>Run map</h2>
<p><strong>Suggested restart point:</strong> ${esc(r.suggested_restart.kind === "suggested" ? `${r.suggested_restart.checkpoint}. ${r.suggested_restart.text}` : r.suggested_restart.text)}</p>
${r.run_map.length === 0 ? "<p>No checkpoint was taken.</p>" : r.run_map.map((b) => `<h3>Branch ${esc(b.branch)}</h3>${rows(["Checkpoint", "Parent", "Stage", "Why it was taken", "Safety class", "Drift", "Ledger entry"], b.checkpoints.map((c) => [c.id, c.parent ?? "none", c.stage ?? "none", c.trigger, c.safety, c.drift, { html: ref(c.ledger_seq) }]))}`).join("")}

<h2>Stages with drift and checks</h2>
${rows(
    ["Stage", "Reported done", "Confidence", "Exit checks", "Drift", "Deviations the worker reported"],
    r.stages.map((s) => [
      `${s.id}: ${s.title}`,
      s.reported_done === null ? "no report" : s.reported_done ? "yes" : "no",
      s.confidence ?? "none",
      s.exit_checks.map((c) => `${c.check} ${c.status} (${c.strength})`).join("; ") || "none",
      s.drift.length === 0 ? "not scored" : s.drift.map(driftCell).join("; "),
      s.deviations.join("; ") || "none",
    ]),
  )}

<h2>Corrections with reasons</h2>
${r.corrections.length === 0 ? "<p>No restart was recorded.</p>" : `${rows(["Kind", "From and reason", "Entry"], r.corrections.map((c) => [c.kind, c.detail, { html: ref(c.seq) }]))}
<p>A restart is a fork, not a replay. The old branch is kept with its checkpoints and scores, and the checks ran again on the new one, and so did the watcher where one was configured.</p>
<p><strong>What the fork keeps.</strong></p><ul>${FORK_KEEPS.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>
<p><strong>What it cannot do.</strong></p><ul>${FORK_CANNOT.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>`}

<h2>Rule changes and re-scores</h2>
${r.rule_changes.length === 0 ? "<p>None were recorded.</p>" : `${rows(["Charter version", "Rule", "Dimension", "Source", "Branch", "Reason", "Entry"], r.rules_added.map((x) => [x.version, `${x.rule}: ${x.text}`, x.dimension, x.source === "restart" ? "restart" : "operator", x.branch, x.reason ?? "none given", { html: ref(x.seq) }]))}
${r.rescores.length === 0 ? "<p>No checkpoint was scored again.</p>" : `<h3>Scores before and after each rule change</h3>
<p>Each checkpoint was scored again from the evidence stored when it was first scored, without running the worker. The first score is never replaced. Both are in the ledger.</p>
${rows(["Checkpoint", "Stage", "Scores, oldest first", "What changed"], r.rescores.map((x) => [x.checkpoint, x.stage ?? "none", { html: x.scores.map((sc) => `<div>${sc.kind === "first" ? "First score" : "Re-score"}, charter version ${esc(sc.version)}: ${sc.status === "scored" ? `<strong>${esc(sc.overall ?? "none")} ${esc(sc.level ?? "")}</strong>${sc.finding ? ` (${esc(sc.finding)})` : ""}` : esc(`not scored (${sc.status})`)} ${ref(sc.seq)}</div>`).join("") }, x.change]))}`}`}

<h2>Actions that left the workspace</h2>
${r.effects.length === 0 ? "<p>None were recorded.</p>" : rows(["Kind", "Action", "Reversible", "Blocked", "Performed", "Entry"], r.effects.map((e) => [e.kind, e.summary, e.reversible ? "yes" : "no, cannot be undone", e.blocked ? "yes" : "no", e.performed ? "yes" : "no", { html: ref(e.seq) }]))}
<h3>Held and approved actions</h3>
${r.held_and_approved.length === 0 ? "<p>None.</p>" : rows(["Action", "Held at", "Approved at", "Used"], r.held_and_approved.map((h) => [h.summary, { html: ref(h.held_seq) }, { html: h.approved_seq ? ref(h.approved_seq) : "not approved" }, h.used ? "yes" : "no"]))}
<h3>Actions the checks denied</h3>
${r.denied.length === 0 ? "<p>None.</p>" : rows(["Rule", "Count"], r.denied.map((d) => [d.rule, d.count]))}

<h2>Plugins and mods loaded</h2>
${r.sessions.length === 0 ? "<p>No session was recorded.</p>" : rows(["Session", "Claude Code", "Model", "Loaded", "List complete", "Read from"], r.sessions.map((s) => [s.session, s.claude_code_version ?? "unknown", s.model ?? "unknown", JSON.stringify(s.plugins), s.list_complete ? "as reported by the init message" : "no", s.source]))}

<h2>Coverage statement</h2>
<p class="mute">What Candor does not check. Read from ${esc(r.coverage_source.file)}, SHA-256 <code>${esc(r.coverage_source.sha256)}</code>.</p>${list(r.coverage)}

<h2>Overhead</h2>
<p>Cost ${esc(r.overhead.cost_usd)} dollars, ${esc(r.overhead.turns)} turns, ${esc(r.overhead.active_minutes)} minutes of worker time. Tokens: ${esc(r.overhead.tokens)}. Hook overhead per tool call: ${esc(r.overhead.hook_overhead)}.</p>

<h2>Integrity and how to verify</h2>
<p>${r.integrity.verified ? "✔ The ledger verified when this receipt was written" : "✖ The ledger did NOT verify when this receipt was written"}: ${esc(r.integrity.entries)} entries, ${esc(r.integrity.anchors)} anchors. ${esc(r.integrity.detail)}</p>
<p>Chain head at entry ${esc(r.integrity.head_seq)}: <code>${esc(r.integrity.head ?? "none")}</code>.</p>
${r.integrity.anchor_records.length === 0 ? "<p>No anchor was recorded.</p>" : rows(["Anchored entry", "Head", "Time (UTC)"], r.integrity.anchor_records.map((a) => [a.seq, { html: `<code>${esc(a.head)}</code>` }, a.ts]))}
<p>Only receipt.json is signed. This page is a rendering of it, so a reader should verify the JSON.</p>
<p>Signature: ${sig ? `Ed25519, key id <code>${esc(sig.key_id)}</code>.` : "none."} Check it yourself with <code>${esc(r.integrity.command)}</code>, run beside this file. The key id is the id of the key that signed this receipt. Take it from the issuer by another route than this folder, because a folder that was forged would carry a forged id. The command checks the signature, the chain and the anchors, and says what it could not check.</p>

<h2>Limits</h2>${list(r.limits)}

<h2>Ledger entries cited above</h2>
${r.evidence.length === 0 ? "<p>No entry is cited.</p>" : `<div class="scroll"><table><thead><tr><th scope="col">Entry</th><th scope="col">Type</th><th scope="col">Actor</th><th scope="col">Time (UTC)</th><th scope="col">Body, shortened</th></tr></thead><tbody>${r.evidence.map((e) => `<tr id="e${e.seq}"><td>${e.seq}</td><td>${esc(e.type)}</td><td>${esc(e.actor)}</td><td>${esc(e.ts)}</td><td><code>${esc(e.summary)}</code></td></tr>`).join("")}</tbody></table></div>`}
</main></body></html>
`;
}

/** The verify command for a receipt, with the key id of the issuer. */
export const verifyCommand = (receipt: Receipt, file = "receipt.json"): string => `candor verify ${file} --key-id ${receipt.integrity.key_id}`;

export function receiptReadme(r: Receipt): string {
  return `# Receipt for run ${r.run}

Record label: ${r.label}. Written ${r.generated_at} (UTC).

Files in this folder:

- receipt.html: the receipt to read. Open it in a browser. It needs no network.
- receipt.json: the same receipt as data, signed with Ed25519.
- ledger.jsonl, anchors.jsonl, blobs: copies of the record the receipt names. They let verify check the chain without the machine that made it.

To check the receipt, run this in this folder:

    ${verifyCommand(r)}

The key id above is the id of the key that signed this receipt. Get it from the issuer by another route than this folder. If the folder was forged, the id in it would be forged too. The id printed here comes from the same folder as the receipt, so check it against what the issuer told you. Without --key-id, verify cannot say who signed and exits with code 3.

Exit code 0 means every check passed. Exit code 1 means a check failed. Exit code 3 means a check was skipped. The command prints what it checked and what a pass does and does not show.

A pass is evidence that the receipt has not changed since it was signed and that the record has not changed since it was anchored. It does not show that the run was right. The anchors in this folder are copies and not an anchor kept somewhere else.
`;
}

export interface WrittenReceipt {
  json: string;
  html: string;
  receipt: Receipt;
}

/**
 * Writes receipt.json and receipt.html, and copies the ledger, the anchor file and the blob folder beside them,
 * so `candor verify receipt.json` can check the chain on a machine that has only this folder. The copies show
 * that the chain is consistent. They are not an anchor kept somewhere else, and verify says which it used.
 */
export function writeReceipt(home: string, run: string, outDir: string, options: { label?: Receipt["label"]; now?: () => Date } = {}): WrittenReceipt {
  const receipt = buildReceipt(home, run, options);
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, "receipt.json");
  const html = join(outDir, "receipt.html");
  writeFileSync(json, `${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(html, renderReceiptHtml(receipt));
  writeFileSync(join(outDir, "README.md"), receiptReadme(receipt));
  copyFileSync(ledgerPath(home, run), join(outDir, "ledger.jsonl"));
  if (existsSync(anchorPath(home, run))) copyFileSync(anchorPath(home, run), join(outDir, "anchors.jsonl"));
  if (existsSync(blobDirPath(home, run))) cpSync(blobDirPath(home, run), join(outDir, "blobs"), { recursive: true });
  return { json, html, receipt };
}
