import { buildReceipt } from "../../core/report/receipt.js";
import { FAILURE_LABELS } from "../labels.js";
import { type Flag, type FlagKind, Rig } from "./rig.js";
import { ALL_SCENARIOS, type Scenario } from "./scenarios.js";

/**
 * Runs the scenarios against the real daemon and turns each ledger into a result. No model is called.
 * A failure is caught when the deterministic layer flagged something after the point where the failure began.
 * A clean run raises a false alarm when it was flagged for anything that the scenario did not expect, or paused.
 */

export const STAGE_ORDER = ["before_run", "profile", "map", "dedup", "migrate", "verify", "final"] as const;
const rank = (stage: string): number => STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);

export interface DeterministicResult {
  id: string;
  kind: "failure" | "clean";
  expected_stage: string | null;
  verdict: "caught" | "missed" | "clean" | "false_alarm" | "verified_but_wrong" | "not_marked_verified" | "not_run";
  /** Failures only: the first flag after the point where the failure began. */
  first_flag: { kind: FlagKind; what: string; stage: string; seq: number } | null;
  stages_late: number | null;
  counted_flags: { kind: FlagKind; what: string; stage: string }[];
  /** Flags written before the failure began. They do not count. */
  flags_before: { kind: FlagKind; what: string; stage: string }[];
  /** Clean runs: flags the scenario did not expect. */
  unexpected_flags: { kind: FlagKind; what: string; stage: string }[];
  acceptance: { criterion: string; status: string }[];
  /** The answer key entry of the daemon (D-052), and what the receipt made of the run. Null when the run did not reach its end. */
  answer_key: string | null;
  receipt_result_verified: string | null;
  receipt_result_verified_by_checks: string | null;
  paused_at_end: boolean;
  entries: number;
  ledger_verifies: boolean;
  ms: number;
  note: string | null;
  error: string | null;
}

/** Flags that say nothing about the run: the demo has a success criterion with no check, and a held irreversible step is expected. */
const BACKGROUND = new Set<FlagKind>(["acceptance_not_verified"]);

function strip(flags: Flag[]): { kind: FlagKind; what: string; stage: string }[] {
  return flags.map(({ kind, what, stage }) => ({ kind, what, stage }));
}

export async function runScenario(scenario: Scenario): Promise<DeterministicResult> {
  const started = Date.now();
  const label = FAILURE_LABELS.find((l) => l.id === scenario.id);
  const base: DeterministicResult = {
    id: scenario.id,
    kind: scenario.kind,
    expected_stage: label?.stage ?? null,
    verdict: "not_run",
    first_flag: null,
    stages_late: null,
    counted_flags: [],
    flags_before: [],
    unexpected_flags: [],
    acceptance: [],
    answer_key: null,
    receipt_result_verified: null,
    receipt_result_verified_by_checks: null,
    paused_at_end: false,
    entries: 0,
    ledger_verifies: false,
    ms: 0,
    note: scenario.note ?? null,
    error: null,
  };
  let rig: Rig | null = null;
  let finished: DeterministicResult = base;
  try {
    rig = await Rig.create(scenario.rig);
    await scenario.run(rig);
    await rig.idle();
    const flags = rig.flags();
    const entries = rig.entries();
    const deviation = rig.marks.get("deviation") ?? Number.POSITIVE_INFINITY;
    // The receipt step also writes two summary entries (checks-verdict, answer-key). Only real criteria count here.
    const acceptance = entries.filter((e) => e.type === "acceptance_result" && e.body.criterion !== "checks-verdict" && e.body.criterion !== "answer-key").map((e) => ({ criterion: String(e.body.criterion), status: String(e.body.status) }));
    const result: DeterministicResult = {
      ...base,
      verdict: "not_run",
      acceptance,
      paused_at_end: rig.state().paused,
      entries: entries.length,
      ledger_verifies: rig.verified(),
      answer_key: String(entries.filter((e) => e.type === "acceptance_result" && e.body.criterion === "answer-key").at(-1)?.body.status ?? "") || null,
    };
    // What the receipt says about the result, from the same ledger. A run that never ended has no acceptance entries and no verdict.
    if (entries.some((e) => e.type === "run_end")) {
      const receipt = buildReceipt(rig.home, rig.run, { label: "scripted" });
      result.receipt_result_verified = receipt.verdicts.result_verified.verdict;
      result.receipt_result_verified_by_checks = receipt.verdicts.result_verified_by_checks.verdict;
    }
    if (scenario.kind === "clean") {
      const unexpected = flags.filter((f) => !BACKGROUND.has(f.kind) && f.kind !== "held" && !(scenario.allowed ?? []).includes(f.kind));
      result.unexpected_flags = strip(unexpected);
      result.flags_before = strip(flags.filter((f) => !BACKGROUND.has(f.kind) && (f.kind === "held" || (scenario.allowed ?? []).includes(f.kind))));
      result.verdict = unexpected.length > 0 || result.paused_at_end ? "false_alarm" : "clean";
    } else {
      const counts = (f: Flag): boolean => !BACKGROUND.has(f.kind) && (f.kind !== "held" || scenario.countHeld === true);
      const counted = flags.filter((f) => f.seq >= deviation && counts(f));
      result.counted_flags = strip(counted);
      result.flags_before = strip(flags.filter((f) => f.seq < deviation && counts(f)));
      const first = counted[0] ?? null;
      result.first_flag = first ? { kind: first.kind, what: first.what, stage: first.stage, seq: first.seq } : null;
      if (scenario.accuracy) {
        // The result is wrong by construction. The receipt must not say yes. Caught means the answer key entry differs,
        // so the receipt counts the result as not verified because of it. If the key matches, the result is wrong and unseen.
        const keyFlag = flags.find((f) => f.kind === "answer_key_differs");
        const receiptSaysYes = result.receipt_result_verified === "yes";
        result.first_flag = keyFlag ? { kind: keyFlag.kind, what: keyFlag.what, stage: "final", seq: keyFlag.seq } : null;
        result.stages_late = rank("final") - rank(base.expected_stage ?? "final");
        result.verdict = receiptSaysYes ? "verified_but_wrong" : keyFlag && result.receipt_result_verified === "no" ? "caught" : "not_marked_verified";
      } else if (first) {
        result.verdict = "caught";
        result.stages_late = Math.max(0, rank(first.stage) - rank(base.expected_stage ?? "before_run"));
      } else {
        result.verdict = "missed";
      }
    }
    finished = result;
  } catch (error) {
    finished = { ...base, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await rig?.close();
  }
  return { ...finished, ms: Date.now() - started };
}

export async function runAll(only?: string): Promise<DeterministicResult[]> {
  const out: DeterministicResult[] = [];
  for (const scenario of ALL_SCENARIOS.filter((s) => !only || s.id === only)) out.push(await runScenario(scenario));
  return out;
}
