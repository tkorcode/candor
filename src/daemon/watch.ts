import type { Charter } from "../core/charter/schema.js";
import type { Ledger } from "../core/ledger/ledger.js";
import type { Redactor } from "../core/ledger/redact.js";
import type { Actor, EntryType, LedgerEntry } from "../core/ledger/types.js";
import { buildBundle } from "../watcher/bundle.js";
import { fetchTransport, judge, type Transport, WatcherUnavailableError } from "../watcher/judge.js";
import { RUBRIC_VERSION } from "../watcher/rubric.js";
import type { RunState } from "./runstate.js";

/**
 * The watcher step of a checkpoint (R5). It builds the evidence bundle of D-042 from the ledger, calls the
 * model with a budget, and writes one `drift_score` entry with the actor `watcher`. The entry is written
 * whatever happens, so a checkpoint that was not scored says so in the ledger.
 *
 * A pause is not decided here. The daemon folds the entry into its state, and a `pause` level denies tool
 * calls until the operator continues. If the watcher cannot run or is out of budget, the entry records why,
 * the run is not paused, and the job goes on (D-060). The deterministic checks do not depend on this step.
 */

export interface WatcherConfig {
  model: string;
  transport: Transport;
  /** The most one call may cost, in US dollars. */
  callBudgetUsd: number;
  /** The most all calls of this run may cost together, in US dollars. */
  totalBudgetUsd: number;
  /** How long a tool call waits for an assessment still in progress, in milliseconds. Kept below the hook timeout. */
  waitMs?: number;
}

export interface WatchDeps {
  config: WatcherConfig | null;
  ledger: Ledger;
  append: (type: EntryType, actor: Actor, body: Record<string, unknown>) => LedgerEntry;
  state: RunState;
  charter: Charter;
  redactor: Redactor;
}

/** Below this the call is not worth starting: the watcher needs room for its input and a minimum answer. */
const MIN_CALL_USD = 0.03;

export async function watchCheckpoint(deps: WatchDeps, checkpoint: LedgerEntry, changes: string | null, trigger: string): Promise<void> {
  const { config, append, state, charter } = deps;
  const checkpointId = String(checkpoint.body.id);
  const stage = typeof checkpoint.body.stage === "string" ? checkpoint.body.stage : null;
  const base = { checkpoint: checkpointId, stage, trigger, charter_version: charter.version };

  const unavailable = (reason: string, message: string, spent?: { input_tokens: number; output_tokens: number; cost_usd: number }): void => {
    append("drift_score", "watcher", {
      ...base,
      status: "unavailable",
      reason,
      message,
      level: null,
      findings: [{ rule: "watcher_unavailable", severity: "medium", summary: message, entries: [checkpoint.seq] }],
      judge_model: config?.model ?? null,
      usage: spent ? { ...spent, model: config?.model ?? null } : { input_tokens: 0, output_tokens: 0, cost_usd: 0, model: config?.model ?? null },
    });
  };

  let bundle: ReturnType<typeof buildBundle>;
  try {
    bundle = buildBundle({ entries: deps.ledger.entries(), charter, checkpoint, changes });
  } catch (error) {
    unavailable("internal", `The evidence bundle could not be built: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (bundle.workRows === 0) {
    append("drift_score", "watcher", { ...base, status: "skipped", level: null, reason: "no_new_work", message: "No tool call, result, report or effect was recorded since the last checkpoint, so there was nothing new to score.", findings: [], usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, model: null } });
    return;
  }
  if (config === null) {
    unavailable("not_configured", "No watcher is configured for this run, so this checkpoint was not scored. Set ANTHROPIC_API_KEY and CANDOR_WATCHER_MODEL for candord.");
    return;
  }

  const runLeft = charter.budget.max_cost_usd - state.spend.costUsd;
  const watcherLeft = config.totalBudgetUsd - state.watcherSpendUsd;
  const callBudget = Math.min(config.callBudgetUsd, runLeft, watcherLeft);
  if (!(callBudget >= MIN_CALL_USD)) {
    unavailable("budget", `The watcher budget is used up (${state.watcherSpendUsd.toFixed(4)} of ${config.totalBudgetUsd} dollars for the watcher, ${state.spend.costUsd.toFixed(4)} of ${charter.budget.max_cost_usd} dollars for the run), so this checkpoint was not scored.`);
    return;
  }

  // The bundle goes out of the machine, so it is redacted first, like everything that reaches the ledger.
  const input = deps.redactor.value(bundle.input);
  try {
    const result = await judge(input, { model: config.model, budgetUsd: callBudget, transport: config.transport, thresholds: charter.thresholds });
    append("drift_score", "watcher", {
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
      rows: bundle.rows,
      // The whole bundle is kept (the ledger moves a long string to the blob store), so a later rule change can score it again without the worker.
      bundle_json: JSON.stringify(input),
    });
  } catch (error) {
    if (error instanceof WatcherUnavailableError) unavailable(error.reason, error.message, error.spent);
    else unavailable("api", `The watcher failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The watcher settings for candord, read from its environment. No key, or CANDOR_WATCHER=off, gives no watcher,
 * and every checkpoint is then recorded as not scored. The limits are small by default and the ledger holds every call.
 */
export function watcherFromEnv(env: NodeJS.ProcessEnv): WatcherConfig | null {
  if (env.CANDOR_WATCHER === "off") return null;
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const number = (name: string, fallback: number): number => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  // The address can be moved to this machine, for a scripted test with a stand-in server. It never goes to another host.
  const base = env.CANDOR_WATCHER_BASE_URL;
  if (base !== undefined && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error("CANDOR_WATCHER_BASE_URL may only be a local address, such as http://127.0.0.1:8080, so the key of the watcher cannot be sent to another host.");
  return {
    model: env.CANDOR_WATCHER_MODEL || "claude-opus-5-5",
    transport: fetchTransport(key, base),
    callBudgetUsd: number("CANDOR_WATCHER_CALL_USD", 0.15),
    totalBudgetUsd: number("CANDOR_WATCHER_BUDGET_USD", 0.6),
  };
}
