import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { digest } from "../core/canonical.js";
import { evaluateAction, type Verdict } from "../core/checks/action.js";
import { compareWithAnswerKey } from "../core/checks/answerkey.js";
import { matchesPath } from "../core/checks/glob.js";
import { CHECKS_DIR, runCheck, scanPattern } from "../core/checks/run.js";
import { strengthTest } from "../core/checks/strength.js";
import { anchorHead } from "../core/anchor/file.js";
import { changedPaths, diffText, exportSnapshot, takeSnapshot, treeOf } from "../core/checkpoint/snapshot.js";
import { loadApprovedCharter } from "../core/charter/run.js";
import { type RuleDimension, withRule, writeCharterVersion } from "../core/charter/rules.js";
import type { Charter } from "../core/charter/schema.js";
import { Ledger } from "../core/ledger/ledger.js";
import { createRedactor } from "../core/ledger/redact.js";
import type { Actor, EntryType, LedgerEntry } from "../core/ledger/types.js";
import { type RestartSuggestion, suggestRestart } from "../core/restart-point.js";
import { anchorPath, ledgerPath, operatorKeyPath, runDir, socketPath, statePath } from "../core/paths.js";
import { callDaemon } from "./client.js";
import { applyEntry, type DriftRecord, emptyState, type Held, minutesElapsed, openApproval, type RunState } from "./runstate.js";
import { rescoreCheckpoints } from "./rescore.js";
import { type WatcherConfig, watchCheckpoint } from "./watch.js";

/**
 * candord. It writes the chained ledger, assigns the actor of every entry from the channel,
 * runs the deterministic checks before every tool call, holds irreversible actions until the operator
 * approves that exact action, tracks spend across branches, takes checkpoints and runs the checks of a
 * stage. At each checkpoint it calls the watcher (D-060) and folds the drift score into its state.
 *
 * Two channels reach it. The hook channel is the only path from the worker, and everything on it is
 * recorded as the worker. The operator channel needs the operator secret. A request there without the
 * secret is refused and recorded as the worker.
 */

export type { Actor };
export type Entry = LedgerEntry;

export interface HookReply {
  decision: "allow" | "deny";
  reason?: string;
  /** A note for the worker, from a watcher warning. The hook passes it on as context after a tool call. */
  note?: string;
}

export interface DaemonState {
  run: string;
  paused: boolean;
  pause_reason: string | null;
  entries: number;
  last_seq: number;
  last_event: string | null;
  last_event_ts: string | null;
  sessions: string[];
  stage_reports: string[];
  held: { digest: string; tool: string; summary: string; checkpoint: string | null; approved: boolean }[];
  /** The workspace the worker runs in now. After a restart it is the worktree of the newest branch. */
  workspace: string | null;
  checkpoints: { id: string; branch: string; stage: string | null; trigger: string; safety: string }[];
  /** The branch that new work goes to, the charter version in force, and the branches made by restarts. */
  branch: string;
  charter_version: number;
  branches: { id: string; from: string; reason: string; workspace: string }[];
  budget: { spent_usd: number; max_usd: number; turns: number; max_turns: number; minutes: number; max_minutes: number };
  strength: Record<string, { status: string; reason: string }>;
  refused_operator_attempts: number;
  watcher: { configured: boolean; model: string | null; spent_usd: number; budget_usd: number | null; calls: number };
  /** The last drift scores, newest last. A scored entry has a level. An unavailable or skipped one has none. */
  drift: DriftRecord[];
  /** Where the drift scores suggest restarting from, on the lineage of the active branch (D-080). */
  suggested_restart: RestartSuggestion;
}

export interface DaemonOptions {
  home: string;
  run: string;
  /** The workspace root, fixed for the run. If it is left out, the one in the run_start entry is used, or the folder of the first SessionStart. A cwd in later hook input never changes it. */
  workspace?: string;
  now?: () => Date;
  /** How long one check may run, in milliseconds. */
  checkTimeoutMs?: number;
  /** The watcher model call. Left out, checkpoints are recorded as not scored. */
  watcher?: WatcherConfig;
}

export interface Daemon {
  socket: string;
  state(): DaemonState;
  /** Resolves when the checkpoints and checks queued by earlier events have finished. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

const FIRST_BRANCH = "A";
const MAX_BODY = 4 * 1024 * 1024;
/** The longest Unix socket path the system accepts, in bytes. Longer paths are cut short or refused. */
export const MAX_SOCKET_PATH = process.platform === "darwin" ? 103 : 107;
const MAX_REPORT = 256 * 1024;
/** The most text of changes that goes to the watcher for one checkpoint. */
const MAX_CHANGES_CHARS = 12000;
/** The most output of a tool call that is kept in its ledger entry, for the watcher. */
const MAX_OUTPUT_EXCERPT = 800;
const DEFAULT_WAIT_MS = 5000;
const STAGE_FILE = /^stage-([A-Za-z0-9_-]+)\.json$/;
/** A refused operator request is recorded this many times. After that only the count grows, so the worker cannot fill the ledger. */
const MAX_RECORDED_REFUSALS = 200;
const DEFAULT_APPROVAL_MINUTES = 15;

const StageReport = z.object({ done: z.boolean(), deviations: z.array(z.string()).optional(), confidence: z.number().min(0).max(1).optional() }).passthrough();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("The request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Resolves a path the worker named, and refuses anything outside the workspace. */
export function insideWorkspace(cwd: string, path: string): string | null {
  try {
    const root = realpathSync(cwd);
    const target = realpathSync(isAbsolute(path) ? path : resolve(root, path));
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return target;
  } catch {
    return null;
  }
}

function digestTree(root: string): string {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) files[relative(root, full)] = digest(readFileSync(full, "utf8"));
    }
  };
  if (existsSync(root)) walk(root);
  return digest(files);
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);

/** A short piece of what a tool returned, for the ledger and the watcher. The ledger redacts it, and the full output is only a digest. */
function excerptOf(response: unknown): string {
  if (response === null || response === undefined) return "";
  if (typeof response === "string") return clip(response, MAX_OUTPUT_EXCERPT);
  if (typeof response === "object") {
    const r = response as Record<string, unknown>;
    const parts = ["stdout", "stderr", "output", "error", "content"].flatMap((key) => (typeof r[key] === "string" && (r[key] as string).length > 0 ? [`${key}: ${r[key] as string}`] : []));
    if (parts.length > 0) return clip(parts.join(" | "), MAX_OUTPUT_EXCERPT);
  }
  return clip(JSON.stringify(response) ?? "", MAX_OUTPUT_EXCERPT);
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const now = options.now ?? (() => new Date());
  const { home, run } = options;
  const checkTimeoutMs = options.checkTimeoutMs ?? 60000;
  const socketBytes = Buffer.byteLength(socketPath(home));
  if (socketBytes > MAX_SOCKET_PATH) {
    throw new Error(
      `The socket path ${socketPath(home)} is ${socketBytes} bytes long and the limit is ${MAX_SOCKET_PATH}. Set CANDOR_HOME to a shorter folder, then start candord again.`,
    );
  }
  const folder = runDir(home, run);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);

  const keyFile = operatorKeyPath(home);
  if (!existsSync(keyFile)) writeFileSync(keyFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  const operatorKey = Buffer.from(readFileSync(keyFile, "utf8").trim(), "utf8");

  // The ledger refuses to open if its chain does not verify, so a tampered run cannot be extended.
  const redactor = createRedactor([operatorKey.toString("utf8")]);
  const ledger = Ledger.open({ path: ledgerPath(home, run), run, now, redactor });
  const prior = ledger.entries();
  // The charter in force is the one the run was approved with. A file that does not match its hash is refused.
  const approved = loadApprovedCharter(folder, prior);
  // A rule change (D-070) or a restart (D-072) replaces these. Both are written to the ledger before they take effect.
  let charter: Charter = approved.charter;
  let charterHashNow = approved.hash;

  const state: RunState = emptyState();
  for (const entry of prior) applyEntry(state, entry);
  // After a restart the workspace of the run is the worktree of the newest branch, whatever the daemon was started with.
  let workspaceRoot: string | null = state.activeBranch !== FIRST_BRANCH && state.workspace && existsSync(state.workspace) ? realpathSync(state.workspace) : options.workspace ? realpathSync(options.workspace) : state.workspace ? realpathSync(state.workspace) : null;
  const latestMessage = new Map<string, string>();
  const pendingIrreversible = new Map<string, { digest: string; summary: string; tool: string }>();
  const scanSeen = new Set<string>();
  const refusedKeys = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  /** Checkpoints queued or running. A tool call waits a little for them, so a pause lands before the next stage starts. */
  let pendingCheckpoints = 0;

  // The suggested restart point changes only when a checkpoint, a score, a rule or a branch changes, so it is
  // worked out again then, and not on every tool call.
  const SUGGESTION_TYPES = new Set<EntryType>(["checkpoint", "drift_score", "rescore", "rule_change", "restart"]);
  let suggestion: RestartSuggestion | null = null;
  const append = (type: EntryType, actor: Actor, body: Record<string, unknown>, branch: string = state.activeBranch): Entry => {
    const entry = ledger.append({ type, actor, body, branch });
    applyEntry(state, entry);
    if (SUGGESTION_TYPES.has(type)) suggestion = null;
    return entry;
  };
  const suggested = (): RestartSuggestion => {
    suggestion ??= suggestRestart(ledger.entries(), charter.thresholds, state.activeBranch);
    return suggestion;
  };
  const enqueue = (work: () => Promise<void> | void): Promise<void> => {
    queue = queue.then(work).catch((error: unknown) => {
      try {
        append("check_result", "candord", { check: "daemon", ok: false, reason: `A queued job failed: ${error instanceof Error ? error.message : String(error)}` });
      } catch {
        // The ledger cannot be written. The daemon stays up and the next request will show the problem.
      }
    });
    return queue;
  };

  /**
   * A checkpoint is recorded at the moment it is triggered: the snapshot, the checkpoint entry and the anchor, so the
   * snapshot holds the workspace as the stage left it and the next action of the worker comes after it in the ledger.
   * Only the slow part, the exit checks and the watcher, waits in the queue.
   */
  const queueCheckpoint = (trigger: string, extra: { stage?: string; session?: string; beforeActionDigest?: string } = {}): void => {
    const recorded = recordCheckpoint(trigger, extra);
    if (recorded === null) return;
    pendingCheckpoints += 1;
    void enqueue(async () => {
      try {
        await finishCheckpoint(recorded, trigger, extra);
      } finally {
        pendingCheckpoints -= 1;
      }
    });
  };

  const pristineChecks = join(folder, "checks-pristine");
  // The answer key lives in the run store, outside the workspace. Only the final acceptance checks and the
  // strength test get it. A check that runs during a stage does not.
  const oracleDir = join(folder, "oracle");
  const oracleEnv = (): Record<string, string> => (existsSync(oracleDir) ? { CANDOR_ORACLE_DIR: oracleDir } : {});
  const heartbeatGap = (): void => {
    const last = prior.at(-1);
    const gap = last ? now().getTime() - Date.parse(last.ts) : 0;
    if (last && gap > 120000) append("heartbeat", "candord", { recovered: true, gap_ms: gap });
  };

  const prepareRun = (): void => {
    if (state.runStarted) return;
    if (workspaceRoot === null) return;
    // The scripts of the checks are copied before the worker runs. Checks run from this copy, not from the workspace.
    const source = join(workspaceRoot, CHECKS_DIR);
    // With no checks folder the copy is empty, so a check script the worker adds later is never used.
    if (!existsSync(pristineChecks)) {
      if (existsSync(source)) cpSync(source, pristineChecks, { recursive: true });
      else mkdirSync(pristineChecks, { recursive: true });
    }
    // The state of the workspace before the worker starts. The first checkpoint is compared with it.
    let baseline: string | null = null;
    try {
      baseline = takeSnapshot({ gitDir: join(folder, "snapshots.git"), workdir: workspaceRoot, ref: `refs/candor/${run}/${FIRST_BRANCH}/0`, message: "baseline before the run", date: now() }).commit;
    } catch (error) {
      append("check_result", "candord", { check: "checkpoint", ok: false, reason: `The baseline snapshot failed: ${error instanceof Error ? error.message : String(error)}` });
    }
    append("run_start", "candord", {
      baseline_commit: baseline,
      workspace: workspaceRoot,
      charter_id: charter.id,
      charter_version: charter.version,
      charter_hash: charterHashNow,
      checks_digest: digestTree(pristineChecks),
      oracle_digest: existsSync(oracleDir) ? digestTree(oracleDir) : null,
      budget: charter.budget,
    });
  };

  const budgetNow = (): DaemonState["budget"] => ({
    spent_usd: Math.round(state.spend.costUsd * 10000) / 10000,
    max_usd: charter.budget.max_cost_usd,
    turns: state.spend.turns,
    max_turns: charter.budget.max_turns,
    minutes: Math.round(minutesElapsed(state, now().getTime()) * 100) / 100,
    max_minutes: charter.budget.max_minutes,
  });

  const snapshot = (): DaemonState => ({
    run,
    paused: state.paused,
    pause_reason: state.pauseReason,
    entries: ledger.head().seq,
    last_seq: ledger.head().seq,
    last_event: state.lastEvent,
    last_event_ts: state.lastEventTs,
    sessions: [...state.sessions],
    stage_reports: [...state.stageReports.keys()].filter((k) => k.startsWith(`${state.activeBranch}/`)).map((k) => k.slice(state.activeBranch.length + 1)),
    held: [...state.held.values()].map((h) => ({ digest: h.digest, tool: h.tool, summary: h.summary, checkpoint: h.checkpoint, approved: openApproval(state, h.digest, h.branch, now().getTime()) !== undefined })),
    workspace: workspaceRoot,
    checkpoints: state.checkpoints.slice(-20).map((c) => ({ id: c.id, branch: c.branch, stage: c.stage, trigger: c.trigger, safety: c.safety })),
    branch: state.activeBranch,
    charter_version: charter.version,
    branches: [...state.branches.values()].map((b) => ({ id: b.id, from: b.origin, reason: b.reason, workspace: b.workspace })),
    budget: budgetNow(),
    strength: Object.fromEntries(state.strength),
    refused_operator_attempts: state.deniedOperator,
    watcher: { configured: options.watcher !== undefined, model: options.watcher?.model ?? null, spent_usd: Math.round(state.watcherSpendUsd * 10000) / 10000, budget_usd: options.watcher?.totalBudgetUsd ?? null, calls: state.drift.filter((d) => d.status === "scored").length },
    drift: state.drift.slice(-10),
    suggested_restart: suggested(),
  });

  const publish = (): void => {
    const target = statePath(home);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot()), { mode: 0o600 });
    renameSync(temp, target);
  };

  // ---- checkpoints ----------------------------------------------------------------------------

  const verifyCharterFile = (): boolean => {
    try {
      const again = loadApprovedCharter(folder, ledger.entries());
      return again.hash === charterHashNow;
    } catch {
      return false;
    }
  };

  const scopeViolations = (paths: string[]): string[] =>
    paths.filter((path) => matchesPath(charter.scope.deny_paths, path) || !matchesPath(charter.scope.allow_paths, path));

  const runStageChecks = async (stage: string, checkpoint: string): Promise<void> => {
    const def = charter.stages.find((s) => s.id === stage);
    if (!def || workspaceRoot === null) return;
    if (state.checksDigest && digestTree(pristineChecks) !== state.checksDigest) return;
    for (const id of def.exit_checks) {
      const check = charter.checks.find((c) => c.id === id);
      if (!check) continue;
      const outcome = await runCheck(check, workspaceRoot, existsSync(pristineChecks) ? pristineChecks : null, checkTimeoutMs, { gitDir: join(folder, "snapshots.git"), ref: `refs/candor/${run}/${state.activeBranch}/${checkpoint.slice(state.activeBranch.length)}` });
      append("check_result", "candord", {
        check: id,
        stage,
        checkpoint,
        status: outcome.status,
        exit_code: outcome.exitCode,
        output: clip(outcome.output, 400),
        strength: state.strength.get(id)?.status ?? "not tested",
      });
    }
  };

  interface Recorded {
    id: string;
    entry: Entry;
    commit: string;
    previousCommit: string | null;
  }

  /** The part of a checkpoint that must happen at once: the snapshot, the integrity checks, the entry and the anchor. */
  const recordCheckpoint = (trigger: string, extra: { stage?: string; session?: string; beforeActionDigest?: string } = {}): Recorded | null => {
    if (workspaceRoot === null) return null;
    const branch = state.activeBranch;
    const previous = state.checkpoints.filter((c) => c.branch === branch).at(-1) ?? null;
    const n = (previous?.n ?? 0) + 1;
    const id = `${branch}${n}`;
    const ref = `refs/candor/${run}/${branch}/${n}`;
    let commit: string;
    let paths: string[] = [];
    try {
      const snap = takeSnapshot({ gitDir: join(folder, "snapshots.git"), workdir: workspaceRoot, ref, message: `checkpoint ${id} (${trigger})`, date: now() });
      commit = snap.commit;
      paths = changedPaths(join(folder, "snapshots.git"), previous?.commit ?? state.baseline, snap.commit);
    } catch (error) {
      append("check_result", "candord", { check: "checkpoint", ok: false, reason: `The snapshot failed: ${error instanceof Error ? error.message : String(error)}` });
      return null;
    }
    // A change made to the charter behind the daemon shows up here as a hash mismatch.
    if (!verifyCharterFile()) {
      append("check_result", "candord", { check: "charter_hash", ok: false, forced_pause: true, reason: "The charter file no longer matches the hash recorded at approval. The run is paused. Keep the file as evidence and start a new run." });
    }
    // The saved copy of the check scripts must still match the digest written at run start.
    if (state.checksDigest && digestTree(pristineChecks) !== state.checksDigest) {
      append("check_result", "candord", { check: "checks_digest", ok: false, forced_pause: true, reason: "The saved copy of the check scripts no longer matches the digest recorded at the start of the run. The run is paused." });
    }
    const outside = scopeViolations(paths);
    if (outside.length > 0) {
      append("check_result", "candord", { check: "scope_diff", ok: false, checkpoint: id, files: outside.slice(0, 50), count: outside.length, reason: "Files changed that the charter scope does not allow. The tool call rules cannot see every change, such as one made by a program the job started." });
    }
    const session = extra.session ?? [...state.sessions].at(-1) ?? null;
    const head = ledger.head();
    const checkpointEntry = append("checkpoint", "candord", {
      id,
      n,
      parent: previous?.id ?? null,
      stage: extra.stage ?? null,
      trigger,
      git_ref: ref,
      commit,
      session: { id: session, message_uuid: session ? (latestMessage.get(session) ?? null) : null },
      ledger_head: head.hash,
      ledger_head_seq: head.seq,
      charter_version: charter.version,
      safety: state.irreversibleBranches.has(branch) ? "record_only" : "safe_to_restart",
      effects_since_parent: state.effectSeqs.filter((seq) => seq > (previous?.seq ?? 0)),
      changed_count: paths.length,
      changed_paths: paths.slice(0, 50),
      ...(extra.beforeActionDigest ? { before_action_digest: extra.beforeActionDigest } : {}),
    });
    try {
      anchorHead(ledger, anchorPath(home, run), now);
    } catch (error) {
      append("check_result", "candord", { check: "anchor", ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
    publish();
    return { id, entry: checkpointEntry, commit, previousCommit: previous?.commit ?? state.baseline };
  };

  /** The slow part of a checkpoint: the exit checks of the stage, then the watcher, which sees those checks. */
  const finishCheckpoint = async (recorded: Recorded, trigger: string, extra: { stage?: string } = {}): Promise<string> => {
    const { id, entry: checkpointEntry, commit } = recorded;
    if (extra.stage) await runStageChecks(extra.stage, id);
    // The watcher scores the checkpoint last, so the exit checks of the stage are in its evidence.
    let changes: string | null = null;
    try {
      changes = redactor.text(diffText(join(folder, "snapshots.git"), recorded.previousCommit, commit, MAX_CHANGES_CHARS));
    } catch {
      // The comparison failed. The watcher then sees the list of paths only, and the bundle says so.
    }
    try {
      await watchCheckpoint({ config: options.watcher ?? null, ledger, append, state, charter, redactor }, checkpointEntry, changes, trigger);
    } catch (error) {
      append("check_result", "candord", { check: "watcher", ok: false, checkpoint: id, reason: `The watcher step failed: ${error instanceof Error ? error.message : String(error)}` });
    }
    publish();
    return id;
  };

  /** A whole checkpoint, for callers that are already in the queue: a manual checkpoint and the final one. */
  const takeCheckpoint = async (trigger: string, extra: { stage?: string; session?: string; beforeActionDigest?: string } = {}): Promise<string | null> => {
    const recorded = recordCheckpoint(trigger, extra);
    return recorded === null ? null : finishCheckpoint(recorded, trigger, extra);
  };

  // ---- stage reports (D-019: a file the worker writes, picked up by a hook) --------------------

  const refuse = (stage: string, reason: string, key: string): void => {
    if (refusedKeys.has(key)) return;
    refusedKeys.add(key);
    append("stage_report", "worker", { stage, form: "file", accepted: false, reason });
  };

  const recordStageReport = (stage: string, file: string): void => {
    const info = statSync(file);
    if (!info.isFile()) {
      refuse(stage, "The report is not a regular file.", `${stage}:${file}:not-a-file`);
      return;
    }
    if (info.size > MAX_REPORT) {
      refuse(stage, "The report file is too large.", `${stage}:${file}:${info.size}:${info.mtimeMs}`);
      return;
    }
    const text = readFileSync(file, "utf8");
    const reportDigest = digest(text);
    if (state.stageReports.get(`${state.activeBranch}/${stage}`) === reportDigest) return;
    if (!charter.stages.some((s) => s.id === stage)) {
      refuse(stage, `The charter has no stage named ${stage}.`, `${stage}:${reportDigest}:unknown`);
      return;
    }
    let parsed: z.infer<typeof StageReport>;
    try {
      const result = StageReport.safeParse(JSON.parse(text));
      if (!result.success) {
      refuse(stage, "The report must be JSON with done (true or false), and optionally deviations (a list of text) and confidence (0 to 1).", `${stage}:${reportDigest}:schema`);
      return;
    }
      parsed = result.data;
    } catch {
      refuse(stage, "The report is not valid JSON.", `${stage}:${reportDigest}:json`);
      return;
    }
    append("stage_report", "worker", {
      stage,
      form: "file",
      accepted: true,
      report_digest: reportDigest,
      bytes: info.size,
      done: parsed.done,
      confidence: parsed.confidence ?? null,
      summary: typeof parsed.summary === "string" ? clip(parsed.summary, 600) : null,
      deviations: (parsed.deviations ?? []).slice(0, 10).map((d) => clip(d, 300)),
    });
    if (parsed.done) queueCheckpoint("stage_done", { stage });
  };

  const pickUpReports = (root: string): void => {
    const dir = insideWorkspace(root, "reports");
    if (dir === null || !statSync(dir).isDirectory()) return;
    for (const name of readdirSync(dir).sort()) {
      const match = STAGE_FILE.exec(name);
      const file = match ? insideWorkspace(root, join("reports", name)) : null;
      if (match?.[1] && file) recordStageReport(match[1], file);
    }
  };

  // After each tool call, files covered by a personal data check are scanned. This catches what the call rules cannot read, such as a shell redirect.
  const scanEveryAction = (): void => {
    if (workspaceRoot === null) return;
    for (const check of charter.checks) {
      if (check.type !== "pattern" || check.when !== "every_action") continue;
      const outcome = scanPattern(workspaceRoot, check);
      for (const finding of outcome.findings ?? []) {
        const key = `${check.id}:${finding.file}:${finding.matches}`;
        if (scanSeen.has(key)) continue;
        scanSeen.add(key);
        append("check_result", "candord", { check: check.id, status: "failed", file: finding.file, matches: finding.matches, reason: `Personal data (${check.deny}) found in ${finding.file}. The text is not recorded.` });
      }
    }
  };

  // ---- the hook channel -----------------------------------------------------------------------

  const preToolUse = async (input: Record<string, unknown>, common: Record<string, unknown>): Promise<HookReply> => {
    // An assessment that is still running may be about to pause the run. Wait for it, but not past the hook timeout.
    if (options.watcher && pendingCheckpoints > 0) {
      await Promise.race([queue, new Promise<void>((resolveWait) => setTimeout(resolveWait, options.watcher?.waitMs ?? DEFAULT_WAIT_MS))]);
    }
    const tool = typeof input.tool_name === "string" ? input.tool_name : "unknown";
    const toolInput = (input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {}) as Record<string, unknown>;
    const toolUseId = typeof input.tool_use_id === "string" ? input.tool_use_id : null;
    const body = { ...common, tool, tool_use_id: toolUseId, input_digest: digest(toolInput) };

    const refuseWith = (rule: string, reason: string, summary: string, actionDigest: string): HookReply => {
      append("tool_intent", "worker", { ...body, summary, action_digest: actionDigest, decision: "deny", rule, reason });
      return { decision: "deny", reason };
    };

    const callCwd = typeof input.cwd === "string" ? input.cwd : null;
    if (state.activeBranch !== FIRST_BRANCH && workspaceRoot !== null && callCwd !== null) {
      let real = callCwd;
      try {
        real = realpathSync(callCwd);
      } catch {
        // A folder that cannot be read is not inside the workspace.
      }
      if (real !== workspaceRoot && !real.startsWith(`${workspaceRoot}/`)) {
        return refuseWith("stale_session", `This session runs in ${callCwd}, which is not the workspace of branch ${state.activeBranch}. A session of an earlier branch cannot act on the new one.`, tool, digest({ tool, input: toolInput }));
      }
    }
    const quick = workspaceRoot === null ? null : evaluateAction(charter, workspaceRoot, tool, toolInput);
    const summary = quick?.summary ?? tool;
    const actionDigest = quick?.actionDigest ?? digest({ tool, input: toolInput });
    if (state.paused) {
      return refuseWith("paused", `The run is paused. ${state.pauseReason ?? ""} The operator must choose continue, add a rule with --continue, or restart before any tool call.`.replace("  ", " "), summary, actionDigest);
    }
    const b = budgetNow();
    if (b.spent_usd >= b.max_usd) return refuseWith("budget", `The run has used its cost budget (${b.spent_usd} of ${b.max_usd} dollars across all branches). The operator must raise the budget in a new charter version.`, summary, actionDigest);
    if (b.minutes >= b.max_minutes) return refuseWith("budget", `The run has used its time budget (${b.minutes} of ${b.max_minutes} minutes).`, summary, actionDigest);
    if (b.turns >= b.max_turns) return refuseWith("budget", `The run has used its turn budget (${b.turns} of ${b.max_turns}).`, summary, actionDigest);
    if (workspaceRoot === null || quick === null) return refuseWith("scope", "The workspace of this run is not known yet, so no action can be checked. Candor fails closed.", summary, actionDigest);

    const verdict: Verdict = quick;
    const effectBody = (v: Verdict, extra: Record<string, unknown>): void => {
      for (const effect of v.effects.filter((e) => e.kind !== "irreversible")) {
        append("effect", "candord", { ...common, kind: effect.kind, summary: effect.summary, reversible: effect.reversible, tool, tool_use_id: toolUseId, decision: v.decision, performed: false, ...extra });
      }
    };

    if (verdict.decision === "deny") {
      effectBody(verdict, { blocked: true });
      return refuseWith(verdict.rule ?? "scope", verdict.reason ?? "Denied by the charter.", verdict.summary, verdict.actionDigest);
    }

    if (verdict.decision === "hold") {
      const approval = openApproval(state, verdict.actionDigest, state.activeBranch, now().getTime());
      if (approval) {
        append("tool_intent", "worker", { ...body, summary: verdict.summary, action_digest: verdict.actionDigest, decision: "allow", approval_seq: approval.seq });
        append("effect", "candord", { ...common, kind: "irreversible", irreversible: true, reversible: false, summary: verdict.summary, tool, tool_use_id: toolUseId, action_digest: verdict.actionDigest, approval_seq: approval.seq, performed: false });
        if (toolUseId) pendingIrreversible.set(toolUseId, { digest: verdict.actionDigest, summary: verdict.summary, tool });
        return { decision: "allow" };
      }
      const known = state.held.has(verdict.actionDigest);
      const reason = `${verdict.reason ?? "This action is irreversible."} It is held. The operator must approve this exact action, then retry it. Held action: ${verdict.actionDigest.slice(7, 19)}. Do not try another way to do the same thing.`;
      append("tool_intent", "worker", { ...body, summary: verdict.summary, action_digest: verdict.actionDigest, decision: "hold", rule: "irreversible", reason });
      if (!known) queueCheckpoint("before_irreversible", { beforeActionDigest: verdict.actionDigest });
      return { decision: "deny", reason };
    }

    effectBody(verdict, { blocked: false });
    append("tool_intent", "worker", { ...body, summary: verdict.summary, action_digest: verdict.actionDigest, decision: "allow" });
    return { decision: "allow" };
  };

  const handleHook = async (event: string, input: Record<string, unknown>, meta: Record<string, unknown>): Promise<HookReply> => {
    const session = typeof input.session_id === "string" ? input.session_id : "unknown";
    const cwd = typeof input.cwd === "string" ? input.cwd : null;
    const common = { session, ...(typeof input.agent_id === "string" ? { agent_id: input.agent_id } : {}) };
    state.lastEvent = event;
    state.lastEventTs = now().toISOString();
    state.sessions.add(session);

    switch (event) {
      case "SessionStart":
        if (workspaceRoot === null && cwd !== null) {
          try {
            workspaceRoot = realpathSync(cwd);
          } catch {
            // The folder is not readable. The workspace stays unset and every action is refused.
          }
        }
        prepareRun();
        // The fixed fields come last, so a caller cannot overwrite them through meta.
        append("session_start", "worker", { ...meta, ...common, source: input.source ?? null, model: input.model ?? null, workspace: workspaceRoot });
        return { decision: "allow" };
      case "PreToolUse":
        return await preToolUse(input, common);
      case "PostToolUse":
      case "PostToolUseFailure": {
        const tool = typeof input.tool_name === "string" ? input.tool_name : null;
        const toolUseId = typeof input.tool_use_id === "string" ? input.tool_use_id : null;
        append("tool_result", "worker", {
          ...common,
          tool,
          tool_use_id: toolUseId,
          failed: event === "PostToolUseFailure",
          result_digest: digest(input.tool_response ?? input.error ?? null),
          output_excerpt: excerptOf(input.tool_response ?? input.error ?? null),
        });
        const pending = toolUseId ? pendingIrreversible.get(toolUseId) : undefined;
        if (pending && toolUseId) {
          pendingIrreversible.delete(toolUseId);
          append("effect", "candord", { ...common, kind: "irreversible", irreversible: true, reversible: false, summary: pending.summary, tool: pending.tool, tool_use_id: toolUseId, action_digest: pending.digest, performed: true, failed: event === "PostToolUseFailure" });
        }
        if (workspaceRoot !== null) {
          pickUpReports(workspaceRoot);
          scanEveryAction();
        }
        // A warning from the watcher reaches the worker once, as context after its next tool call, and the delivery is recorded.
        const note = state.notes.find((n) => !n.delivered);
        if (note) {
          append("check_result", "candord", { check: "watcher_note", event: "delivered", checkpoint: note.checkpoint, drift_seq: note.seq, tool_use_id: toolUseId });
          return { decision: "allow", note: note.text };
        }
        return { decision: "allow" };
      }
      case "ConfigChange": {
        const source = typeof input.source === "string" ? input.source : "unknown";
        const blocked = source === "user_settings" || source === "project_settings" || source === "local_settings";
        append("config_change", "worker", { ...common, source, file_path: input.file_path ?? null, blocked });
        return blocked ? { decision: "deny", reason: "Settings changes are not applied while a Candor run is active." } : { decision: "allow" };
      }
      default:
        // Stop, SessionEnd, SubagentStart, SubagentStop and PreCompact share one generic type (D-026).
        append("hook_event", "worker", { ...common, event });
        if (workspaceRoot !== null && (event === "Stop" || event === "SessionEnd" || event === "SubagentStop")) pickUpReports(workspaceRoot);
        if (event === "PreCompact") queueCheckpoint("pre_compact", { session });
        if (event === "SubagentStop") queueCheckpoint("subagent_stop", { session });
        return { decision: "allow" };
    }
  };

  // ---- rule change, re-scoring and restart ------------------------------------------------------

  const DIMENSIONS = ["goal", "scope", "plan", "evidence"] as const;
  const MAX_REASON = 600;
  const dimensionOf = (value: unknown): RuleDimension | null => (value === undefined ? "goal" : DIMENSIONS.find((d) => d === value) ?? null);

  /** One list row per checkpoint scored again: the first score, the score before this change, and the new one. Read from the ledger, so it is what was recorded. */
  const rescoreRows = (fromSeq: number): Record<string, unknown>[] =>
    ledger
      .entries()
      .filter((e) => e.type === "rescore" && e.seq > fromSeq)
      .map((e) => ({ seq: e.seq, checkpoint: e.body.checkpoint, status: e.body.status, reason: e.body.reason ?? null, first: e.body.first ?? null, previous: e.body.previous ?? null, overall: e.body.overall ?? null, level: e.body.level ?? null, dimensions: e.body.dimensions ?? null, findings: e.body.findings ?? [] }));

  const addRule = async (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
    const refuseRule = (status: number, reason: string): { status: number; body: Record<string, unknown> } => {
      append("human_action", "operator", { action: "rule", accepted: false, reason });
      return { status, body: { error: reason } };
    };
    const dimension = dimensionOf(body.dimension);
    if (dimension === null) return refuseRule(400, `The dimension must be one of ${DIMENSIONS.join(", ")}.`);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length > MAX_REASON) return refuseRule(400, `The reason can be at most ${MAX_REASON} characters.`);
    let change: ReturnType<typeof withRule>;
    try {
      change = withRule(charter, { text: typeof body.text === "string" ? body.text : "", dimension, source: "operator" });
    } catch (error) {
      return refuseRule(400, error instanceof Error ? error.message : String(error));
    }
    writeCharterVersion(folder, change.charter);
    const previous = charter;
    const entry = append("rule_change", "operator", {
      author: "operator",
      source: "operator",
      reason: reason || null,
      rule: change.rule,
      from_version: previous.version,
      version: change.charter.version,
      charter_hash: change.hash,
      previous_hash: change.previousHash,
    });
    charter = change.charter;
    charterHashNow = change.hash;
    if (body.continue === true && state.paused) append("human_action", "operator", { action: "continue", accepted: true, with: "rule" });
    // Every checkpoint before this change is scored again, from the stored evidence, one at a time.
    let summary: Awaited<ReturnType<typeof rescoreCheckpoints>> | null = null;
    summary = await rescoreCheckpoints({ config: options.watcher ?? null, ledger, append, state, charter, redactor }, entry.seq, previous.version);
    publish();
    return { status: 200, body: { version: charter.version, rule: change.rule, rule_change_seq: entry.seq, rescore: summary, scores: rescoreRows(entry.seq), paused: state.paused } };
  };

  /** Folders the allowed paths start in, so an empty folder of the old workspace exists in the new one. A snapshot cannot hold an empty folder. */
  const allowedFolders = (): string[] =>
    charter.scope.allow_paths
      .map((pattern) => {
        const parts = pattern.split("/").filter((part) => part.length > 0);
        const glob = parts.findIndex((part) => /[*?[\]{}]/.test(part));
        // Before the first pattern segment, or all but the last segment when there is none (the last one is a file).
        return glob >= 0 ? parts.slice(0, glob) : parts.slice(0, -1);
      })
      .filter((parts) => parts.length > 0 && !parts.includes(".."))
      .map((parts) => parts.join("/"));

  const restart = async (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
    const refuseRestart = (status: number, reason: string, extra: Record<string, unknown> = {}): { status: number; body: Record<string, unknown> } => {
      append("human_action", "operator", { action: "restart", accepted: false, reason, ...extra });
      return { status, body: { error: reason } };
    };
    const id = typeof body.checkpoint === "string" ? body.checkpoint : "";
    const reason = typeof body.reason === "string" ? body.reason.trim().replace(/\s+/g, " ") : "";
    if (reason.length === 0) return refuseRestart(400, "A restart needs a reason. Say what went wrong and what the new branch must do differently. It becomes a rule on the new branch.");
    if (reason.length > MAX_REASON) return refuseRestart(400, `The reason can be at most ${MAX_REASON} characters.`);
    const dimension = dimensionOf(body.dimension);
    if (dimension === null) return refuseRestart(400, `The dimension must be one of ${DIMENSIONS.join(", ")}.`);
    const cp = state.checkpoints.find((c) => c.id === id);
    if (!cp) return refuseRestart(404, `There is no checkpoint ${id || "(none given)"}. Checkpoints: ${state.checkpoints.map((c) => c.id).join(", ") || "none"}.`);
    if (cp.safety !== "safe_to_restart") {
      return refuseRestart(409, `Checkpoint ${cp.id} is marked ${cp.safety}: an irreversible action had already happened on its branch, so the files of the checkpoint do not undo it. Restart from an earlier checkpoint that is safe_to_restart.`, { checkpoint: cp.id });
    }
    if (state.rootWorkspace === null || workspaceRoot === null) return refuseRestart(409, "The workspace of this run is not known yet.");
    const cpEntry = ledger.entries().find((e) => e.seq === cp.seq);
    if (!cpEntry) return refuseRestart(500, `The ledger entry of checkpoint ${cp.id} was not found.`);
    const gitDir = join(folder, "snapshots.git");
    const used = new Set([FIRST_BRANCH, ...state.branches.keys()]);
    const next = "BCDEFGHIJKLMNOPQRSTUVWXYZ".split("").find((letter) => !used.has(letter));
    if (!next) return refuseRestart(409, "This run has used every branch letter.");
    const worktree = join(dirname(state.rootWorkspace), `${basename(state.rootWorkspace)}.${run}.${next}`);
    if (existsSync(worktree)) return refuseRestart(409, `The folder ${worktree} already exists. Candor does not write into a folder that is there. Move it, then try again.`);

    // 1. The files of the checkpoint, in a new folder. The old workspace and its branch are not touched.
    const cpCommit = typeof cpEntry.body.commit === "string" ? cpEntry.body.commit : "";
    const cpRef = typeof cpEntry.body.git_ref === "string" ? cpEntry.body.git_ref : "";
    let forkCommit: string;
    let tree: string;
    try {
      exportSnapshot(gitDir, cpRef, worktree);
      for (const dir of allowedFolders()) mkdirSync(join(worktree, dir), { recursive: true });
      const fork = takeSnapshot({ gitDir, workdir: worktree, ref: `refs/candor/${run}/${next}/1`, message: `restart of ${cp.id} as branch ${next}`, date: now() });
      forkCommit = fork.commit;
      tree = fork.tree;
      if (treeOf(gitDir, cpCommit) !== tree) throw new Error("the files in the new folder are not the files of the checkpoint");
    } catch (error) {
      rmSync(worktree, { recursive: true, force: true });
      return refuseRestart(500, `The worktree could not be made from checkpoint ${cp.id}: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`, { checkpoint: cp.id });
    }

    // 2. The reason becomes a drift rule: a new charter version, written before anything uses it.
    let change: ReturnType<typeof withRule>;
    try {
      change = withRule(charter, { text: `Restart from ${cp.id}: ${reason}`, dimension, source: "restart" });
    } catch (error) {
      rmSync(worktree, { recursive: true, force: true });
      return refuseRestart(400, error instanceof Error ? error.message : String(error));
    }
    writeCharterVersion(folder, change.charter);
    const session = (cpEntry.body.session && typeof cpEntry.body.session === "object" ? cpEntry.body.session : {}) as { id?: unknown; message_uuid?: unknown };
    const sessionId = typeof session.id === "string" ? session.id : null;
    const messageUuid = typeof session.message_uuid === "string" ? session.message_uuid : null;
    const conversation = sessionId && messageUuid ? "fork" : "fresh";
    append("rule_change", "operator", { author: "operator", source: "restart", reason, rule: change.rule, from_version: charter.version, version: change.charter.version, charter_hash: change.hash, previous_hash: change.previousHash, branch: next, restart_from: cp.id }, next);
    charter = change.charter;
    charterHashNow = change.hash;

    // 3. The restart entry moves the run to the new branch: no pause, nothing held, no approval carried over.
    const instruction = `Restart. You are on branch ${next}, started from checkpoint ${cp.id} of branch ${cp.branch}. The files in your workspace are exactly the files of that checkpoint. The reason for the restart: ${reason} This is now a rule of the job. Check the files before you rely on what you remember, because your memory may stop earlier or later than the files. Then carry on with the job.`;
    const inherited: Record<string, string> = {};
    for (const name of existsSync(join(worktree, "reports")) ? readdirSync(join(worktree, "reports")) : []) {
      const match = STAGE_FILE.exec(name);
      const file = match ? insideWorkspace(realpathSync(worktree), join("reports", name)) : null;
      if (match?.[1] && file) inherited[match[1]] = digest(readFileSync(file, "utf8"));
    }
    const restartEntry = append(
      "restart",
      "operator",
      { from: cp.id, from_branch: cp.branch, from_seq: cp.seq, from_commit: cpCommit, to_branch: next, reason, session: { id: sessionId, message_uuid: messageUuid }, conversation, workspace: worktree, fork_commit: forkCommit, tree, tree_matches_checkpoint: true, charter_version: charter.version, rule: change.rule.id, inherited_reports: inherited, instruction },
      next,
    );
    workspaceRoot = realpathSync(worktree);
    pendingIrreversible.clear();
    // 4. The first checkpoint of the new branch is the fork point itself. It is not scored: nothing new happened.
    const head = ledger.head();
    append("checkpoint", "candord", {
      id: `${next}1`,
      n: 1,
      parent: cp.id,
      stage: cp.stage,
      trigger: "restart",
      git_ref: `refs/candor/${run}/${next}/1`,
      commit: forkCommit,
      session: { id: sessionId, message_uuid: messageUuid },
      ledger_head: head.hash,
      ledger_head_seq: head.seq,
      charter_version: charter.version,
      safety: "safe_to_restart",
      effects_since_parent: [],
      changed_count: 0,
      changed_paths: [],
      restart_of: cp.id,
    });
    try {
      anchorHead(ledger, anchorPath(home, run), now);
    } catch (error) {
      append("check_result", "candord", { check: "anchor", ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
    publish();
    return {
      status: 200,
      body: { branch: next, from: cp.id, from_branch: cp.branch, workspace: worktree, session: sessionId, message_uuid: messageUuid, conversation, charter_version: charter.version, rule: change.rule, instruction, restart_seq: restartEntry.seq },
    };
  };

  // ---- the operator channel -------------------------------------------------------------------

  const isOperator = (req: IncomingMessage): boolean => {
    const given = req.headers["x-candor-operator"];
    if (typeof given !== "string") return false;
    const candidate = Buffer.from(given, "utf8");
    return candidate.length === operatorKey.length && timingSafeEqual(candidate, operatorKey);
  };

  const recordRefusal = (action: string): void => {
    // Writing the entry counts it. Past the limit only the count grows.
    if (state.deniedOperator < MAX_RECORDED_REFUSALS) append("human_action", "worker", { action, accepted: false, reason: "No valid operator secret. Operator actions are not accepted from the worker." });
    else state.deniedOperator++;
  };

  const findHeld = (prefix: string): Held | "ambiguous" | null => {
    const hex = prefix.replace(/^sha256:/, "");
    if (!/^[0-9a-f]{8,64}$/.test(hex)) return null;
    const hits = [...state.held.values()].filter((h) => h.digest.slice(7).startsWith(hex));
    if (hits.length === 0) return null;
    return hits.length === 1 ? (hits[0] as Held) : "ambiguous";
  };

  const operatorAction = async (action: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
    switch (action) {
      case "pause":
      case "continue":
        append("human_action", "operator", { action, accepted: true });
        return { status: 200, body: { ...snapshot() } };
      case "approve": {
        const held = findHeld(typeof body.digest === "string" ? body.digest : "");
        if (held === "ambiguous") return { status: 409, body: { error: "More than one held action starts with that text. Give more characters of the digest." } };
        if (held === null) {
          append("human_action", "operator", { action, accepted: false, reason: "No held action matches that digest. Only an action that was denied and held can be approved." });
          return { status: 404, body: { error: "No held action matches that digest. Run: candor status" } };
        }
        const minutes = typeof body.minutes === "number" && body.minutes > 0 && body.minutes <= 240 ? body.minutes : DEFAULT_APPROVAL_MINUTES;
        const expires = new Date(now().getTime() + minutes * 60000).toISOString();
        const entry = append("human_action", "operator", { action, accepted: true, action_digest: held.digest, summary: held.summary, held_seq: held.seq, expires_at: expires, single_use: true });
        return { status: 200, body: { approved: held.digest, expires_at: expires, seq: entry.seq } };
      }
      case "checkpoint": {
        let id: string | null = null;
        await enqueue(async () => {
          id = await takeCheckpoint("manual");
        });
        return { status: id ? 200 : 500, body: id ? { checkpoint: id } : { error: "The checkpoint failed. Check the ledger for the reason." } };
      }
      case "strength": {
        if (workspaceRoot === null) return { status: 409, body: { error: "The workspace is not known yet." } };
        prepareRun();
        const results = await strengthTest(charter, workspaceRoot, existsSync(pristineChecks) ? pristineChecks : null, checkTimeoutMs, oracleEnv());
        for (const r of results) append("check_strength", "candord", { ...r });
        publish();
        return { status: 200, body: { results } };
      }
      case "rule":
      case "restart": {
        // Wait for checkpoints already queued, and hold later ones until the change is done, so no snapshot reads half of a switch.
        let result: { status: number; body: Record<string, unknown> } = { status: 500, body: { error: "The change did not run." } };
        await enqueue(async () => {
          result = action === "rule" ? await addRule(body) : await restart(body);
        });
        return result;
      }
      case "start": {
        // The harness starts or ends a stretch of work by one claude call. Time and spend are counted from these.
        prepareRun();
        append("check_result", "candord", { check: "budget", event: "segment_start" });
        return { status: 200, body: { ...snapshot() } };
      }
      case "usage": {
        const cost = typeof body.cost_usd === "number" && body.cost_usd >= 0 ? body.cost_usd : 0;
        const turns = typeof body.turns === "number" && body.turns >= 0 ? Math.floor(body.turns) : 0;
        const open = state.spend.openSegmentStart;
        append("check_result", "candord", { check: "budget", event: "usage", cost_usd: cost, turns, active_ms: open === null ? 0 : Math.max(0, now().getTime() - open), model: typeof body.model === "string" ? body.model : null, session: typeof body.session === "string" ? body.session : null });
        return { status: 200, body: { budget: budgetNow() } };
      }
      case "fork-result": {
        // The harness reports whether the conversation was really forked, so the ledger says what happened and not what was meant.
        append("check_result", "candord", { check: "fork", ok: body.ok === true, branch: state.activeBranch, conversation: typeof body.conversation === "string" ? body.conversation : null, from_session: typeof body.from_session === "string" ? body.from_session : null, new_session: typeof body.new_session === "string" ? body.new_session : null, reason: typeof body.reason === "string" ? clip(body.reason, 400) : null });
        return { status: 200, body: {} };
      }
      case "message": {
        if (typeof body.session === "string" && typeof body.message_uuid === "string") latestMessage.set(body.session, body.message_uuid);
        return { status: 200, body: {} };
      }
      case "init": {
        append("session_start", "candord", {
          source: "harness_init",
          session: typeof body.session === "string" ? body.session : "unknown",
          claude_code_version: body.claude_code_version ?? null,
          model: body.model ?? null,
          plugins: body.plugins ?? [],
          mods_and_plugins_complete: body.complete === true,
          tools: body.tools ?? [],
          workspace: workspaceRoot,
        });
        return { status: 200, body: {} };
      }
      case "end": {
        // A final checkpoint, then the success checks on the final state, which the worker cannot influence by what it reports.
        await enqueue(async () => {
          await takeCheckpoint("final");
          if (workspaceRoot === null) return;
          const statuses: string[] = [];
          for (const criterion of charter.success) {
            const check = charter.checks.find((c) => c.id === criterion.check);
            if (!check) {
              statuses.push("not_verified");
              append("acceptance_result", "candord", { criterion: criterion.id, check: null, status: "not_verified", reason: "No check is named for this criterion." });
              continue;
            }
            const outcome = await runCheck(check, workspaceRoot, existsSync(pristineChecks) ? pristineChecks : null, checkTimeoutMs, undefined, oracleEnv());
            const strength = state.strength.get(check.id)?.status ?? "not tested";
            const status = outcome.status === "passed" && strength === "proven" ? "verified" : outcome.status === "failed" ? "failed" : "not_verified";
            statuses.push(status);
            append("acceptance_result", "candord", {
              criterion: criterion.id,
              check: check.id,
              status,
              check_status: outcome.status,
              strength,
              reason: status === "not_verified" ? (outcome.status === "passed" ? `The check passed, but its strength is ${strength}, so it does not count as verified.` : `The check ended with status ${outcome.status}.`) : "",
              output: clip(outcome.output, 300),
            });
          }
          // The verdict from the acceptance checks alone, written before the answer key second look so both stay in the record (D-052).
          const verdict = statuses.includes("failed") ? "no" : statuses.every((x) => x === "verified") ? "yes" : "partly";
          append("acceptance_result", "candord", { criterion: "checks-verdict", scope: "checks_verdict", check: null, status: verdict, reason: "The verdict from the acceptance checks alone, before the answer key comparison." });
          // The final state is also compared with the answer key, apart from the checks of the charter (D-052).
          if (existsSync(oracleDir)) {
            const key = await compareWithAnswerKey(oracleDir, workspaceRoot, existsSync(pristineChecks) ? pristineChecks : null, checkTimeoutMs);
            append("acceptance_result", "candord", { criterion: "answer-key", scope: "answer_key", check: null, status: key.status, reason: key.detail, output: clip(key.output, 300) });
          }
        });
        append("run_end", "candord", { reason: typeof body.reason === "string" ? body.reason : "ended", budget: budgetNow() });
        return { status: 200, body: { ...snapshot() } };
      }
      default:
        return { status: 404, body: { error: "Unknown request." } };
    }
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? "/";
        if (req.method === "GET" && url === "/state") return send(res, 200, snapshot());
        if (req.method !== "POST") return send(res, 404, { error: "Unknown request." });
        const parsed: unknown = JSON.parse((await readBody(req)) || "{}");
        const body = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;

        if (url === "/hook") {
          const event = typeof body.event === "string" ? body.event : "unknown";
          const input = (body.input && typeof body.input === "object" ? body.input : {}) as Record<string, unknown>;
          const meta = (body.meta && typeof body.meta === "object" ? body.meta : {}) as Record<string, unknown>;
          const reply = await handleHook(event, input, meta);
          publish();
          return send(res, 200, reply);
        }

        const match = /^\/(operator|harness)\/([a-z-]+)$/.exec(url);
        if (match?.[2]) {
          const action = match[2];
          if (!isOperator(req)) {
            recordRefusal(action);
            publish();
            return send(res, 403, { error: "Operator actions need the operator secret." });
          }
          const result = await operatorAction(action, body);
          publish();
          return send(res, result.status, result.body);
        }
        return send(res, 404, { error: "Unknown request." });
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : "Bad request." });
      }
    })();
  });

  const socket = socketPath(home);
  let ownInode = -1;
  if (existsSync(socket)) {
    // A live daemon owns the socket. Do not take it over.
    const alive = await callDaemon({ socket, method: "GET", path: "/state", timeoutMs: 500 }).then(
      () => true,
      () => false,
    );
    if (alive) throw new Error(`candord is already running at ${socket}. Stop it first, or set CANDOR_HOME to another folder.`);
    unlinkSync(socket);
  }
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolveListen());
  });
  try {
    chmodSync(socket, 0o600);
    ownInode = statSync(socket).ino;
    heartbeatGap();
    prepareRun();
    append("heartbeat", "candord", { started: true, pid: process.pid });
    publish();
  } catch (error) {
    // Never leave a half-started daemon listening.
    server.close();
    server.closeAllConnections();
    throw error;
  }

  return {
    socket,
    state: snapshot,
    idle: () => queue,
    close: () =>
      new Promise<void>((resolveClose) => {
        void queue.then(() => {
          server.close(() => {
            // Only remove the socket this daemon made. A newer daemon may own the path now.
            if (existsSync(socket) && statSync(socket).ino === ownInode) unlinkSync(socket);
            resolveClose();
          });
          server.closeAllConnections();
        });
      }),
  };
}
