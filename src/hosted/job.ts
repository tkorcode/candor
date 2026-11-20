import { type FaultName, NAMED_FAULTS } from "./named-faults.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../core/canonical.js";
import { type Charter, charterHash } from "../core/charter/schema.js";
import { matchesPath } from "../core/checks/glob.js";
import type { LedgerEntry } from "../core/ledger/types.js";
import { buildBundle } from "../watcher/bundle.js";
import { judge, type Transport, WatcherUnavailableError } from "../watcher/judge.js";
import type { JudgeInput } from "../watcher/schema.js";
import { buildCharter, type CharterInput, charterMarkdown, reviewHosted } from "./charter.js";
import { CHECKS, type CheckResult } from "./checks.js";
import type { Files } from "./code.js";
import { FAULTS } from "./faults.js";
import { HostedLedger, type HostedLedgerState } from "./ledger.js";
import { ORIGINAL, REFERENCE } from "./sample.generated.js";
import { type Message, script, type ToolCall, type Turn, type Worker, workerSystem } from "./workers.js";

/**
 * A hosted job: a code migration of the sample project, run by a worker under Candor. Its state is one plain
 * value, so a Durable Object stores it between steps. `step()` runs one worker turn. Every tool call goes
 * through Candor first: a ledger entry, the scope rules, a hold for an irreversible action. A stage report
 * ends in a checkpoint: the exit checks, a copy of the files, an anchor, and the watcher. Nothing here runs the
 * code of the project.
 */

export type JobStatus = "running" | "held" | "paused" | "done" | "stopped" | "failed";

export interface CheckpointRecord {
  id: string;
  seq: number;
  branch: string;
  stage: string | null;
  files: Files;
  messages: Message[];
  step: number;
  safety: "safe_to_restart" | "record_only";
  bundle: JudgeInput | null;
}

export interface JobState {
  id: string;
  mode: "scripted" | "live";
  status: JobStatus;
  statusReason: string;
  created: string;
  charters: Charter[];
  original: Files;
  files: Files;
  branch: string;
  messages: Message[];
  step: number;
  turns: number;
  toolCalls: number;
  workerCost: number;
  watcherCost: number;
  stageIndex: number;
  irreversibleDone: boolean;
  checkpoints: CheckpointRecord[];
  pending: { call: ToolCall; seq: number; rest: ToolCall[] } | null;
  inventory: string[];
  seededFault: boolean;
  /** A named fault the reader planted (named-faults.ts). seededFault is true for change-test. */
  fault?: FaultName | null;
  ledger: HostedLedgerState;
  receipt: Record<string, unknown> | null;
  /** The last thing the worker said, for the page. */
  lastSay?: string;
  /** The results of a turn gathered before a hold, sent with the rest after the decision. */
  pendingResults?: unknown[];
  /** For the first checkpoint of each restarted branch, the checkpoint it was restarted from. */
  restartOf?: Record<string, string>;
  /** Notes from Candor to the worker, sent with the next tool results so the conversation stays valid. */
  notes?: string[];
  /**
   * The system prompt of the worker, fixed when the job starts. A model signs its reasoning against the conversation,
   * so a system prompt that changed after a rule or a restart would void every signed block before it. New rules
   * reach the worker as notes instead.
   */
  system?: string;
}

export interface JobDeps {
  worker: Worker;
  watcher: Transport;
  watcherModel: string;
  /** The price of the watcher model. The scripted watcher costs nothing. */
  watcherPrice?: { input: number; output: number };
  now?: () => Date;
  /** Signs the finished receipt. */
  sign?: (bytes: Uint8Array) => Promise<{ public_key: string; key_id: string; value: string }>;
}

const MAX_TOOL_CALLS = 120;
const sha = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const excerpt = (text: string, n = 400) => (text.length > n ? `${text.slice(0, n)}…` : text);

export function createJob(id: string, input: CharterInput, options: { mode: "scripted" | "live"; seededFault?: boolean; fault?: FaultName | null; now?: () => Date }): JobState {
  const fault = options.fault ?? (options.seededFault ? "change-test" : null);
  const charter = buildCharter(input);
  const now = options.now ?? (() => new Date());
  const ledger = HostedLedger.create(id, now);
  const review = reviewHosted(charter);
  ledger.append({ type: "run_start", actor: "candord", body: { hosted: true, mode: options.mode, project: "demo/invoices", note: "A hosted job. The worker is a tool loop driven by Candor, not Claude Code, and nothing runs the code of the project." } });
  ledger.append({ type: "charter_review", actor: "operator", body: { items: review, accepted: review.map((r) => r.id) } });
  ledger.append({ type: "charter_approved", actor: "operator", body: { charter_id: charter.id, version: charter.version, charter_hash: charterHash(charter), review_digest: sha(canonicalJson(review)) } });
  if (fault) ledger.append({ type: "config_change", actor: "worker", body: { source: "seeded_fault", fault, file_path: "worker instructions", blocked: false, note: `The reader planted the fault "${NAMED_FAULTS[fault].title}". The worker's instructions say: ${NAMED_FAULTS[fault].instruction}` } });
  // The check strength test: each check of the charter runs on its planted fault and must fail.
  for (const check of charter.checks) {
    const strong = strength(check.id, check.type === "pattern" ? { paths: check.paths ?? [], text: check.deny ?? "" } : null);
    ledger.append({ type: "check_strength", actor: "candord", body: { check: check.id, status: strong ? "proven" : "unproven", detail: strong ? "Failed on its planted fault, so it can fail." : "Passed on its planted fault, so it cannot be relied on." } });
  }
  const original: Files = { ...ORIGINAL };
  return {
    id,
    mode: options.mode,
    status: "running",
    statusReason: "",
    created: now().toISOString(),
    charters: [charter],
    original,
    files: { ...original, ".candor/charter.md": charterMarkdown(charter) },
    branch: "A",
    messages: [{ role: "user", content: "Start the migration. Begin with the inventory stage." }],
    step: 0,
    turns: 0,
    toolCalls: 0,
    workerCost: 0,
    watcherCost: 0,
    stageIndex: 0,
    irreversibleDone: false,
    checkpoints: [],
    pending: null,
    inventory: [],
    seededFault: fault === "change-test",
    fault,
    system: workerSystem(charter, fault === "change-test", fault),
    ledger: ledger.state,
    receipt: null,
  };
}

/** Whether a check fails on its planted fault. */
function strength(id: string, pattern: { paths: string[]; text: string } | null): boolean {
  if (pattern) return patternCheck(pattern, { ...REFERENCE, [pattern.paths[0]?.replace("**", "planted.js") ?? "src/planted.js"]: pattern.text }).status === "failed";
  const check = CHECKS.find((c) => c.id === id);
  const fault = FAULTS[id];
  if (!check || !fault) return false;
  const planted = fault.plant({ ...REFERENCE }, { ...ORIGINAL });
  return check.run({ original: ORIGINAL, files: planted.files, inventory: planted.inventory ?? Object.keys(ORIGINAL).filter((p) => p.startsWith("src/")) }).status === "failed";
}

function patternCheck(p: { paths: string[]; text: string }, files: Files): CheckResult {
  const hits = Object.entries(files).filter(([path, body]) => !path.startsWith(".candor/") && matchesPath(p.paths, path) && body.includes(p.text)).map(([path]) => path);
  return hits.length ? { status: "failed", output: `FAIL: "${p.text}" is in ${hits.join(", ")}` } : { status: "passed", output: `PASS: no file under ${p.paths.join(", ")} contains "${p.text}"` };
}

const charterOf = (job: JobState) => job.charters.at(-1) as Charter;
const ledgerOf = (job: JobState, now?: () => Date) => new HostedLedger(job.ledger, now);
const projectFiles = (files: Files) => Object.fromEntries(Object.entries(files).filter(([p]) => !p.startsWith(".candor/")));

function summaryOf(call: ToolCall): string {
  const path = typeof call.input.path === "string" ? ` ${call.input.path}` : "";
  return `${call.name}${path}`;
}

/** What Candor decides about one tool call, before it runs. */
/** Why an action waits: a deletion cannot be undone inside the job; anything else waits because the charter says so. */
function holdReason(call: ToolCall, text: string, who: string): string {
  return call.name === "delete_file" ? `${text} cannot be undone inside the job, so it waits for ${who}.` : `The charter says ${text} waits for ${who}.`;
}

function decide(job: JobState, call: ToolCall): { decision: "allow" | "deny" | "hold"; rule?: string; reason?: string } {
  const charter = charterOf(job);
  if (job.toolCalls >= MAX_TOOL_CALLS) return { decision: "deny", rule: "budget", reason: `The job has used its ${MAX_TOOL_CALLS} tool calls.` };
  const path = typeof call.input.path === "string" ? call.input.path.replace(/^\.?\//, "") : "";
  if (call.name === "write_file" || call.name === "delete_file") {
    if (!path || path.includes("..")) return { decision: "deny", rule: "scope", reason: "The path is not a file of the project." };
    if (path.startsWith(".candor/")) return { decision: "deny", rule: "scope", reason: "The charter can only change through the operator." };
    if (matchesPath(charter.scope.deny_paths, path)) return { decision: "deny", rule: "scope", reason: `${path} is in a path that may never change (${charter.scope.deny_paths.join(", ")}).` };
    if (!matchesPath(charter.scope.allow_paths, path)) return { decision: "deny", rule: "scope", reason: `${path} is outside the paths that may change (${charter.scope.allow_paths.join(", ")}).` };
    const text = `${call.name} ${path}`;
    const irreversible = charter.irreversible.some((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(text));
    if (irreversible) return { decision: "hold", rule: "irreversible", reason: holdReason(call, text, "a person") };
  }
  return { decision: "allow" };
}

/** Runs one allowed tool call on the files. Returns the text the worker gets back. */
function execute(job: JobState, call: ToolCall): { output: string; failed: boolean } {
  const path = typeof call.input.path === "string" ? call.input.path.replace(/^\.?\//, "") : "";
  switch (call.name) {
    case "list_files":
      return { output: Object.keys(job.files).sort().join("\n"), failed: false };
    case "read_file":
      return path in job.files ? { output: job.files[path] ?? "", failed: false } : { output: `No file ${path}.`, failed: true };
    case "write_file":
      job.files[path] = String(call.input.content ?? "");
      return { output: `Wrote ${path}.`, failed: false };
    case "delete_file":
      if (!(path in job.files)) return { output: `No file ${path}.`, failed: true };
      delete job.files[path];
      return { output: `Deleted ${path}.`, failed: false };
    default:
      return { output: `Unknown tool ${call.name}.`, failed: true };
  }
}

function changedSince(before: Files, after: Files): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((p) => !p.startsWith(".candor/") && before[p] !== after[p]).sort();
}

function nextCheckpointId(job: JobState): string {
  return `${job.branch}${job.checkpoints.filter((c) => c.branch === job.branch).length + 1}`;
}

/** Takes a checkpoint: the entry, the copy of the files, the exit checks, an anchor, and the watcher. */
async function checkpoint(job: JobState, deps: JobDeps, stage: string | null, trigger: "stage_done" | "before_irreversible" | "final" | "restart", extra: Record<string, unknown> = {}): Promise<CheckpointRecord> {
  const ledger = ledgerOf(job, deps.now);
  const charter = charterOf(job);
  const id = nextCheckpointId(job);
  const prev = [...job.checkpoints].reverse().find((c) => c.branch === job.branch) ?? (extra.restart_of ? job.checkpoints.find((c) => c.id === extra.restart_of) : null);
  const changed = changedSince(prev?.files ?? job.original, job.files);
  const safety = job.irreversibleDone ? "record_only" : "safe_to_restart";
  const entry = ledger.append({
    type: "checkpoint",
    actor: "candord",
    branch: job.branch,
    body: { id, parent: prev?.id ?? null, stage, trigger, safety, charter_version: charter.version, changed_paths: changed.slice(0, 20), changed_count: changed.length, snapshot: sha(canonicalJson(projectFiles(job.files))), ...extra },
  });
  const record: CheckpointRecord = { id, seq: entry.seq, branch: job.branch, stage, files: { ...job.files }, messages: structuredClone(job.messages), step: job.step, safety, bundle: null };
  job.checkpoints.push(record);
  // Exit checks of the stage, on the copy of the files.
  const stageDef = charter.stages.find((s) => s.id === stage);
  for (const checkId of stageDef?.exit_checks ?? []) {
    const def = charter.checks.find((c) => c.id === checkId);
    const result = def?.type === "pattern" ? patternCheck({ paths: def.paths ?? [], text: def.deny ?? "" }, projectFiles(job.files)) : (CHECKS.find((c) => c.id === checkId)?.run({ original: job.original, files: projectFiles(job.files), inventory: job.inventory }) ?? { status: "failed" as const, output: "FAIL: unknown check" });
    ledger.append({ type: "check_result", actor: "candord", branch: job.branch, body: { check: checkId, checkpoint: id, stage, status: result.status, output: result.output, strength: "proven" } });
  }
  const anchor = ledger.anchor();
  ledger.append({ type: "anchor", actor: "candord", branch: job.branch, body: { anchored_seq: anchor.seq, anchored_hash: anchor.head, kind: "file" } });
  if (trigger === "restart") {
    ledger.append({ type: "drift_score", actor: "watcher", branch: job.branch, body: { checkpoint: id, stage, status: "skipped", level: null, reason: "no_new_work", message: "A restart point. Nothing new was done yet, so there was nothing to score.", findings: [], charter_version: charter.version, usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, model: null } } });
    return record;
  }
  await score(job, deps, record, entry);
  return record;
}

/** The watcher on one checkpoint, with the evidence bundle of the local product. */
async function score(job: JobState, deps: JobDeps, record: CheckpointRecord, entry: LedgerEntry): Promise<void> {
  const ledger = ledgerOf(job, deps.now);
  const charter = charterOf(job);
  const prev = job.checkpoints.filter((c) => c.branch === record.branch && c.seq < record.seq).at(-1);
  const diff = changedSince(prev?.files ?? job.original, record.files)
    .map((p) => `--- ${p}\n${excerpt(record.files[p] ?? "(deleted)", 1200)}`)
    .join("\n");
  const bundle = buildBundle({ entries: ledger.entries(), charter, checkpoint: entry, changes: diff || null });
  record.bundle = bundle.input;
  const base = { checkpoint: record.id, stage: record.stage, charter_version: charter.version };
  if (bundle.workRows === 0) {
    ledger.append({ type: "drift_score", actor: "watcher", branch: job.branch, body: { ...base, status: "skipped", level: null, reason: "no_new_work", message: "No tool call, result or report since the last checkpoint, so there was nothing new to score.", findings: [], usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, model: null } } });
    return;
  }
  try {
    const result = await judge(bundle.input, { model: deps.watcherModel, budgetUsd: 0.25, transport: deps.watcher, thresholds: charter.thresholds, ...(deps.watcherPrice ? { price: deps.watcherPrice } : {}) });
    job.watcherCost += result.usage.cost_usd;
    ledger.append({
      type: "drift_score",
      actor: "watcher",
      branch: job.branch,
      body: { ...base, status: "scored", dimensions: result.score.dimensions, overall: result.score.overall, level: result.score.level, findings: result.score.findings, judge_model: result.score.judge_model, rubric_hash: result.rubric_hash, dropped_findings: result.dropped_findings, bundle_json: JSON.stringify(bundle.input), usage: result.usage },
    });
    if (result.score.level === "warn") {
      const finding = result.score.findings[0];
      job.notes = [...(job.notes ?? []), `Note from Candor: checkpoint ${record.id} scored ${result.score.overall} on drift, a warn. ${finding ? `${finding.summary}` : ""} Keep to the charter.`];
      ledger.append({ type: "check_result", actor: "candord", branch: job.branch, body: { check: "watcher_note", checkpoint: record.id, drift_seq: ledger.head().seq, event: "delivered" } });
    }
    if (result.score.level === "pause") {
      job.status = "paused";
      job.statusReason = `Checkpoint ${record.id} scored ${result.score.overall}, at or above the pause level. Every tool call waits until you continue, add a rule or restart.`;
    }
  } catch (error) {
    const reason = error instanceof WatcherUnavailableError ? error.reason : "api";
    ledger.append({ type: "drift_score", actor: "watcher", branch: job.branch, body: { ...base, status: "unavailable", level: null, reason, message: `The watcher could not score this checkpoint: ${(error as Error).message}`, findings: [], usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, model: deps.watcherModel } } });
  }
}

/** One worker turn, and Candor on each of its tool calls. Returns when the turn is done or the job must wait. */
export async function step(job: JobState, deps: JobDeps): Promise<void> {
  if (job.status !== "running") return;
  const charter = charterOf(job);
  if (job.turns >= charter.budget.max_turns || job.workerCost + job.watcherCost >= charter.budget.max_cost_usd) {
    await finish(job, deps, "stopped", `The job reached its budget (${charter.budget.max_turns} turns or ${charter.budget.max_cost_usd} dollars).`);
    return;
  }
  let turn: Turn & { assistant?: unknown };
  try {
    turn = await deps.worker({ system: job.system ?? workerSystem(charter, job.seededFault, job.fault ?? null), messages: job.messages, charter, step: job.step, seededFault: job.seededFault });
  } catch (error) {
    job.status = "failed";
    job.statusReason = (error as Error).message;
    return;
  }
  job.turns += 1;
  job.step += 1;
  job.workerCost += turn.usage.cost_usd;
  const ledger = ledgerOf(job, deps.now);
  if (turn.usage.model !== "scripted") ledger.append({ type: "check_result", actor: "candord", branch: job.branch, body: { check: "budget", event: "usage", model: turn.usage.model, input_tokens: turn.usage.input_tokens, output_tokens: turn.usage.output_tokens, cost_usd: turn.usage.cost_usd } });
  job.messages.push({ role: "assistant", content: turn.assistant ?? [...(turn.text ? [{ type: "text", text: turn.text }] : []), ...turn.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))] });
  if (turn.text) job.lastSay = turn.text;
  if (turn.calls.length === 0) {
    job.messages.push({ role: "user", content: "Continue with the next stage, or call finish if every stage is reported." });
    return;
  }
  await runCalls(job, deps, turn.calls, []);
}

/** The user turn that answers a worker turn: every tool result, then any notes from Candor. */
function answer(job: JobState, results: unknown[]): void {
  const notes = (job.notes ?? []).map((text) => ({ type: "text", text }));
  job.notes = [];
  job.messages.push({ role: "user", content: [...results, ...notes] });
}

/** Results for calls that did not run, so every tool call of a turn has its answer. */
const skipped = (calls: ToolCall[], why: string) => calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: why, is_error: true }));

/** Runs the tool calls of a turn in order. A hold stops at that call and keeps the rest for after the decision. */
async function runCalls(job: JobState, deps: JobDeps, calls: ToolCall[], results: unknown[]): Promise<void> {
  const ledger = ledgerOf(job, deps.now);
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i] as ToolCall;
    job.toolCalls += 1;
    if (call.name === "report_stage" || call.name === "finish") {
      const text = await report(job, deps, call);
      results.push({ type: "tool_result", tool_use_id: call.id, content: text });
      if (call.name === "finish" || job.status !== "running") {
        answer(job, [...results, ...skipped(calls.slice(i + 1), "Not run: the job stopped or is waiting for a person.")]);
        return;
      }
      continue;
    }
    const verdict = decide(job, call);
    const intent = ledger.append({ type: "tool_intent", actor: "worker", branch: job.branch, body: { tool: call.name, summary: summaryOf(call), decision: verdict.decision, ...(verdict.rule ? { rule: verdict.rule } : {}), ...(verdict.reason ? { reason: verdict.reason } : {}), input_digest: sha(canonicalJson(call.input)), tool_use_id: call.id } });
    if (verdict.decision === "hold") {
      // A checkpoint is taken first, so the files before the irreversible step can be restored.
      await checkpoint(job, deps, null, "before_irreversible", { before_action: summaryOf(call) });
      job.pending = { call, seq: intent.seq, rest: calls.slice(i + 1) };
      job.pendingResults = results;
      if (job.status === "running") {
        job.status = "held";
        job.statusReason = holdReason(call, summaryOf(call), "you");
      }
      return;
    }
    if (verdict.decision === "deny") {
      ledger.append({ type: "tool_result", actor: "worker", branch: job.branch, body: { tool: call.name, failed: true, output_excerpt: `Refused by Candor: ${verdict.reason}` } });
      results.push({ type: "tool_result", tool_use_id: call.id, content: `Refused by Candor: ${verdict.reason}`, is_error: true });
      continue;
    }
    const out = execute(job, call);
    ledger.append({ type: "tool_result", actor: "worker", branch: job.branch, body: { tool: call.name, failed: out.failed, output_excerpt: excerpt(out.output, 300) } });
    results.push({ type: "tool_result", tool_use_id: call.id, content: out.output, ...(out.failed ? { is_error: true } : {}) });
  }
  answer(job, results);
}

/** A stage report or the end of the job. */
async function report(job: JobState, deps: JobDeps, call: ToolCall): Promise<string> {
  const ledger = ledgerOf(job, deps.now);
  const charter = charterOf(job);
  if (call.name === "finish") {
    await finish(job, deps, "done", "The worker finished.");
    return "The job is finished.";
  }
  const stage = String(call.input.stage ?? "");
  const expected = charter.stages[job.stageIndex]?.id;
  const known = charter.stages.some((s) => s.id === stage);
  const deviations = Array.isArray(call.input.deviations) ? call.input.deviations.map(String).slice(0, 10) : [];
  const summary = excerpt(String(call.input.summary ?? ""), 1200);
  if (stage === "inventory" && Array.isArray(call.input.inventory)) job.inventory = call.input.inventory.map(String);
  ledger.append({ type: "stage_report", actor: "worker", branch: job.branch, body: { stage, accepted: known, done: call.input.done !== false, confidence: typeof call.input.confidence === "number" ? Math.min(1, Math.max(0, call.input.confidence)) : 0.9, summary, deviations, form: "tool", ...(known ? {} : { reason: `There is no stage ${stage} in the charter.` }) } });
  if (!known) return `There is no stage ${stage}. The stages are ${charter.stages.map((s) => s.id).join(", ")}.`;
  if (stage !== expected) ledger.append({ type: "check_result", actor: "candord", branch: job.branch, body: { check: "stage_order", stage, expected, status: "noted", output: `Stage ${stage} was reported while ${expected} was next.` } });
  job.stageIndex = Math.max(job.stageIndex, charter.stages.findIndex((s) => s.id === stage) + 1);
  const cp = await checkpoint(job, deps, stage, "stage_done");
  const checks = ledger.entries().filter((e) => e.type === "check_result" && e.body.checkpoint === cp.id && typeof e.body.status === "string");
  const failed = checks.filter((c) => c.body.status === "failed").map((c) => `${c.body.check}: ${c.body.output}`);
  return failed.length ? `Checkpoint ${cp.id} taken. These checks failed: ${failed.join("; ")}` : `Checkpoint ${cp.id} taken. Every exit check passed.`;
}

/** The reader approves or denies the held action. */
export async function decideHeld(job: JobState, deps: JobDeps, approve: boolean): Promise<void> {
  if (job.status !== "held" || !job.pending) return;
  const ledger = ledgerOf(job, deps.now);
  const { call, seq, rest } = job.pending;
  ledger.append({ type: "human_action", actor: "operator", branch: job.branch, body: { action: approve ? "approve" : "deny", accepted: true, held_seq: seq, summary: summaryOf(call) } });
  const results = job.pendingResults ?? [];
  job.pending = null;
  job.pendingResults = undefined;
  job.status = "running";
  job.statusReason = "";
  if (approve) {
    const out = execute(job, call);
    job.irreversibleDone = true;
    ledger.append({ type: "effect", actor: "candord", branch: job.branch, body: { kind: "irreversible", summary: summaryOf(call), performed: !out.failed, approval_seq: ledger.head().seq } });
    ledger.append({ type: "tool_result", actor: "worker", branch: job.branch, body: { tool: call.name, failed: out.failed, output_excerpt: out.output } });
    results.push({ type: "tool_result", tool_use_id: call.id, content: out.output });
  } else {
    ledger.append({ type: "tool_result", actor: "worker", branch: job.branch, body: { tool: call.name, failed: true, output_excerpt: "Denied by the operator." } });
    results.push({ type: "tool_result", tool_use_id: call.id, content: "The operator denied this action. Do not try it again. Report it in the stage report.", is_error: true });
  }
  await runCalls(job, deps, rest, results);
}

/** The reader continues a paused job. */
export function continueJob(job: JobState, deps: JobDeps): void {
  if (job.status !== "paused") return;
  ledgerOf(job, deps.now).append({ type: "human_action", actor: "operator", branch: job.branch, body: { action: "continue", accepted: true } });
  job.status = "running";
  job.statusReason = "";
}

/** The reader stops the job. */
export async function stopJob(job: JobState, deps: JobDeps): Promise<void> {
  if (job.status === "done" || job.status === "stopped") return;
  ledgerOf(job, deps.now).append({ type: "human_action", actor: "operator", branch: job.branch, body: { action: "stop", accepted: true } });
  await finish(job, deps, "stopped", "Stopped by you.");
}

/** A rule added while the job runs: a new charter version, and every scored checkpoint of the branch scored again. */
export async function addRule(job: JobState, deps: JobDeps, rule: { dimension: "goal" | "scope" | "plan" | "evidence"; text: string }): Promise<void> {
  const ledger = ledgerOf(job, deps.now);
  const old = charterOf(job);
  const added = { id: `added-${old.version}`, dimension: rule.dimension, source: "operator" as const, text: rule.text.trim().slice(0, 300) };
  const next: Charter = { ...old, version: old.version + 1, drift_rules: [...old.drift_rules, added] };
  job.charters.push(next);
  job.files[".candor/charter.md"] = charterMarkdown(next);
  job.notes = [...(job.notes ?? []), `The reader added a rule to the charter. Your work is now scored against it: (${added.dimension}) ${added.text}`];
  ledger.append({ type: "rule_change", actor: "operator", branch: job.branch, body: { author: "operator", from_version: old.version, version: next.version, rule: added, reason: "Added from the workspace while the job ran.", charter_hash: charterHash(next), previous_hash: charterHash(old) } });
  for (const record of lineage(job, job.branch)) {
    const first = ledger.entries().find((e) => e.type === "drift_score" && e.body.checkpoint === record.id && e.body.status === "scored");
    if (!record.bundle || !first) {
      ledger.append({ type: "rescore", actor: "watcher", branch: job.branch, body: { checkpoint: record.id, checkpoint_branch: record.branch, charter_version: next.version, status: "skipped", first: null, findings: [], message: "This checkpoint was not scored when it was taken, so there is no stored evidence to score again." } });
      continue;
    }
    const input: JudgeInput = { ...record.bundle, charter: { ...record.bundle.charter, version: next.version, drift_rules: next.drift_rules.map((r) => ({ id: r.id, dimension: r.dimension, text: r.text })) } };
    try {
      const result = await judge(input, { model: deps.watcherModel, budgetUsd: 0.25, transport: deps.watcher, thresholds: next.thresholds, ...(deps.watcherPrice ? { price: deps.watcherPrice } : {}) });
      job.watcherCost += result.usage.cost_usd;
      ledger.append({ type: "rescore", actor: "watcher", branch: job.branch, body: { checkpoint: record.id, checkpoint_branch: record.branch, checkpoint_seq: record.seq, charter_version: next.version, status: "scored", dimensions: result.score.dimensions, overall: result.score.overall, level: result.score.level, findings: result.score.findings, judge_model: result.score.judge_model, first: { charter_version: first.body.charter_version, overall: first.body.overall, dimensions: first.body.dimensions }, first_score_seq: first.seq, evidence_from_seq: first.seq, usage: result.usage } });
    } catch (error) {
      ledger.append({ type: "rescore", actor: "watcher", branch: job.branch, body: { checkpoint: record.id, checkpoint_branch: record.branch, charter_version: next.version, status: "unavailable", findings: [], message: (error as Error).message } });
    }
  }
}

/** The checkpoints a branch stands on: its own, and those of the branches before it up to each fork point. */
function lineage(job: JobState, branch: string): CheckpointRecord[] {
  const out: CheckpointRecord[] = [];
  let current = branch;
  let limit = Number.POSITIVE_INFINITY;
  for (let guard = 0; guard < 26; guard += 1) {
    out.unshift(...job.checkpoints.filter((c) => c.branch === current && c.seq <= limit));
    const first = job.checkpoints.find((c) => c.branch === current);
    const from = first ? job.restartOf?.[first.id] : undefined;
    const fork = from ? job.checkpoints.find((c) => c.id === from) : undefined;
    if (!fork) break;
    limit = fork.seq;
    current = fork.branch;
  }
  return out;
}

/** Restart from a checkpoint as a fork: a new branch from its files and its point in the conversation, with the reason as a rule. */
export async function restartFrom(job: JobState, deps: JobDeps, from: string, reason: string, dimension: "goal" | "scope" | "plan" | "evidence" = "plan"): Promise<void> {
  const record = job.checkpoints.find((c) => c.id === from);
  if (!record) throw new Error(`There is no checkpoint ${from}.`);
  if (record.safety !== "safe_to_restart") throw new Error(`${from} is record only: an action that cannot be undone happened before it.`);
  const ledger = ledgerOf(job, deps.now);
  const old = charterOf(job);
  const nextBranch = String.fromCharCode(Math.max(...job.checkpoints.map((c) => c.branch.charCodeAt(0))) + 1);
  const lesson = { id: `restart-${nextBranch.toLowerCase()}`, dimension, source: "restart" as const, text: `Restart from ${from}: ${reason.trim().slice(0, 280)}` };
  const next: Charter = { ...old, version: old.version + 1, drift_rules: [...old.drift_rules, lesson] };
  job.charters.push(next);
  if (job.pending) job.pending = null;
  const fromBranch = job.branch;
  job.branch = nextBranch;
  ledger.append({ type: "rule_change", actor: "operator", branch: nextBranch, body: { author: "operator", from_version: old.version, version: next.version, rule: lesson, reason, charter_hash: charterHash(next), previous_hash: charterHash(old) } });
  ledger.append({ type: "restart", actor: "operator", branch: nextBranch, body: { from, from_branch: record.branch, from_seq: record.seq, to_branch: nextBranch, reason, charter_version: next.version, conversation: "fork", previous_branch: fromBranch } });
  job.files = { ...record.files, ".candor/charter.md": charterMarkdown(next) };
  const restored = structuredClone(record.messages);
  const last = restored.at(-1);
  const open = last?.role === "assistant" && Array.isArray(last.content) ? (last.content as { type: string; id?: string }[]).filter((b) => b.type === "tool_use") : [];
  const restartText = { type: "text", text: `Candor restarted the job from checkpoint ${from}. The reason, now a rule: ${reason.trim()}` };
  job.messages = [...restored, { role: "user", content: [...open.map((b) => ({ type: "tool_result", tool_use_id: b.id, content: `Checkpoint ${from} taken.` })), restartText] }];
  job.notes = [];
  job.irreversibleDone = record.safety !== "safe_to_restart";
  const steps = script(next, job.seededFault);
  job.step = record.stage ? Math.max(0, steps.findIndex((s) => s.calls.some((c) => c.name === "report_stage" && c.input.stage === record.stage)) + 1) : record.step;
  job.stageIndex = record.stage ? next.stages.findIndex((s) => s.id === record.stage) + 1 : 0;
  job.restartOf = { ...(job.restartOf ?? {}), [`${nextBranch}1`]: from };
  job.status = "running";
  job.statusReason = "";
  job.receipt = null;
  await checkpoint(job, deps, record.stage, "restart", { restart_of: from });
}

/** The final checkpoint, the acceptance results, the receipt, and the end of the run. */
async function finish(job: JobState, deps: JobDeps, status: "done" | "stopped", reason: string): Promise<void> {
  const ledger = ledgerOf(job, deps.now);
  const charter = charterOf(job);
  await checkpoint(job, deps, null, "final");
  const files = projectFiles(job.files);
  for (const criterion of charter.success) {
    const def = charter.checks.find((c) => c.id === criterion.check);
    const result = !def ? null : def.type === "pattern" ? patternCheck({ paths: def.paths ?? [], text: def.deny ?? "" }, files) : (CHECKS.find((c) => c.id === def.id)?.run({ original: job.original, files, inventory: job.inventory }) ?? null);
    ledger.append({ type: "acceptance_result", actor: "candord", branch: job.branch, body: { criterion: criterion.id, check: criterion.check, status: result ? (result.status === "passed" ? "verified" : "failed") : "not_verified", output: result?.output ?? "", reason: result ? "" : "No check is named for this criterion." } });
  }
  ledger.append({ type: "run_end", actor: "candord", branch: job.branch, body: { reason, turns: job.turns, tool_calls: job.toolCalls, worker_usd: job.workerCost, watcher_usd: job.watcherCost } });
  job.status = status;
  job.statusReason = reason;
  job.receipt = await receipt(job, deps);
}

/** The receipt of the job: two verdicts that are never merged, each criterion, and the signature. */
async function receipt(job: JobState, deps: JobDeps): Promise<Record<string, unknown>> {
  const ledger = ledgerOf(job, deps.now);
  const entries = ledger.entries();
  const charter = charterOf(job);
  const latest = new Map<string, LedgerEntry>();
  for (const e of entries) if (e.type === "acceptance_result") latest.set(String(e.body.criterion), e);
  const criteria = charter.success.map((s) => {
    const e = latest.get(s.id);
    return { id: s.id, text: s.text, check: s.check, strength: s.check ? "proven" : null, status: e?.body.status === "verified" ? "verified" : e?.body.status === "failed" ? "failed" : "not_verified" };
  });
  const branchEntries = entries.filter((e) => (e.branch ?? "A") === job.branch);
  const failedChecks = branchEntries.filter((e) => e.type === "check_result" && e.body.status === "failed");
  const pauses = branchEntries.filter((e) => e.type === "drift_score" && e.body.level === "pause");
  const warns = branchEntries.filter((e) => e.type === "drift_score" && e.body.level === "warn");
  const onCourse = job.status === "done" && failedChecks.length === 0 && pauses.length === 0 ? "yes" : job.status === "done" ? "partly" : "no";
  const verified = criteria.filter((c) => c.status === "verified").length;
  const anyFailed = criteria.some((c) => c.status === "failed");
  const resultVerified = anyFailed ? "no" : verified === criteria.length ? "yes" : verified > 0 ? "partly" : "no";
  const head = ledger.head();
  const body: Record<string, unknown> = {
    kind: "candor-receipt",
    form: "hosted",
    label: job.mode === "live" ? "live" : "scripted",
    run: job.id,
    generated_at: (deps.now ?? (() => new Date()))().toISOString(),
    job: { charter_id: charter.id, charter_version: charter.version, charter_hash: charterHash(charter), goal: charter.goal },
    verdicts: {
      stayed_on_course: { verdict: onCourse, reasons: [`${failedChecks.length} exit checks failed on the final branch, ${warns.length} checkpoints warned and ${pauses.length} paused.`] },
      result_verified: { verdict: resultVerified, reasons: [`${verified} of ${criteria.length} success criteria passed their checks. A criterion with no check is not claimed.`] },
    },
    criteria,
    branch: job.branch,
    restarts: entries.filter((e) => e.type === "restart").map((e) => ({ from: e.body.from, to_branch: e.body.to_branch, reason: e.body.reason })),
    rule_changes: entries.filter((e) => e.type === "rule_change").map((e) => ({ version: e.body.version, rule: e.body.rule })),
    coverage: [
      "The code of the project was never run, so its tests did not run and its behaviour is not checked.",
      "The worker is a tool loop driven by Candor, not Claude Code. The daemon and the hooks of the local product are not part of the hosted job.",
      "The reasoning of the worker is not seen. Only its tool calls, results and reports are.",
    ],
    limits: ["Candor gives evidence, not proof. The record is tamper-evident, not tamper-proof.", "The signing key of a hosted job is made for that job. The key id names it; it does not say who holds it."],
    cost: { worker_usd: job.workerCost, watcher_usd: job.watcherCost },
    integrity: { head: head.hash, head_seq: head.seq, anchors: job.ledger.anchors.length, command: "candor verify ledger.jsonl --anchors anchors.jsonl --blobs blobs/" },
  };
  if (!deps.sign) return body;
  const signature = await deps.sign(new TextEncoder().encode(canonicalJson(body)));
  return { ...body, signature: { alg: "ed25519", ...signature } };
}
