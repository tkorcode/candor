import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Charter } from "../core/charter/schema.js";
import type { Ledger } from "../core/ledger/ledger.js";
import type { Actor, EntryType, LedgerEntry } from "../core/ledger/types.js";
import type { Redactor } from "../core/ledger/redact.js";
import { scopeText } from "../watcher/bundle.js";
import { judge, WatcherUnavailableError } from "../watcher/judge.js";
import { judgeInputSchema, type JudgeInput } from "../watcher/schema.js";
import { RUBRIC_VERSION } from "../watcher/rubric.js";
import type { RunState } from "./runstate.js";
import type { WatcherConfig } from "./watch.js";

/**
 * Re-scoring after a rule change (R6, D-071). Every checkpoint before the change is scored again under the
 * new charter, from the evidence bundle that was stored with its first score. The worker is not run, and the
 * snapshots are not read again: what the watcher sees is exactly what it saw the first time, with the new
 * rules in place of the old. Each result is a `rescore` entry with the actor `watcher`. The first score
 * stays where it is in the ledger, and the entry names it, so old and new are read side by side.
 *
 * A checkpoint that was never scored has no stored evidence. It gets a `rescore` entry that says so, not a
 * silent gap. A re-score that cannot run (no watcher, no budget, an API error) is recorded the same way, and
 * the rest still run. Every call takes a budget and stops at it, like a call made at a checkpoint.
 */

export interface RescoreDeps {
  config: WatcherConfig | null;
  ledger: Ledger;
  append: (type: EntryType, actor: Actor, body: Record<string, unknown>) => LedgerEntry;
  state: RunState;
  /** The charter after the change. */
  charter: Charter;
  redactor: Redactor;
}

export interface RescoreSummary {
  rescored: number;
  not_rescored: number;
  unavailable: number;
}

const MIN_CALL_USD = 0.03;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A string in a ledger body, or the text behind a blob reference. */
function textOf(ledger: Ledger, value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { $blob?: unknown }).$blob === "string") {
    const hex = (value as { $blob: string }).$blob.replace("sha256:", "");
    if (!/^[0-9a-f]{64}$/.test(hex)) return null;
    const file = join(ledger.blobDir, hex);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }
  return null;
}

/** The earlier score of a checkpoint that a re-score starts from: its first scored score, else any record that it was not scored. */
function firstScore(entries: LedgerEntry[], checkpointId: string): LedgerEntry | null {
  const own = entries.filter((e) => e.type === "drift_score" && e.body.checkpoint === checkpointId);
  return own.find((e) => e.body.status === "scored") ?? own.at(0) ?? null;
}

/** The latest score of the checkpoint before this change, from a first score or an earlier re-score. */
function latestScore(entries: LedgerEntry[], checkpointId: string, before: number): LedgerEntry | null {
  const own = entries.filter((e) => e.seq < before && (e.type === "drift_score" || e.type === "rescore") && e.body.checkpoint === checkpointId && e.body.status === "scored");
  return own.at(-1) ?? null;
}

const summaryOf = (e: LedgerEntry | null): Record<string, unknown> | null =>
  e === null ? null : { seq: e.seq, type: e.type, charter_version: e.body.charter_version ?? null, dimensions: e.body.dimensions ?? null, overall: e.body.overall ?? null, level: e.body.level ?? null };

export async function rescoreCheckpoints(deps: RescoreDeps, ruleChangeSeq: number, previousVersion: number): Promise<RescoreSummary> {
  const { config, state, charter, append, ledger } = deps;
  const summary: RescoreSummary = { rescored: 0, not_rescored: 0, unavailable: 0 };
  const all = ledger.entries();
  const checkpoints = all.filter((e) => e.type === "checkpoint" && e.seq < ruleChangeSeq);

  for (const cp of checkpoints) {
    const id = str(cp.body.id) ?? "?";
    const first = firstScore(all, id);
    const base = {
      checkpoint: id,
      checkpoint_seq: cp.seq,
      stage: str(cp.body.stage),
      checkpoint_branch: cp.branch ?? "A",
      charter_version: charter.version,
      previous_charter_version: previousVersion,
      rule_change_seq: ruleChangeSeq,
      first_score_seq: first?.seq ?? null,
      first: summaryOf(first?.body.status === "scored" ? first : null),
      previous: summaryOf(latestScore(all, id, ruleChangeSeq)),
    };
    const record = (status: "not_rescored" | "unavailable", reason: string, message: string, spent?: { input_tokens: number; output_tokens: number; cost_usd: number }): void => {
      append("rescore", "watcher", { ...base, status, reason, message, level: null, findings: [], judge_model: config?.model ?? null, usage: spent ? { ...spent, model: config?.model ?? null } : { input_tokens: 0, output_tokens: 0, cost_usd: 0, model: null } });
      if (status === "unavailable") summary.unavailable++;
      else summary.not_rescored++;
    };

    if (first === null || first.body.status !== "scored") {
      record("not_rescored", first === null ? "never_judged" : `was_${String(first.body.status)}`, "This checkpoint was not scored when it was taken, so no evidence was stored for it. It cannot be scored again without running the worker.");
      continue;
    }
    const stored = textOf(ledger, first.body.bundle_json);
    let input: JudgeInput;
    try {
      if (stored === null) throw new Error("The stored evidence bundle is missing.");
      const parsed = judgeInputSchema.parse(JSON.parse(stored));
      // The same evidence, the new rules. The goal, the scope text and the thresholds come from the charter now in force.
      input = { ...parsed, charter: { goal: charter.goal, scope: scopeText(charter), drift_rules: charter.drift_rules.map((r) => ({ id: r.id, dimension: r.dimension, text: r.text })), thresholds: charter.thresholds, version: charter.version } };
    } catch (error) {
      record("not_rescored", "evidence_unreadable", `The stored evidence for this checkpoint could not be read: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (config === null) {
      record("unavailable", "not_configured", "No watcher is configured for this run, so this checkpoint was not scored again.");
      continue;
    }
    const runLeft = charter.budget.max_cost_usd - state.spend.costUsd;
    const watcherLeft = config.totalBudgetUsd - state.watcherSpendUsd;
    const callBudget = Math.min(config.callBudgetUsd, runLeft, watcherLeft);
    if (!(callBudget >= MIN_CALL_USD)) {
      record("unavailable", "budget", `The watcher budget is used up (${state.watcherSpendUsd.toFixed(4)} of ${config.totalBudgetUsd} dollars for the watcher, ${state.spend.costUsd.toFixed(4)} of ${charter.budget.max_cost_usd} dollars for the run), so this checkpoint was not scored again.`);
      continue;
    }
    try {
      const result = await judge(deps.redactor.value(input), { model: config.model, budgetUsd: callBudget, transport: config.transport, thresholds: charter.thresholds });
      append("rescore", "watcher", {
        ...base,
        status: "scored",
        judge_model: result.score.judge_model,
        dimensions: result.score.dimensions,
        overall: result.score.overall,
        level: result.score.level,
        findings: result.score.findings,
        thresholds: charter.thresholds,
        rubric_version: RUBRIC_VERSION,
        rubric_hash: result.rubric_hash,
        usage: result.usage,
        dropped_findings: result.dropped_findings,
        withheld_entries: result.withheld_entries,
        // The evidence was not changed. This digest of the stored bundle shows it was the one used the first time.
        evidence_from_seq: first.seq,
      });
      summary.rescored++;
    } catch (error) {
      if (error instanceof WatcherUnavailableError) record("unavailable", error.reason, error.message, error.spent);
      else record("unavailable", "api", `The watcher failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}
