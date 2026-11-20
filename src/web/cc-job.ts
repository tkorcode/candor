import { canonicalJson } from "../core/canonical.js";
import type { Charter } from "../core/charter/schema.js";
import { GENESIS, type LedgerEntry } from "../core/ledger/types.js";
import { entryHash } from "../core/ledger/verify.js";
import { buildCharter, type CharterInput, charterMarkdown } from "../hosted/charter.js";
import { CLAUDE_CODE_BUDGET_USD, localCharter, localCharterYaml, localTask } from "../hosted/local-charter.js";
import { type FaultName, isFaultName, NAMED_FAULTS } from "../hosted/named-faults.js";
import { ORIGINAL } from "../hosted/sample.generated.js";

/**
 * A workspace job that real Claude Code does, under the real `candor run`, in a container of its own (SPEC 4.5).
 * The job object starts the container, passes on the reader's decisions, and copies each new ledger entry out as
 * it appears. It checks that every entry links to the one before and matches its hash, and keeps its own copy,
 * which is all the page reads. Anchors go to the key-value store as well. At the end it checks the receipt against
 * its copy and signs it with the key of the job object, not the container's.
 */

export interface Box {
  fetch(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: Record<string, unknown> }>;
  destroy(): Promise<void>;
}

export interface CcJob {
  kind: "claude-code";
  id: string;
  token: string;
  input: CharterInput;
  charter: Charter;
  worker: string;
  phase: "starting" | "running" | "ended";
  status: "starting" | "running" | "held" | "paused" | "done" | "stopped" | "failed";
  statusReason: string;
  lines: string[];
  blobs: Record<string, string>;
  anchors: { run: string; seq: number; head: string; ts?: string }[];
  files: Record<string, string>;
  held: { digest: string; summary: string; tool: string } | null;
  receipt: Record<string, unknown> | null;
  log: string;
  created: string;
  polls: number;
  fault: FaultName | null;
  /** When the job ended. Its container is kept a while, so the reader can still restart from a checkpoint. */
  endedAt?: number;
  /** The container was destroyed after the restart window. */
  containerGone?: boolean;
  /** What the worker and the watcher have spent, as candord counts it. */
  spent?: { worker: number; watcher: number };
}

/** How long after the end a restart is still possible. Then the job object destroys the container, so idle ones do not take the places of new jobs. */
export const RESTART_WINDOW_MS = 15 * 60 * 1000;

const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

export function createCcJob(id: string, input: CharterInput, worker: string, now = new Date(), fault: unknown = null): CcJob {
  return { fault: isFaultName(fault) ? fault : null, kind: "claude-code", id, token: newToken(), input, charter: buildCharter({ ...input, max_cost_usd: input.max_cost_usd ?? CLAUDE_CODE_BUDGET_USD }), worker, phase: "starting", status: "starting", statusReason: "The container is starting. This takes up to a minute.", lines: [], blobs: {}, anchors: [], files: {}, held: null, receipt: null, log: "", created: now.toISOString(), polls: 0 };
}

/** Sends the charter and the task to the container and starts `candor run` there. */
export async function startCc(job: CcJob, box: Box): Promise<void> {
  const charter = job.charter;
  const res = await box.fetch("/start", { method: "POST", body: { token: job.token, run: job.id, charter: localCharterYaml(charter, job.input), task: localTask(charter), model: job.worker, ...(job.fault ? { fault: { name: job.fault, instruction: NAMED_FAULTS[job.fault].instruction } } : {}), maxUsd: charter.budget.max_cost_usd } });
  if (res.status !== 200) throw new Error(String(res.body.error ?? `The container answered ${res.status}.`));
  job.phase = "running";
  job.status = "running";
  job.statusReason = "";
}

/** Adds entries copied from the container to the job's own copy. Throws when one does not link up. */
export function takeLines(job: CcJob, lines: string[]): void {
  for (const line of lines) {
    const entry = JSON.parse(line) as LedgerEntry;
    const last = job.lines.at(-1);
    const prev = last ? (JSON.parse(last) as LedgerEntry) : null;
    const wantPrev = prev ? prev.hash : GENESIS;
    const wantSeq = prev ? prev.seq + 1 : 1;
    const { hash, ...unsigned } = entry;
    if (entry.seq !== wantSeq || entry.prev !== wantPrev || entryHash(unsigned) !== hash || entry.run !== job.id) {
      throw new Error(`Entry ${entry.seq} copied from the container does not link to the copy the job object keeps. The copy stops at entry ${prev?.seq ?? 0}.`);
    }
    job.lines.push(line);
  }
}

/** One poll of the container: new entries, anchors, files and what waits for the reader. */
export async function pollCc(job: CcJob, box: Box, kv?: { put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> }): Promise<void> {
  if (job.phase !== "running") return;
  job.polls += 1;
  const res = await box.fetch(`/state?after=${job.lines.length}`);
  if (res.status !== 200) throw new Error(String(res.body.error ?? `The container answered ${res.status}.`));
  const s = res.body as { phase: string; lines: string[]; blobs: Record<string, string>; anchors: CcJob["anchors"]; files: Record<string, string>; daemon: { held?: { digest: string; summary: string; tool: string; approved: boolean }[]; paused?: boolean; pause_reason?: string; budget?: { spent_usd?: number }; watcher?: { spent_usd?: number } } | null; log: string };
  takeLines(job, s.lines ?? []);
  Object.assign(job.blobs, s.blobs ?? {});
  for (const a of s.anchors ?? []) {
    if (job.anchors.some((x) => x.seq === a.seq && x.head === a.head)) continue;
    const line = job.lines[a.seq - 1];
    if (!line || (JSON.parse(line) as LedgerEntry).hash !== a.head) continue;
    job.anchors.push(a);
    await kv?.put(`anchor:${job.id}:${a.seq}`, canonicalJson(a), { expirationTtl: 30 * 86400 });
  }
  job.files = s.files ?? job.files;
  if (s.daemon) job.spent = { worker: Number(s.daemon.budget?.spent_usd ?? 0), watcher: Number(s.daemon.watcher?.spent_usd ?? 0) };
  job.log = String(s.log ?? "").slice(-4000);
  const waiting = (s.daemon?.held ?? []).find((h) => !h.approved) ?? null;
  job.held = waiting ? { digest: waiting.digest, summary: waiting.summary, tool: waiting.tool } : null;
  if (s.phase === "ended") {
    job.phase = "ended";
    return;
  }
  if (job.held) {
    job.status = "held";
    job.statusReason = `${job.held.summary} waits for you.`;
  } else if (s.daemon?.paused) {
    job.status = "paused";
    job.statusReason = s.daemon.pause_reason ?? "The watcher scored a checkpoint at or above the pause level.";
  } else {
    job.status = "running";
    job.statusReason = "";
  }
}

/** Ends the job: takes the receipt, checks it against the job's own copy of the ledger, and signs it. */
export async function finishCc(job: CcJob, box: Box, sign: (bytes: Uint8Array) => Promise<{ public_key: string; key_id: string; value: string }>): Promise<void> {
  const last = await box.fetch(`/state?after=${job.lines.length}`);
  if (last.status === 200) takeLines(job, (last.body.lines as string[]) ?? []);
  // Every blob once more, from the whole ledger, so the record downloads complete even if one was missed.
  const all = await box.fetch("/state?after=0");
  if (all.status === 200) Object.assign(job.blobs, (all.body.blobs as Record<string, string>) ?? {});
  const res = await box.fetch("/receipt");
  if (res.status !== 200) throw new Error(String(res.body.error ?? "The container made no receipt."));
  const { signature: _theirs, ...body } = res.body as Record<string, unknown> & { integrity?: { head?: string; head_seq?: number } };
  const headSeq = Number(body.integrity?.head_seq ?? 0);
  const line = job.lines[headSeq - 1];
  if (!line || (JSON.parse(line) as LedgerEntry).hash !== body.integrity?.head) throw new Error("The receipt from the container names a head that is not in the copy of the ledger the job object keeps, so it was not signed.");
  const signed = { ...body, signed_by: "The job object of the workspace, after checking the chain and anchors against its own copy." };
  const signature = await sign(new TextEncoder().encode(canonicalJson(signed)));
  job.receipt = { ...signed, signature: { alg: "ed25519", ...signature } };
  const end = job.lines.map((l) => JSON.parse(l) as LedgerEntry).findLast((e) => e.type === "run_end");
  job.status = job.status === "stopped" ? "stopped" : "done";
  job.statusReason = String((end?.body as { reason?: string } | undefined)?.reason ?? "The job ended.");
  // The container is not destroyed here: a restart from a checkpoint stays possible until it shuts itself down.
  job.endedAt = Date.now();
}

/** Passes one decision of the reader to Candor in the container. */
export async function actCc(job: CcJob, box: Box, action: Record<string, unknown>, now = Date.now()): Promise<void> {
  if (job.phase === "ended") {
    // After the end only a restart is taken, and only while the container is still there: calling a container that
    // has shut down would start an empty one.
    if (action.kind !== "restart") throw new Error("The job has ended. You can still restart it from a checkpoint.");
    if (job.containerGone || !job.endedAt || now - job.endedAt > RESTART_WINDOW_MS) throw new Error("This job ended more than 15 minutes ago and its container has been shut down. Start a new job to try again.");
  }
  const res = await box.fetch("/act", { method: "POST", body: action });
  if (res.status !== 200) throw new Error(String(res.body.error ?? `The container answered ${res.status}.`));
  if (action.kind === "stop" || action.kind === "deny") {
    job.status = "stopped";
    job.statusReason = action.kind === "deny" ? "You denied the held action, so the job stopped." : "You stopped the job.";
  }
  if (action.kind === "restart") {
    // The job runs again on a new branch, and a new receipt covering every branch is signed when it ends.
    job.phase = "running";
    job.status = "running";
    job.statusReason = `Restarting from ${String(action.from)} on a new branch.`;
    job.receipt = null;
    delete job.endedAt;
  }
}

/** What the page shows, in the shape of a workspace job. */
export function viewCc(job: CcJob) {
  const entries = job.lines.map((l) => JSON.parse(l) as LedgerEntry);
  const versions: Charter[] = [localCharter(job.charter, job.input).charter];
  for (const e of entries.filter((x) => x.type === "rule_change")) {
    const b = e.body as { rule?: { id: string; text: string; dimension: Charter["drift_rules"][number]["dimension"]; source?: string }; version?: number };
    const prev = versions.at(-1) as Charter;
    if (b.rule) versions.push({ ...prev, version: b.version ?? prev.version + 1, drift_rules: [...prev.drift_rules, { id: b.rule.id, dimension: b.rule.dimension, source: "operator", text: b.rule.text }] });
  }
  const checkpoints = entries.filter((e) => e.type === "checkpoint").map((e) => {
    const b = e.body as { id?: string; stage?: string | null; safety?: string };
    return { id: String(b.id ?? ""), branch: e.branch ?? "A", stage: b.stage ?? null, safety: b.safety ?? "safe_to_restart", seq: e.seq };
  });
  const lastBranch = entries.at(-1)?.branch ?? "A";
  return {
    id: job.id,
    mode: "live",
    worker: "claude-code",
    workerModel: job.worker,
    status: job.status,
    statusReason: job.statusReason,
    branch: lastBranch,
    seededFault: job.fault !== null,
    fault: job.fault,
    charters: versions,
    files: { ...job.files, ".candor/charter.md": charterMarkdown(versions.at(-1) as Charter) },
    original: ORIGINAL,
    entries,
    anchors: job.anchors,
    checkpoints,
    pending: job.held ? { tool: job.held.tool, path: null, seq: entries.findLast((e) => e.type === "tool_intent" && (e.body as { decision?: string; summary?: string }).decision === "hold" && (e.body as { summary?: string }).summary === job.held?.summary)?.seq ?? 0, summary: job.held.summary } : null,
    receipt: job.receipt,
    cost: { worker: job.spent?.worker ?? 0, watcher: job.spent?.watcher ?? 0 },
    // While a job runs, a restart is always possible; after the end, until the container is shut down.
    restartableUntil: job.phase !== "ended" ? null : job.endedAt && !job.containerGone ? job.endedAt + RESTART_WINDOW_MS : 0,
    turns: entries.filter((e) => e.type === "tool_intent").length,
    log: job.log,
  };
}

export function downloadCc(job: CcJob) {
  return {
    "ledger.jsonl": `${job.lines.join("\n")}\n`,
    "anchors.jsonl": `${job.anchors.map((a) => JSON.stringify(a)).join("\n")}\n`,
    blobs: job.blobs,
    "receipt.json": job.receipt,
    "charter.md": charterMarkdown(job.charter),
  };
}
