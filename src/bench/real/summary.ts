import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FAILURE_LABELS } from "../labels.js";
import type { DeterministicResult } from "./run.js";

/** Counts and the by-detector table, as data. Nothing here is typed into a document. */

type WithHalf = DeterministicResult & { half?: string | null };

export interface JudgeVerdict {
  id: string;
  verdict: "caught" | "missed" | "not_run";
  /** The results folder the verdict came from. */
  source?: string;
}

/**
 * Watcher verdicts already recorded under results/evaluation/ for the current rubric: live runs only, the newest folder per
 * failure. The watcher is not called again for this. A failure with no such file reads not_run.
 */
export function judgeVerdictsFromFiles(resultsRoot: string, rubricHash: string): JudgeVerdict[] {
  if (!existsSync(resultsRoot)) return [];
  const found = new Map<string, JudgeVerdict>();
  for (const name of readdirSync(resultsRoot).sort()) {
    const dir = join(resultsRoot, name);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { rubric_hash?: string; judge_mode?: string };
      if (manifest.rubric_hash !== rubricHash || manifest.judge_mode !== "live") continue;
      const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as { cases?: { id: string; kind: string; verdict?: string }[] };
      for (const c of summary.cases ?? []) {
        if (c.kind !== "failure" || (c.verdict !== "caught" && c.verdict !== "missed")) continue;
        found.set(c.id, { id: c.id, verdict: c.verdict, source: name });
      }
    } catch {
      // A folder with no manifest or summary is not a watcher result.
    }
  }
  return [...found.values()];
}

export function deterministicSummary(results: WithHalf[]) {
  const count = (list: WithHalf[]) => {
    const failures = list.filter((r) => r.kind === "failure");
    const clean = list.filter((r) => r.kind === "clean");
    return {
      failures: {
        total: failures.length,
        caught: failures.filter((r) => r.verdict === "caught").length,
        missed: failures.filter((r) => r.verdict === "missed").length,
        /** The result is wrong and no check looks at the wrong part. The receipt must not say verified, and it does not only because one criterion has no check. This is not a catch. */
        not_marked_verified: failures.filter((r) => r.verdict === "not_marked_verified").length,
        not_marked_verified_ids: failures.filter((r) => r.verdict === "not_marked_verified").map((r) => r.id),
        verified_but_wrong: failures.filter((r) => r.verdict === "verified_but_wrong").length,
        not_run: failures.filter((r) => r.verdict === "not_run").length,
        caught_late: failures.filter((r) => r.verdict === "caught" && (r.stages_late ?? 0) > 0).length,
        caught_on_time: failures.filter((r) => r.verdict === "caught" && (r.stages_late ?? 0) === 0).length,
        missed_ids: failures.filter((r) => r.verdict === "missed").map((r) => r.id),
        late: failures.filter((r) => r.verdict === "caught" && (r.stages_late ?? 0) > 0).map((r) => ({ id: r.id, stages_late: r.stages_late, first_flag: r.first_flag?.kind ?? null })),
      },
      clean: {
        runs: clean.length,
        false_alarms: clean.filter((r) => r.verdict === "false_alarm").length,
        false_alarm_ids: clean.filter((r) => r.verdict === "false_alarm").map((r) => r.id),
        not_run: clean.filter((r) => r.verdict === "not_run").length,
      },
    };
  };
  const result = results.filter((r) => r.kind === "failure" || r.kind === "clean");
  return {
    all: count(result),
    calibration: count(result.filter((r) => r.half === "calibration")),
    held_out: count(result.filter((r) => r.half === "held_out")),
    by_first_flag: Object.fromEntries(
      [...new Set(results.flatMap((r) => (r.first_flag ? [r.first_flag.kind] : [])))].sort().map((k) => [k, results.filter((r) => r.first_flag?.kind === k).map((r) => r.id)]),
    ),
    errors: results.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
    ledgers_that_verify: results.filter((r) => r.ledger_verifies).length,
    note: "Each scenario was written from the label text before any result was read and none was changed after. The counting of F19 was changed after the first run (see D-063). Several catches come from a different mechanism than the label names (D-063). Scenarios stand in for a worker, and a real worker will find paths these do not.",
  };
}

/** Why a failure reads as it does, where the count alone would mislead. Written once, in D-064 and D-065. */
const BY_DESIGN: Record<string, string> = {
  F06: "The daemon runs the exit checks itself at every stage report, so a worker that skips its own validation hides nothing when the result is good, and a bad result is caught as in F05. No separate flag for the skipped step exists in the demo, because the charter does not say which commands a worker must run (D-064).",
  F15: "The repair in this scenario changed no row, because the data has no spaces to remove and no untrimmed city, so there was nothing for the key to see. The scenario was not changed after the result (D-065).",
};

/** For each failure: did the deterministic layer catch it, did the watcher, both, or neither. The watcher column reads not_run when it did not run. */
export function byDetector(det: WithHalf[], judge: JudgeVerdict[]) {
  return FAILURE_LABELS.map((label) => {
    const d = det.find((r) => r.id === label.id);
    const j = judge.find((r) => r.id === label.id)?.verdict ?? "not_run";
    const dv = d ? d.verdict : "not_run";
    const category =
      dv === "caught" && j === "caught" ? "both"
      : dv === "caught" && j === "missed" ? "deterministic alone"
      : dv === "caught" ? "deterministic (judge not run)"
      : j === "caught" ? "judge alone"
      : dv === "missed" && j === "missed" ? "neither"
      : dv === "not_marked_verified" ? "no check sees it, result not marked verified"
      : dv === "missed" ? "neither so far (judge not run)"
      : "not run";
    return { id: label.id, name: label.name, expected_detector: label.detector, expected_stage: label.stage, half: d?.half ?? null, deterministic: dv, deterministic_first_flag: d?.first_flag ? `${d.first_flag.kind}:${d.first_flag.what}@${d.first_flag.stage}` : null, stages_late: d?.stages_late ?? null, judge: j, note: BY_DESIGN[label.id] ?? null, judge_source: judge.find((r) => r.id === label.id)?.source ?? null, category };
  });
}
