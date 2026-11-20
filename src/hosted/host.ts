import { CLAUDE_CODE_BUDGET_USD, localCharter } from "./local-charter.js";
import { isFaultName } from "./named-faults.js";
import type { Transport } from "../watcher/judge.js";
import { fetchTransport } from "../watcher/judge.js";
import { buildCharter, type CharterInput, charterMarkdown, DEFAULTS, reviewHosted } from "./charter.js";
import { draftCharter } from "./draft.js";
import { addRule, continueJob, createJob, decideHeld, type JobDeps, type JobState, restartFrom, step, stopJob } from "./job.js";
import { ORIGINAL } from "./sample.generated.js";
import { jobSigner } from "./sign.js";
import { scriptedWatcher } from "./watchers.js";
import { modelWorker, scriptedWorker } from "./workers.js";

/**
 * The requests of the workspace page, on one job state, for any host: the Durable Object in production and a
 * plain Node server on a laptop. The host stores the state and calls `advance` until the job waits.
 */

export interface HostConfig {
  apiKey?: string;
  workerModel?: string;
  watcherModel?: string;
}

export const live = (config: HostConfig) => Boolean(config.apiKey);

export async function depsFor(job: JobState, config: HostConfig): Promise<JobDeps> {
  const sign = await jobSigner();
  if (job.mode === "live" && config.apiKey) {
    const watcher: Transport = fetchTransport(config.apiKey);
    return { worker: modelWorker(config.apiKey, config.workerModel ?? "claude-haiku-5-5"), watcher, watcherModel: config.watcherModel ?? "claude-sonnet-5-5", sign };
  }
  return { worker: scriptedWorker, watcher: scriptedWatcher, watcherModel: "scripted-watcher", watcherPrice: { input: 0, output: 0 }, sign };
}

/** What the page shows: the job, without the conversation and the copies kept for restarts. */
export function view(job: JobState) {
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    statusReason: job.statusReason,
    branch: job.branch,
    seededFault: job.seededFault,
    fault: job.fault ?? null,
    charters: job.charters,
    files: job.files,
    original: job.original,
    entries: job.ledger.lines.map((l) => JSON.parse(l)),
    anchors: job.ledger.anchors,
    checkpoints: job.checkpoints.map((c) => ({ id: c.id, branch: c.branch, stage: c.stage, safety: c.safety, seq: c.seq })),
    pending: job.pending ? { tool: job.pending.call.name, path: job.pending.call.input.path ?? null, seq: job.pending.seq } : null,
    receipt: job.receipt,
    cost: { worker: job.workerCost, watcher: job.watcherCost },
    turns: job.turns,
  };
}

/** The bundle a reader downloads: the files `candor verify` reads. */
export function download(job: JobState) {
  return {
    "ledger.jsonl": `${job.ledger.lines.join("\n")}\n`,
    "anchors.jsonl": `${job.ledger.anchors.map((a) => JSON.stringify(a)).join("\n")}\n`,
    blobs: job.ledger.blobs,
    "receipt.json": job.receipt,
    "charter.md": job.files[".candor/charter.md"],
  };
}

/** Runs worker turns until the job waits, is done, or the time for one request is used. */
export async function advance(job: JobState, config: HostConfig, maxMs = 20_000, maxTurns = 6): Promise<void> {
  const deps = await depsFor(job, config);
  const until = Date.now() + maxMs;
  for (let i = 0; i < maxTurns && job.status === "running" && Date.now() < until; i += 1) await step(job, deps);
}

export type Action = { kind: "approve" } | { kind: "deny" } | { kind: "continue" } | { kind: "stop" } | { kind: "rule"; dimension: "goal" | "scope" | "plan" | "evidence"; text: string } | { kind: "restart"; from: string; reason: string };

export async function act(job: JobState, config: HostConfig, action: Action): Promise<void> {
  const deps = await depsFor(job, config);
  switch (action.kind) {
    case "approve":
    case "deny":
      return decideHeld(job, deps, action.kind === "approve");
    case "continue":
      return continueJob(job, deps);
    case "stop":
      return stopJob(job, deps);
    case "rule":
      if (typeof action.text !== "string" || action.text.trim().length < 5) throw new Error("A rule needs at least five characters.");
      return addRule(job, deps, { dimension: action.dimension, text: action.text });
    case "restart":
      if (typeof action.reason !== "string" || action.reason.trim().length < 5) throw new Error("Say why you restart, in at least five characters. The reason becomes a rule.");
      return restartFrom(job, deps, action.from, action.reason);
  }
}

/** A new job from a charter the reader approved. Live when the host has an API key and the reader asked for it. */
export function start(id: string, input: CharterInput, config: HostConfig, options: { live?: boolean; seededFault?: boolean; fault?: unknown }): JobState {
  return createJob(id, input, { mode: options.live !== false && live(config) ? "live" : "scripted", seededFault: options.seededFault ?? false, fault: isFaultName(options.fault) ? options.fault : null });
}

/** A charter drafted from the goal the reader typed, and its review. Scripted when there is no API key. */
/**
 * The charter as the chosen worker will run it. For Claude Code that is the local charter: the two checks that run
 * the code are added, a held deletion becomes rm and git rm, and a held write, which has no shell form, is listed as
 * not enforced. With no budget set, a Claude Code job gets a larger one.
 */
export function charterFor(input: CharterInput, worker?: string) {
  if (worker !== "claude-code") {
    const charter = buildCharter(input);
    return { charter, unenforced: [] as string[] };
  }
  const hosted = buildCharter({ ...input, max_cost_usd: input.max_cost_usd ?? CLAUDE_CODE_BUDGET_USD });
  const local = localCharter(hosted, input);
  return { charter: local.charter, unenforced: local.dropped };
}

export async function draft(goal: string, config: HostConfig, options: { worker?: string; plain?: boolean } = {}) {
  // The budget is left unset, so the chosen worker's default applies until the reader sets one.
  const { max_cost_usd: _budget, ...defaults } = DEFAULTS;
  let input: CharterInput = { ...defaults, goal };
  let drafted_by = "defaults";
  if (config.apiKey && !options.plain) {
    try {
      input = await draftCharter(goal, config.apiKey, config.watcherModel ?? "claude-sonnet-5-5");
      drafted_by = "model";
    } catch {
      drafted_by = "defaults-after-error";
    }
  }
  const { charter, unenforced } = charterFor(input, options.worker);
  return { input, charter, unenforced, markdown: charterMarkdown(charter), review: reviewHosted(charter), drafted_by, live: live(config), files: ORIGINAL };
}

/** The review of a charter the reader edited, before it is approved, as the chosen worker will run it. */
export function review(input: CharterInput, worker?: string) {
  const { charter, unenforced } = charterFor(input, worker);
  return { input, charter, unenforced, markdown: charterMarkdown(charter), review: reviewHosted(charter), files: ORIGINAL };
}
