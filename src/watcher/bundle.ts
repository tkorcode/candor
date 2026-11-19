import type { Charter } from "../core/charter/schema.js";
import type { LedgerEntry } from "../core/ledger/types.js";
import type { JudgeInput } from "./schema.js";

/**
 * Builds the evidence bundle of D-042 from the ledger of a live run. The bundle holds:
 *   1. the stage reports and check results of earlier stages, as context, with their own sequence numbers;
 *   2. a row for the entry that began this stage (the previous checkpoint, or the start of the run), which also
 *      lists the stages completed before this one;
 *   3. everything the worker and the daemon recorded since then, one short line each;
 *   4. one row with the text of what changed in the workspace, from the snapshots.
 * Worker reasoning is never in the ledger, so none can reach the watcher. Every sequence number is a real entry.
 */

/** Entries that say nothing about the work. They are left out of the bundle. */
const SKIPPED_TYPES = new Set(["heartbeat", "anchor", "drift_score", "charter_approved", "charter_review", "run_start", "session_start", "check_strength", "receipt_issued", "receipt_amended", "run_end", "acceptance_result"]);
/** Entries that show the worker did something since the last checkpoint. A window with none of these is not scored. */
const WORK_TYPES = new Set(["tool_intent", "tool_result", "stage_report", "effect", "config_change"]);
const MAX_ROWS = 150;
const MAX_CONTEXT = 30;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function isBudgetEvent(entry: LedgerEntry): boolean {
  return entry.type === "check_result" && entry.body.check === "budget";
}

/** One short line of text for an entry. Digests and summaries, not whole payloads. */
export function describe(entry: LedgerEntry): string {
  const b = entry.body;
  switch (entry.type) {
    case "tool_intent": {
      const parts = [str(b.summary) || str(b.tool), `decision ${str(b.decision) || "unknown"}`];
      if (b.rule) parts.push(`rule ${str(b.rule)}`);
      if (b.reason && b.decision !== "allow") parts.push(clip(str(b.reason), 240));
      return parts.join(". ");
    }
    case "tool_result": {
      const head = `${str(b.tool) || "tool"} ${b.failed === true ? "failed" : "finished"}`;
      return b.output_excerpt ? `${head}. Output: ${str(b.output_excerpt)}` : head;
    }
    case "stage_report":
      return JSON.stringify({ stage: b.stage, accepted: b.accepted, done: b.done, confidence: b.confidence, summary: b.summary, deviations: b.deviations, reason: b.reason });
    case "check_result": {
      if (b.check && b.status) return `${str(b.check)} (stage ${str(b.stage)}): ${str(b.status)}. ${str(b.output)}`.trim();
      const { check, reason, ok, files, count, checkpoint } = b as Record<string, unknown>;
      return JSON.stringify({ check, ok, reason: typeof reason === "string" ? clip(reason, 240) : undefined, files, count, checkpoint });
    }
    case "effect":
      return `${str(b.kind)} effect: ${str(b.summary)}. performed ${b.performed === true ? "yes" : "no"}${b.approval_seq ? `, approval entry ${String(b.approval_seq)}` : ""}${b.blocked === true ? ", blocked" : ""}.`;
    case "human_action":
      return `${str(b.action)} by ${entry.actor}, ${b.accepted === true ? "accepted" : "refused"}${b.reason ? `. ${clip(str(b.reason), 160)}` : ""}`;
    case "config_change":
      return `settings change from ${str(b.source)} (${str(b.file_path)}), ${b.blocked === true ? "blocked" : "not blocked"}`;
    case "hook_event":
      return `${str(b.event)} event`;
    default:
      return clip(JSON.stringify(b), 300);
  }
}

export interface BundleParams {
  /** The whole ledger so far, in order. */
  entries: LedgerEntry[];
  charter: Charter;
  /** The checkpoint entry just written. */
  checkpoint: LedgerEntry;
  /** The text of what changed since the previous checkpoint, already redacted. Null if the snapshots could not be compared. */
  changes: string | null;
}

export interface Bundle {
  input: JudgeInput;
  /** Rows of the window that show work. Zero means there is nothing new to score. */
  workRows: number;
  rows: number;
}

export function scopeText(charter: Charter): string {
  const s = charter.scope;
  return [
    `Allowed paths: ${s.allow_paths.join(", ") || "none"}.`,
    `Denied paths: ${s.deny_paths.join(", ") || "none"}.`,
    `Allowed commands: ${s.allow_commands.join(" | ") || "none"}.`,
    s.network ? "The network is allowed." : "No network.",
    `Stages, in order: ${charter.stages.map((st) => st.id).join(", ")}.`,
  ].join(" ");
}

/**
 * The entries a branch can see: its own, and those of the branches it was restarted from, up to the checkpoint
 * where it forked. After a restart, what branch A did later is not evidence about branch B. Entries with no
 * branch belong to branch A.
 */
export function lineageEntries(all: LedgerEntry[], branch: string): LedgerEntry[] {
  const branchOf = (e: LedgerEntry): string => e.branch ?? "A";
  const checkpointById = new Map<string, LedgerEntry>();
  for (const e of all) if (e.type === "checkpoint" && typeof e.body.id === "string") checkpointById.set(e.body.id, e);
  // The checkpoint each branch was restarted from, read from the first checkpoint of the new branch.
  const forkedFrom = new Map<string, LedgerEntry>();
  for (const e of all) {
    if (e.type !== "checkpoint" || typeof e.body.restart_of !== "string" || forkedFrom.has(branchOf(e))) continue;
    const from = checkpointById.get(e.body.restart_of);
    if (from) forkedFrom.set(branchOf(e), from);
  }
  const limit = new Map<string, number>([[branch, Number.POSITIVE_INFINITY]]);
  let current = branch;
  for (;;) {
    const from = forkedFrom.get(current);
    if (!from) break;
    const parent = branchOf(from);
    if (limit.has(parent)) break;
    limit.set(parent, from.seq);
    current = parent;
  }
  return all.filter((e) => {
    const max = limit.get(branchOf(e));
    return max !== undefined && e.seq <= max;
  });
}

export function buildBundle(params: BundleParams): Bundle {
  const { charter, checkpoint } = params;
  const entries = lineageEntries(params.entries, checkpoint.branch ?? "A");
  const cp = checkpoint.body;
  const stageId = typeof cp.stage === "string" ? cp.stage : null;
  const checkpointId = str(cp.id);
  const before = entries.filter((e) => e.seq < checkpoint.seq);
  const startEntry = [...before].reverse().find((e) => e.type === "checkpoint") ?? before.find((e) => e.type === "run_start") ?? null;
  const startSeq = startEntry?.seq ?? 0;

  const completed = [...new Set(entries.filter((e) => e.seq < checkpoint.seq && e.type === "checkpoint" && typeof e.body.stage === "string" && e.body.stage !== stageId).map((e) => str(e.body.stage)))];

  // A stage report or a stage check of another stage is context, wherever it sits in the ledger. The checks of
  // the stage before are written after its checkpoint, so the position alone would put them in this window.
  const isContext = (e: LedgerEntry): boolean =>
    (e.type === "stage_report" && e.body.accepted === true && e.body.stage !== stageId) || (e.type === "check_result" && typeof e.body.stage === "string" && e.body.stage !== stageId);
  // The window ends at this checkpoint. The only later entries that belong to it are its own exit checks, which the
  // daemon writes after the checkpoint entry. Anything else written later belongs to the next stage, even when the
  // assessment of this checkpoint runs after it.
  const ownCheck = (e: LedgerEntry): boolean => e.type === "check_result" && e.body.checkpoint === checkpointId && e.seq > checkpoint.seq;
  const upToNow = entries.filter((e) => e.seq !== checkpoint.seq && !isBudgetEvent(e) && (e.seq < checkpoint.seq || ownCheck(e)));
  const context = upToNow.filter((e) => isContext(e) && e.seq < checkpoint.seq).slice(-MAX_CONTEXT);
  const window = upToNow.filter((e) => e.seq > startSeq && (ownCheck(e) || !isContext(e)) && !SKIPPED_TYPES.has(e.type) && e.type !== "checkpoint");
  const workRows = window.filter((e) => WORK_TYPES.has(e.type)).length;

  const toRow = (e: LedgerEntry): JudgeInput["evidence"][number] => ({ seq: e.seq, type: e.type, actor: e.actor, body: describe(e) });
  const kept = window.length > MAX_ROWS ? window.slice(-MAX_ROWS) : window;
  const evidence: JudgeInput["evidence"] = [
    ...context.map(toRow),
    {
      seq: startEntry?.seq ?? checkpoint.seq,
      type: "checkpoint",
      actor: "candord",
      body: `This stage begins after this entry. Stages completed before this one: ${completed.length > 0 ? completed.join(", ") : "none"}.`,
    },
    ...(window.length > kept.length ? [{ seq: kept[0]?.seq ?? checkpoint.seq, type: "note", actor: "candord", body: `${window.length - kept.length} earlier entries of this stage are not shown, to keep the bundle small.` }] : []),
    ...kept.map(toRow),
    {
      seq: checkpoint.seq,
      type: "changes",
      actor: "candord",
      body: `Checkpoint ${checkpointId} (${str(cp.trigger)}). ${Number(cp.changed_count ?? 0)} files changed since the last checkpoint: ${(Array.isArray(cp.changed_paths) ? cp.changed_paths : []).join(", ") || "none"}.${params.changes ? `\n${params.changes}` : ""}`,
    },
  ];

  const stageDef = charter.stages.find((s) => s.id === stageId);
  return {
    input: {
      charter: {
        goal: charter.goal,
        scope: scopeText(charter),
        drift_rules: charter.drift_rules.map((r) => ({ id: r.id, dimension: r.dimension, text: r.text })),
        thresholds: charter.thresholds,
        version: charter.version,
      },
      stage: stageDef
        ? { id: stageDef.id, title: stageDef.title, exit_checks: stageDef.exit_checks }
        : { id: `since-last-checkpoint`, title: `Work since the last checkpoint (trigger ${str(cp.trigger)})`, exit_checks: [] },
      checkpoint: checkpointId,
      evidence,
    },
    workRows,
    rows: evidence.length,
  };
}
