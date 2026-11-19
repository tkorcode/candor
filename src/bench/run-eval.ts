import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prices } from "../watcher/prices.js";
import { fetchTransport, judge, WatcherUnavailableError, type Transport } from "../watcher/judge.js";
import { RUBRIC_HASH, RUBRIC_VERSION } from "../watcher/rubric.js";
import { DEFAULT_THRESHOLDS } from "../watcher/schema.js";
import { stubTransport } from "../watcher/stub.js";
import { CHARTER } from "./charter.js";
import { CLEAN } from "./clean.js";
import { FAILURES } from "./failures.js";
import { CLEAN_LABELS, FAILURE_LABELS } from "./labels.js";
import { type CaseOutcome, type CheckpointOutcome, failureVerdict, summarise } from "./metrics.js";
import { byDetector, deterministicSummary, type JudgeVerdict, judgeVerdictsFromFiles } from "./real/summary.js";
import { type DeterministicResult, runAll } from "./real/run.js";
import { type Half, SPLIT_SEED, splitOf } from "./split.js";
import { checkpointsOf } from "./trace.js";

/**
 * `npm run eval -- [--half calibration|held_out|all] [--only <id>] [--offline] [--det-only] [--judge-all] [--only-unjudged] [--freeze] [--label <text>]`
 * Two parts. The deterministic part plays every failure and clean variant against the real daemon and its checks,
 * with no model call, and always runs. The watcher part feeds scripted traces to the real watcher and needs a key
 * (--offline uses a stub that scores zero and counts for nothing). --det-only runs the first part alone.
 * `--judge-all` also runs the watcher on the failures that the deterministic layer is expected to catch, which costs more.
 * The held-out half runs only when the rubric hash and thresholds match the frozen file (--freeze, run after
 * calibration). Nothing is tuned on held-out results.
 */
const FROZEN_FILE = "src/bench/frozen.json";
/** Evaluation results, one folder per run. Recorded runs of the product are in results/runs. */
const EVALUATION_DIR = join("results", "evaluation");
const PER_CALL_BUDGET_USD = 0.12;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? "") : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file. The environment may hold the values.
  }
  const offline = flag("offline");
  const halfArg = arg("half") ?? "calibration";
  if (halfArg !== "calibration" && halfArg !== "held_out" && halfArg !== "all") fail(`--half must be calibration, held_out or all, not "${halfArg}".`);
  const model = process.env.CANDOR_WATCHER_MODEL ?? "claude-opus-5-5";
  const thresholds = CHARTER.thresholds ?? DEFAULT_THRESHOLDS;

  if (flag("freeze")) {
    writeFileSync(FROZEN_FILE, `${JSON.stringify({ rubric_hash: RUBRIC_HASH, rubric_version: RUBRIC_VERSION, thresholds, seed: SPLIT_SEED, frozen_on: new Date().toISOString().slice(0, 10) }, null, 2)}\n`);
    console.log(`Frozen rubric version ${RUBRIC_VERSION} and thresholds in ${FROZEN_FILE}. Now run the held-out half once.`);
    return;
  }
  if (!offline && (halfArg === "held_out" || halfArg === "all")) {
    const frozen = existsSync(FROZEN_FILE) ? (JSON.parse(readFileSync(FROZEN_FILE, "utf8")) as { rubric_hash: string; thresholds: typeof thresholds }) : null;
    if (!frozen) fail("The held-out half needs a frozen rubric. Run the calibration half, then `npm run eval -- --freeze`.");
    else if (frozen.rubric_hash !== RUBRIC_HASH || JSON.stringify(frozen.thresholds) !== JSON.stringify(thresholds)) {
      fail("The rubric or the thresholds changed after they were frozen. Freeze again, and say in docs/DECISIONS.md that the split is no longer clean for the earlier held-out run.");
    }
  }

  const date0 = new Date().toISOString().slice(0, 10);
  const splitAll = splitOf();
  const only0 = arg("only");
  console.log("Deterministic part: every scenario against the real daemon, no model call.");
  const detAll: DeterministicResult[] = [];
  for (const r of await runAll(only0)) detAll.push({ ...r });
  const detResults = detAll.map((r) => ({ ...r, half: splitAll[r.id] ?? null }));
  const detDir = flag("det-only") ? join("results", "evaluation", `${date0}-${arg("label") ?? "scripted-failures"}`) : null;
  if (detDir) {
    mkdirSync(join(detDir, "runs"), { recursive: true });
    const git = (() => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      } catch {
        return "unknown";
      }
    })();
    writeFileSync(join(detDir, "manifest.json"), `${JSON.stringify({ mode: "scripted scenarios against the real daemon and checks", model_calls: 0, date: date0, split_seed: SPLIT_SEED, git_commit: git, charter: "demo/charter.yaml", scenarios_authored_before_results: true, scenarios_changed_after_results: false, counting_rule_changed_after_results: "F19 counting changed after the first run (D-063), and the demo answer key was extended after the result for F19 (D-065)" }, null, 2)}\n`);
    writeFileSync(join(detDir, "deterministic.json"), `${JSON.stringify(detResults, null, 2)}\n`);
    writeFileSync(join(detDir, "summary.json"), `${JSON.stringify({ label: "eval-deterministic", mode: "scripted scenarios against the real daemon and checks", deterministic: deterministicSummary(detResults), by_detector: byDetector(detResults, judgeVerdictsFromFiles(EVALUATION_DIR, RUBRIC_HASH)), judge_note: "Judge verdicts are read from earlier live runs under results/evaluation/ that used the current rubric hash. The judge was not called for this file." }, null, 2)}\n`);
    console.log(JSON.stringify(deterministicSummary(detResults), null, 1));
    console.log(`Files in ${detDir}`);
    return;
  }

  let transport: Transport;
  let budget = 0;
  if (offline) {
    transport = stubTransport(() => ({ dimensions: { goal: 0, scope: 0, plan: 0, evidence: 0 } }), { input_tokens: 0, output_tokens: 0 });
  } else {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) fail("ANTHROPIC_API_KEY is not set. Put it in .env, or run with --offline for the plumbing only.");
    budget = Number(process.env.CANDOR_EVAL_BUDGET_USD);
    if (!(budget > 0)) fail("CANDOR_EVAL_BUDGET_USD is not set to a positive number of dollars. The evaluation stops at that total.");
    transport = fetchTransport(key as string);
  }

  const split = splitOf();
  const only = arg("only");
  const selectedHalf = (id: string) => halfArg === "all" || split[id] === halfArg;
  // --only-unjudged: failures with no watcher verdict on file for the current rubric, and no clean runs. For spending money once on what is missing.
  const alreadyJudged = new Set(judgeVerdictsFromFiles(EVALUATION_DIR, RUBRIC_HASH).map((v) => v.id));
  const failureCases = FAILURES.filter((t) => flag("judge-all") || FAILURE_LABELS.find((l) => l.id === t.id)?.judged).filter((t) => FAILURE_LABELS.find((l) => l.id === t.id)?.stage !== "before_run").filter((t) => selectedHalf(t.id) && (!only || only === t.id)).filter((t) => !flag("only-unjudged") || !alreadyJudged.has(t.id));
  // --only-unjudged: failures with no watcher verdict on file for the current rubric, and no clean runs. For spending money once on what is missing.
  const cleanCases = flag("only-unjudged") ? [] : CLEAN.filter((t) => selectedHalf(t.id) && (!only || only === t.id));

  let spent = 0;
  let reserved = 0;
  const notRun: string[] = [];
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const date = new Date().toISOString().slice(0, 10);
  const label = arg("label") ?? `watcher-${offline ? "offline" : "live"}-${halfArg}`;
  const dir = join(EVALUATION_DIR, `${date}-${label}`);
  mkdirSync(join(dir, "runs"), { recursive: true });

  async function score(traceId: string, input: ReturnType<typeof checkpointsOf>[number]["input"]): Promise<{ outcome: CheckpointOutcome; raw: unknown }> {
    const stage = input.stage.id as CheckpointOutcome["stage"];
    const none = { stage, level: null, overall: null, dimensions: null, findings: 0 } as const;
    if (!offline && spent + reserved + PER_CALL_BUDGET_USD > budget) {
      notRun.push(`${traceId}/${input.checkpoint}`);
      return { outcome: { ...none, unavailable: "total budget reached, not run" }, raw: null };
    }
    reserved += PER_CALL_BUDGET_USD;
    try {
      const result = await judge(input, { model, budgetUsd: PER_CALL_BUDGET_USD, transport, thresholds });
      usage.calls += 1;
      usage.input_tokens += result.usage.input_tokens;
      usage.output_tokens += result.usage.output_tokens;
      usage.cost_usd += result.usage.cost_usd;
      spent += result.usage.cost_usd;
      return {
        outcome: { stage, level: result.score.level, overall: result.score.overall, dimensions: result.score.dimensions, findings: result.score.findings.length, unavailable: null },
        raw: result,
      };
    } catch (error) {
      if (error instanceof WatcherUnavailableError && error.spent) {
        usage.calls += 1;
        usage.input_tokens += error.spent.input_tokens;
        usage.output_tokens += error.spent.output_tokens;
        usage.cost_usd += error.spent.cost_usd;
        spent += error.spent.cost_usd;
      }
      return { outcome: { ...none, unavailable: (error as Error).message }, raw: { error: (error as Error).message } };
    } finally {
      reserved -= PER_CALL_BUDGET_USD;
    }
  }

  async function runCase(trace: (typeof FAILURES)[number]): Promise<CaseOutcome> {
    const cps = checkpointsOf(trace);
    const results = await Promise.all(cps.map((cp) => score(trace.id, cp.input)));
    const runDir = join(dir, "runs", trace.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "trace.json"), `${JSON.stringify({ id: trace.id, kind: trace.kind, mode: trace.mode, derived_from: trace.derived_from, checkpoints: cps.map((c) => c.input) }, null, 2)}\n`);
    writeFileSync(join(runDir, "scores.json"), `${JSON.stringify(results.map((r, i) => ({ checkpoint: cps[i]?.input.checkpoint, ...(r.raw as object) })), null, 2)}\n`);
    return { id: trace.id, half: split[trace.id] as Half, checkpoints: results.map((r) => r.outcome) };
  }

  // A small pool: five traces at a time.
  async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await fn(items[i] as T);
        }
      }),
    );
    return out;
  }

  console.log(`${offline ? "OFFLINE stub, no model calls" : `LIVE judge ${model}, total cap ${budget} USD`}. Scripted traces. Half: ${halfArg}. ${failureCases.length} failures, ${cleanCases.length} clean runs.`);
  const failureOutcomes = await pool(failureCases, 5, runCase);
  const cleanOutcomes = await pool(cleanCases, 5, runCase);

  const failures = failureCases.map((t, i) => {
    const l = FAILURE_LABELS.find((x) => x.id === t.id);
    return { label: l as NonNullable<typeof l>, outcome: failureOutcomes[i] as CaseOutcome };
  });
  const clean = cleanCases.map((t, i) => {
    const l = CLEAN_LABELS.find((x) => x.id === t.id);
    return { label: l as NonNullable<typeof l>, outcome: cleanOutcomes[i] as CaseOutcome };
  });

  const halves: Half[] = ["calibration", "held_out"];
  const summary = {
    label,
    mode: "scripted traces",
    judge: offline ? "offline stub (always scores zero). Plumbing only. These counts say nothing about the watcher." : "live model calls",
    by_half: Object.fromEntries(halves.map((h) => [h, summarise(h, failures, clean)])),
    cases: [
      ...failures.map((f) => ({ id: f.label.id, kind: "failure", half: f.outcome.half, expected: { stage: f.label.stage, level: f.label.level, dimensions: f.label.dimensions }, ...failureVerdict(f.label, f.outcome), checkpoints: f.outcome.checkpoints })),
      ...clean.map((c) => ({ id: c.label.id, kind: "clean", half: c.outcome.half, variant_of: c.label.variant_of, checkpoints: c.outcome.checkpoints })),
    ],
    deterministic: deterministicSummary(detResults),
    by_detector: byDetector(detResults, [...judgeVerdictsFromFiles(EVALUATION_DIR, RUBRIC_HASH).filter((v) => !failures.some((f) => f.label.id === v.id) || offline), ...(offline ? [] : failures.map((f): JudgeVerdict => ({ id: f.label.id, ...(({ verdict }) => ({ verdict: verdict === "caught" || verdict === "missed" ? verdict : ("not_run" as const) }))(failureVerdict(f.label, f.outcome)), source: "this run" })))]),
    detector_table_note: offline
      ? "The judge ran as an offline stub that scores zero, so no judge result is counted. Judge columns read not_run."
      : `The judge ran on ${failureCases.length} failure traces of the ${halfArg} half${flag("judge-all") ? "" : ", the ones where it is the main or a joint detector"}. A failure the judge did not run on reads not_run.`,
    not_run_checkpoints: notRun,
    usage,
  };
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // Not a git checkout.
  }
  const manifest = {
    mode: "scripted traces",
    judge_mode: offline ? "offline" : "live",
    date,
    split_seed: SPLIT_SEED,
    half: halfArg,
    model: offline ? null : model,
    rubric_version: RUBRIC_VERSION,
    rubric_hash: RUBRIC_HASH,
    charter_version: CHARTER.version,
    thresholds,
    prices: prices,
    total_budget_usd: offline ? null : budget,
    per_call_budget_usd: PER_CALL_BUDGET_USD,
    git_commit: commit,
    traces_authored: true,
    derived_from_live_runs: false,
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "deterministic.json"), `${JSON.stringify(detResults, null, 2)}\n`);
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  console.log(JSON.stringify(summary.by_half, null, 1));
  console.log(`Calls ${usage.calls}, cost ${usage.cost_usd.toFixed(4)} USD. Not run: ${notRun.length}. Files in ${dir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
