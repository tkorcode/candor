import type { LedgerEntry } from "../core/ledger/types.js";

/**
 * Everything the daemon needs to remember is rebuilt from the ledger, so a restart cannot disagree with
 * what was recorded. The same function folds an entry into the state when the entry is written live.
 */

export interface Held {
  digest: string;
  seq: number;
  tool: string;
  summary: string;
  ts: string;
  branch: string;
  /** The checkpoint taken before the action was held. */
  checkpoint: string | null;
}

export interface Approval {
  seq: number;
  digest: string;
  branch: string;
  expiresAt: number;
  consumedSeq: number | null;
}

export interface CheckpointRecord {
  id: string;
  branch: string;
  n: number;
  parent: string | null;
  commit: string;
  seq: number;
  stage: string | null;
  trigger: string;
  safety: "safe_to_restart" | "record_only";
}

/** What the watcher said at one checkpoint, as far as the daemon needs to remember it. */
export interface DriftRecord {
  seq: number;
  checkpoint: string;
  stage: string | null;
  status: "scored" | "unavailable" | "skipped";
  level: "ok" | "warn" | "pause" | null;
  overall: number | null;
  summary: string;
  cost_usd: number;
}

/** A branch made by a restart. Branch A has no entry here. */
export interface BranchRecord {
  id: string;
  /** The checkpoint it was forked from, which belongs to another branch. */
  origin: string;
  originBranch: string;
  /** The ledger sequence number of the restart entry. Effects and work before it do not belong to this branch. */
  seq: number;
  workspace: string;
  reason: string;
}

export interface WorkerNote {
  seq: number;
  checkpoint: string;
  text: string;
  delivered: boolean;
}

export interface RunState {
  paused: boolean;
  pauseReason: string | null;
  workspace: string | null;
  runStarted: boolean;
  baseline: string | null;
  checksDigest: string | null;
  /** Keyed by branch and stage, such as `A/profile`. */
  stageReports: Map<string, string>;
  stageDone: Set<string>;
  held: Map<string, Held>;
  approvals: Approval[];
  checkpoints: CheckpointRecord[];
  irreversibleBranches: Set<string>;
  effectSeqs: number[];
  spend: { costUsd: number; turns: number; activeMs: number; openSegmentStart: number | null };
  sessions: Set<string>;
  deniedOperator: number;
  strength: Map<string, { status: string; reason: string }>;
  lastEvent: string | null;
  lastEventTs: string | null;
  refused: number;
  /** Cost of the watcher calls so far. It is part of `spend.costUsd` too. */
  watcherSpendUsd: number;
  drift: DriftRecord[];
  notes: WorkerNote[];
  /** The branch that new entries go to. A restart moves it (D-072). */
  activeBranch: string;
  /** The workspace the run started in. Worktrees of restarts are named after it. */
  rootWorkspace: string | null;
  branches: Map<string, BranchRecord>;
  /** Re-scores written so far, and what they cost. The cost is part of `spend.costUsd` and of `watcherSpendUsd`. */
  rescores: number;
}

export function emptyState(): RunState {
  return {
    paused: false,
    pauseReason: null,
    workspace: null,
    runStarted: false,
    baseline: null,
    checksDigest: null,
    stageReports: new Map(),
    stageDone: new Set(),
    held: new Map(),
    approvals: [],
    checkpoints: [],
    irreversibleBranches: new Set(),
    effectSeqs: [],
    spend: { costUsd: 0, turns: 0, activeMs: 0, openSegmentStart: null },
    sessions: new Set(),
    deniedOperator: 0,
    strength: new Map(),
    lastEvent: null,
    lastEventTs: null,
    refused: 0,
    watcherSpendUsd: 0,
    drift: [],
    notes: [],
    activeBranch: "A",
    rootWorkspace: null,
    branches: new Map(),
    rescores: 0,
  };
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function applyEntry(state: RunState, entry: LedgerEntry): void {
  const b = entry.body;
  const branch = entry.branch ?? "A";
  switch (entry.type) {
    case "run_start":
      state.runStarted = true;
      state.baseline = str(b.baseline_commit);
      state.checksDigest = str(b.checks_digest);
      state.workspace = str(b.workspace) ?? state.workspace;
      state.rootWorkspace = str(b.workspace) ?? state.rootWorkspace;
      break;
    case "session_start": {
      const session = str(b.session);
      if (session) state.sessions.add(session);
      break;
    }
    case "tool_intent": {
      const digest = str(b.action_digest);
      state.lastEvent = "PreToolUse";
      state.lastEventTs = entry.ts;
      if (b.decision === "hold" && digest && !state.held.has(digest)) {
        state.held.set(digest, { digest, seq: entry.seq, tool: str(b.tool) ?? "unknown", summary: str(b.summary) ?? "", ts: entry.ts, branch, checkpoint: null });
      }
      break;
    }
    case "tool_result":
      state.lastEvent = "PostToolUse";
      state.lastEventTs = entry.ts;
      break;
    case "hook_event":
      state.lastEvent = str(b.event) ?? state.lastEvent;
      state.lastEventTs = entry.ts;
      break;
    case "stage_report":
      if (b.accepted === true) {
        const stage = str(b.stage);
        const digest = str(b.report_digest);
        // A stage report belongs to its branch: the same stage is done again on a new branch (D-072).
        if (stage && digest) state.stageReports.set(`${branch}/${stage}`, digest);
        if (stage && b.done === true) state.stageDone.add(`${branch}/${stage}`);
      }
      break;
    case "human_action": {
      const action = str(b.action);
      if (entry.actor === "operator" && b.accepted === true) {
        if (action === "pause") {
          state.paused = true;
          state.pauseReason = "The operator paused the run.";
        } else if (action === "continue") {
          state.paused = false;
          state.pauseReason = null;
        } else if (action === "approve") {
          const digest = str(b.action_digest);
          const expires = Date.parse(str(b.expires_at) ?? "");
          if (digest && Number.isFinite(expires)) state.approvals.push({ seq: entry.seq, digest, branch, expiresAt: expires, consumedSeq: null });
        }
      }
      if (entry.actor === "worker" && b.accepted === false) state.deniedOperator++;
      break;
    }
    case "effect": {
      state.effectSeqs.push(entry.seq);
      if (b.irreversible === true && b.performed !== true) {
        state.irreversibleBranches.add(branch);
        const digest = str(b.action_digest);
        const approvalSeq = typeof b.approval_seq === "number" ? b.approval_seq : null;
        if (digest) state.held.delete(digest);
        if (approvalSeq !== null) {
          const approval = state.approvals.find((a) => a.seq === approvalSeq);
          if (approval) approval.consumedSeq = entry.seq;
        }
      }
      break;
    }
    case "checkpoint": {
      const id = str(b.id);
      const n = num(b.n);
      if (id) {
        state.checkpoints.push({
          id,
          branch,
          n,
          parent: str(b.parent),
          commit: str(b.commit) ?? "",
          seq: entry.seq,
          stage: str(b.stage),
          trigger: str(b.trigger) ?? "unknown",
          safety: b.safety === "record_only" ? "record_only" : "safe_to_restart",
        });
        const heldDigest = str(b.before_action_digest);
        const held = heldDigest ? state.held.get(heldDigest) : undefined;
        if (held) held.checkpoint = id;
      }
      break;
    }
    case "check_result": {
      if (b.check === "budget") {
        if (b.event === "segment_start") state.spend.openSegmentStart = Date.parse(entry.ts);
        if (b.event === "usage") {
          state.spend.costUsd += num(b.cost_usd);
          state.spend.turns += num(b.turns);
          state.spend.activeMs += num(b.active_ms);
          state.spend.openSegmentStart = null;
        }
      }
      if (b.check === "watcher_note" && b.event === "delivered") {
        const note = state.notes.find((n) => n.checkpoint === str(b.checkpoint));
        if (note) note.delivered = true;
      }
      if (b.forced_pause === true) {
        state.paused = true;
        state.pauseReason = str(b.reason) ?? "Candor paused the run.";
      }
      break;
    }
    case "drift_score": {
      const status = b.status === "scored" || b.status === "skipped" ? b.status : "unavailable";
      const usage = (b.usage && typeof b.usage === "object" ? b.usage : {}) as Record<string, unknown>;
      const cost = num(usage.cost_usd);
      // The watcher is paid from the run budget, like the worker.
      state.spend.costUsd += cost;
      state.watcherSpendUsd += cost;
      const level = b.level === "ok" || b.level === "warn" || b.level === "pause" ? b.level : null;
      const findings = Array.isArray(b.findings) ? (b.findings as { summary?: unknown }[]) : [];
      const top = str(findings[0]?.summary) ?? str(b.message) ?? "";
      const checkpoint = str(b.checkpoint) ?? "?";
      state.drift.push({ seq: entry.seq, checkpoint, stage: str(b.stage), status, level, overall: typeof b.overall === "number" ? b.overall : null, summary: top, cost_usd: cost });
      if (status === "scored" && level === "pause") {
        state.paused = true;
        state.pauseReason = `The watcher paused the run at checkpoint ${checkpoint}${top ? `: ${top}` : "."}`;
      }
      if (status === "scored" && level === "warn") {
        state.notes.push({ seq: entry.seq, checkpoint, text: `The watcher warns at checkpoint ${checkpoint}${top ? `: ${top}` : "."}`, delivered: false });
      }
      break;
    }
    case "rescore": {
      // A re-score is paid from the run budget like any watcher call. It never pauses the run: it is about the past.
      const usage = (b.usage && typeof b.usage === "object" ? b.usage : {}) as Record<string, unknown>;
      const cost = num(usage.cost_usd);
      state.spend.costUsd += cost;
      state.watcherSpendUsd += cost;
      state.rescores++;
      break;
    }
    case "restart": {
      // The new branch starts clean: not paused, nothing held, and no approval of the old branch applies (approvals carry their branch).
      const id = str(b.to_branch);
      if (id) {
        state.branches.set(id, { id, origin: str(b.from) ?? "", originBranch: str(b.from_branch) ?? "A", seq: entry.seq, workspace: str(b.workspace) ?? "", reason: str(b.reason) ?? "" });
        state.activeBranch = id;
        state.workspace = str(b.workspace) ?? state.workspace;
        state.paused = false;
        state.pauseReason = null;
        state.held.clear();
        state.notes = [];
        // The reports in the worktree are the ones of the checkpoint. They are known on the new branch, not reported again.
        const inherited = (b.inherited_reports && typeof b.inherited_reports === "object" ? b.inherited_reports : {}) as Record<string, unknown>;
        for (const [stage, digest] of Object.entries(inherited)) if (typeof digest === "string") state.stageReports.set(`${id}/${stage}`, digest);
      }
      break;
    }
    case "check_strength": {
      const check = str(b.check);
      if (check) state.strength.set(check, { status: str(b.status) ?? "unproven", reason: str(b.reason) ?? "" });
      break;
    }
    default:
      break;
  }
}

export function openApproval(state: RunState, digest: string, branch: string, nowMs: number): Approval | undefined {
  return state.approvals.find((a) => a.digest === digest && a.branch === branch && a.consumedSeq === null && a.expiresAt > nowMs);
}

export function minutesElapsed(state: RunState, nowMs: number): number {
  const open = state.spend.openSegmentStart === null ? 0 : Math.max(0, nowMs - state.spend.openSegmentStart);
  return (state.spend.activeMs + open) / 60000;
}
