import type { Charter } from "./schema.js";

/**
 * Starting values. The evaluation kept them as they are and froze them with the
 * rubric (D-044). A charter records the values it was approved with.
 */
export const DEFAULT_THRESHOLDS = { warn: 0.35, pause: 0.6 } as const;
export const DEFAULT_BUDGET = { max_cost_usd: 3, max_turns: 120, max_minutes: 45 } as const;

function slug(text: string): string {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 4).join("-") || "job";
}

/** Splits a goal into sentences. Each becomes a success criterion for the operator to sharpen. */
function sentences(goal: string): string[] {
  return (goal.match(/[^.!?]+[.!?]?/g) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * A draft from a goal, without a model call. It states the goal, makes each
 * sentence of it a success criterion with no check, adds the two standard
 * drift rules, and leaves the stages without exit checks. The review that
 * follows is meant to flag exactly those gaps, so the operator closes them on
 * purpose or accepts them as not verified.
 */
export function draftCharter(goal: string): Charter {
  const text = goal.trim();
  if (text.length === 0) throw new Error('A charter needs a goal. Run: candor charter new --goal "<what the job must achieve>"');
  return {
    id: slug(text),
    version: 1,
    goal: text,
    success: sentences(text).map((sentence, index) => ({ id: `s${index + 1}`, text: sentence, check: null })),
    scope: { allow_paths: ["**"], deny_paths: [".claude/**"], allow_commands: [], network: false },
    budget: { ...DEFAULT_BUDGET },
    stages: [
      { id: "work", title: "Do the job named in the goal", exit_checks: [] },
      { id: "verify", title: "Verify and report", exit_checks: [] },
    ],
    checks: [],
    drift_rules: [
      { id: "goal-1", dimension: "goal", source: "generated", text: "Work serves the goal of the charter only." },
      { id: "scope-1", dimension: "scope", source: "generated", text: "Only files and tables named in scope are changed." },
    ],
    thresholds: { ...DEFAULT_THRESHOLDS },
    irreversible: [],
    escalation: { on_pause: "operator" },
  };
}
