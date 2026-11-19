import { lineageEntries } from "../watcher/bundle.js";
import type { LedgerEntry } from "./ledger/types.js";

/**
 * The suggested restart point (D-080). It turns the drift scores of a run into the decision an operator has to
 * make: where to go back to.
 *
 * On the lineage of a branch (its own checkpoints, and those of the branches it was restarted from, up to each
 * fork), each checkpoint has a latest reading: the last re-score, or else its first score. The first checkpoint
 * whose latest reading reaches warn is where drift began. The suggestion is the last checkpoint before it that was
 * scored below warn and is safe to restart from. It is a suggestion: the operator chooses the checkpoint and gives
 * the reason.
 *
 * The console computes the same rule in the browser (site/js/model.js), and a test holds the two to the same answer.
 */

export interface Thresholds {
  warn: number;
  pause: number;
}

export interface CheckpointReading {
  checkpoint: string;
  seq: number;
  safety: string;
  /** The latest overall drift, or null when the checkpoint was never scored. */
  overall: number | null;
  /** first_score, rescore, or not_judged. */
  from: "first_score" | "rescore" | "not_judged";
}

export type RestartSuggestion =
  | { kind: "suggested"; checkpoint: string; flagged: string; flagged_level: "warn" | "pause"; text: string }
  | { kind: "none_safe"; flagged: string; flagged_level: "warn" | "pause"; text: string }
  | { kind: "on_course"; text: string }
  | { kind: "no_basis"; text: string };

const levelOf = (overall: number, t: Thresholds): "ok" | "warn" | "pause" => (overall >= t.pause ? "pause" : overall >= t.warn ? "warn" : "ok");

/** Every checkpoint on the lineage of a branch, in order, with its latest reading. */
export function readingsOf(entries: LedgerEntry[], branch: string): CheckpointReading[] {
  const line = lineageEntries(entries, branch);
  return line
    .filter((e) => e.type === "checkpoint" && typeof e.body.id === "string")
    .map((cp) => {
      const id = cp.body.id as string;
      const scored = (e: LedgerEntry): boolean => e.body.checkpoint === id && e.body.status === "scored" && typeof e.body.overall === "number";
      // Re-scores of a checkpoint are read from the whole ledger: a rule change on a later branch scores earlier checkpoints too.
      const rescore = entries.filter((e) => e.type === "rescore" && scored(e)).at(-1);
      const first = entries.find((e) => e.type === "drift_score" && scored(e));
      const reading = rescore ?? first;
      return {
        checkpoint: id,
        seq: cp.seq,
        safety: typeof cp.body.safety === "string" ? cp.body.safety : "unknown",
        overall: reading ? (reading.body.overall as number) : null,
        from: rescore ? "rescore" : first ? "first_score" : "not_judged",
      } satisfies CheckpointReading;
    });
}

export function suggestRestart(entries: LedgerEntry[], thresholds: Thresholds, branch: string): RestartSuggestion {
  const line = readingsOf(entries, branch);
  if (!line.some((c) => c.overall !== null)) return { kind: "no_basis", text: "No checkpoint on this branch was scored, so there is no drift to suggest a restart from." };
  const first = line.findIndex((c) => c.overall !== null && c.overall >= thresholds.warn);
  if (first < 0) return { kind: "on_course", text: "No checkpoint on this branch reached the warn level. There is nothing to restart from." };
  const flagged = line[first] as CheckpointReading;
  const level = levelOf(flagged.overall as number, thresholds) as "warn" | "pause";
  for (let i = first - 1; i >= 0; i -= 1) {
    const c = line[i] as CheckpointReading;
    if (c.overall !== null && c.overall < thresholds.warn && c.safety === "safe_to_restart") {
      return {
        kind: "suggested",
        checkpoint: c.checkpoint,
        flagged: flagged.checkpoint,
        flagged_level: level,
        text: `Drift first reached ${level} at ${flagged.checkpoint}. The last checkpoint before it that was scored on course and can be restarted from is ${c.checkpoint}.`,
      };
    }
  }
  return { kind: "none_safe", flagged: flagged.checkpoint, flagged_level: level, text: `Drift first reached ${level} at ${flagged.checkpoint}, and no checkpoint before it was scored on course and can be restarted from.` };
}
