import type { JudgeInput } from "../watcher/schema.js";
import { CHARTER, STAGES } from "./charter.js";
import type { StageId } from "./labels.js";

/** [type, actor, body]. The sequence number is assigned when the trace is built. */
export type E = readonly [type: string, actor: "worker" | "tool" | "check" | "hook", body: string];

export interface Trace {
  id: string;
  kind: "failure" | "clean";
  /** Every trace here is authored. None is derived from a live run. */
  mode: "scripted";
  derived_from: null;
  stages: { stage: StageId; entries: E[] }[];
}

export interface Checkpoint {
  input: JudgeInput;
  stage: StageId;
}

/** One watcher input per checkpoint. Evidence is what happened since the previous checkpoint. */
export function checkpointsOf(trace: Trace): Checkpoint[] {
  let seq = 100;
  // Earlier stage reports and check results stay in the bundle as context, with their original sequence numbers.
  // Tool calls and results of earlier stages do not, so the bundle stays compact.
  const earlier: JudgeInput["evidence"] = [];
  return trace.stages.map((s, i) => {
    // The ledger has the earlier checkpoints, so the watcher is told which stages were completed before this one.
    const before = trace.stages.slice(0, i).map((x) => x.stage);
    const history: E = ["checkpoint", "hook", `Stages completed before this one: ${before.length > 0 ? before.join(", ") : "none"}.`];
    const rows = [history, ...s.entries].map(([type, actor, body]) => {
      seq += 1;
      return { seq, type, actor, body };
    });
    const input: JudgeInput = {
      charter: CHARTER,
      stage: STAGES[s.stage],
      checkpoint: `A${i + 1}`,
      evidence: [...earlier, ...rows],
    };
    for (const r of rows) if (r.type === "stage_report" || r.type === "check_result") earlier.push(r);
    return { stage: s.stage, input };
  });
}

export const report = (stage: StageId, summary: string, deviations: string[] = [], extra: Record<string, unknown> = {}): E => [
  "stage_report",
  "worker",
  JSON.stringify({ stage, status: "done", summary, deviations, ...extra }),
];
export const run = (cmd: string): E => ["tool_intent", "worker", `Bash: ${cmd}`];
export const out = (text: string): E => ["tool_result", "tool", text];
export const write = (path: string, what: string): E => ["tool_intent", "worker", `Write ${path}: ${what}`];
export const check = (id: string, result: "pass" | "fail", detail: string): E => ["check_result", "check", `${id}: ${result}. ${detail}`];
