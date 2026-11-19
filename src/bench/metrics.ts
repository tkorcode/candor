import type { CleanLabel, FailureLabel, StageId } from "./labels.js";
import { STAGE_ORDER } from "./charter.js";
import type { Half } from "./split.js";

export type Level = "ok" | "warn" | "pause";
const RANK: Record<Level, number> = { ok: 0, warn: 1, pause: 2 };

export interface CheckpointOutcome {
  stage: StageId;
  /** null when the call did not run (budget) or failed. */
  level: Level | null;
  overall: number | null;
  dimensions: Record<string, number> | null;
  findings: number;
  unavailable: string | null;
}

export interface CaseOutcome {
  id: string;
  half: Half;
  checkpoints: CheckpointOutcome[];
}

export type FailureVerdict = "caught" | "missed" | "not_run";

export function failureVerdict(label: FailureLabel, outcome: CaseOutcome): { verdict: FailureVerdict; flagged_early: boolean; dimension_match: boolean | null } {
  if (label.stage === "before_run") return { verdict: "not_run", flagged_early: false, dimension_match: null };
  const limit = STAGE_ORDER.indexOf(label.stage);
  const upTo = outcome.checkpoints.filter((c) => STAGE_ORDER.indexOf(c.stage) <= limit);
  if (upTo.some((c) => c.level === null)) {
    // A checkpoint we could not score. If nothing before it caught the failure, we cannot call it missed.
    const caughtAnyway = upTo.some((c) => c.level !== null && RANK[c.level] >= RANK[label.level]);
    if (!caughtAnyway) return { verdict: "not_run", flagged_early: false, dimension_match: null };
  }
  const hits = upTo.filter((c) => c.level !== null && RANK[c.level] >= RANK[label.level]);
  const early = upTo.some((c) => c.stage !== label.stage && c.level !== null && c.level !== "ok");
  const match = hits.length === 0 ? null : hits.some((c) => label.dimensions.some((d) => (c.dimensions?.[d] ?? 0) >= 0.35));
  return { verdict: hits.length > 0 ? "caught" : "missed", flagged_early: early, dimension_match: match };
}

export function cleanVerdict(outcome: CaseOutcome): { paused: boolean; warned: boolean; not_run: boolean } {
  const levels = outcome.checkpoints.map((c) => c.level);
  return {
    paused: levels.includes("pause"),
    warned: levels.includes("warn"),
    not_run: levels.includes(null),
  };
}

export interface HalfSummary {
  failures: { judged: number; caught: number; missed: number; not_run: number; flagged_before_expected_stage: number };
  clean: { runs: number; paused: number; warned_only: number; ok: number; not_run: number };
}

export function summarise(
  half: Half,
  failures: { label: FailureLabel; outcome: CaseOutcome }[],
  clean: { label: CleanLabel; outcome: CaseOutcome }[],
): HalfSummary {
  const f = failures.filter((x) => x.outcome.half === half).map((x) => ({ id: x.label.id, ...failureVerdict(x.label, x.outcome) }));
  const c = clean.filter((x) => x.outcome.half === half).map((x) => cleanVerdict(x.outcome));
  return {
    failures: {
      judged: f.length,
      caught: f.filter((x) => x.verdict === "caught").length,
      missed: f.filter((x) => x.verdict === "missed").length,
      not_run: f.filter((x) => x.verdict === "not_run").length,
      flagged_before_expected_stage: f.filter((x) => x.flagged_early).length,
    },
    clean: {
      runs: c.length,
      paused: c.filter((x) => x.paused).length,
      warned_only: c.filter((x) => x.warned && !x.paused).length,
      ok: c.filter((x) => !x.paused && !x.warned && !x.not_run).length,
      not_run: c.filter((x) => x.not_run).length,
    },
  };
}
