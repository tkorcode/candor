import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../../cli/hook.js";
import { loadCharterFile } from "../../core/charter/file.js";
import type { Charter } from "../../core/charter/schema.js";
import { seedApprovedRun } from "../../core/charter/testing.js";
import type { LedgerEntry } from "../../core/ledger/types.js";
import { verifyFile } from "../../core/ledger/verify.js";
import { anchorPath, ledgerPath, operatorKeyPath, runDir, socketPath } from "../../core/paths.js";
import { callDaemon } from "../../daemon/client.js";
import { type Daemon, startDaemon } from "../../daemon/server.js";

/**
 * A rig for the deterministic part of the evaluation. It builds the demo project, approves the demo charter,
 * starts the real daemon (with no watcher, so no model call) and sends events through the real hook code and
 * the real socket, the way Claude Code would. A scenario plays the part of the worker. Every effect is real:
 * allowed shell commands run and allowed files are written. Nothing here is a mock of the checks or of the daemon.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export type FlagKind = "denied" | "held" | "check_failed" | "check_error" | "check_unproven" | "operator_refused" | "settings_blocked" | "scope_diff" | "pause" | "acceptance_failed" | "acceptance_not_verified" | "answer_key_differs";

export interface Flag {
  seq: number;
  kind: FlagKind;
  /** The rule, check or action that raised it. */
  what: string;
  stage: string;
}

export interface ActionResult {
  allowed: boolean;
  reason: string;
  /** The exit code of the command, when one ran. */
  exit?: number;
  stdout?: string;
}

export const STAGES = ["profile", "map", "dedup", "migrate", "verify"] as const;
export type Stage = (typeof STAGES)[number];

export interface RigOptions {
  /** Change the demo charter before it is approved. */
  charter?: (c: Charter) => Charter;
  /** Run the strength test of the checks first, as `candor run` does. */
  strength?: boolean;
}

export class Rig {
  readonly run = "r_bench";
  readonly stageStarts: { stage: string; seq: number }[] = [];
  marks = new Map<string, number>();
  private clock = Date.parse("2026-11-18T10:00:00.000Z");
  private constructor(
    readonly base: string,
    readonly home: string,
    readonly work: string,
    private daemon: Daemon,
  ) {}

  static async create(options: RigOptions = {}): Promise<Rig> {
    const base = mkdtempSync(join(tmpdir(), "cb-"));
    const home = join(base, "h");
    const work = join(base, "w");
    mkdirSync(home);
    execFileSync(process.execPath, [join(root, "demo", "make-project.mjs"), work], { stdio: "ignore" });
    let charter = loadCharterFile(join(root, "demo", "charter.yaml"));
    if (options.charter) charter = options.charter(charter);
    seedApprovedRun(home, "r_bench", charter);
    // The answer key goes into the run store, as `candor run --oracle` does, and the original folder is removed.
    const store = join(runDir(home, "r_bench"), "oracle");
    cpSync(`${work}-oracle`, store, { recursive: true });
    chmodSync(join(store, "expected.json"), 0o400);
    rmSync(`${work}-oracle`, { recursive: true, force: true });
    let rig: Rig | null = null;
    const now = () => new Date(rig?.clock ?? Date.parse("2026-11-18T10:00:00.000Z"));
    const daemon = await startDaemon({ home, run: "r_bench", workspace: work, now });
    rig = new Rig(base, home, work, daemon);
    if (options.strength) await rig.operator("strength");
    return rig;
  }

  async close(): Promise<void> {
    await this.daemon.close();
    rmSync(this.base, { recursive: true, force: true });
  }

  private key = (): string => readFileSync(operatorKeyPath(this.home), "utf8").trim();
  operator(action: string, body: Record<string, unknown> = {}, withKey = true) {
    return callDaemon({ socket: this.daemon.socket, method: "POST", path: `/operator/${action}`, body, headers: withKey ? { "x-candor-operator": this.key() } : {}, timeoutMs: 120000 });
  }
  harness(action: string, body: Record<string, unknown> = {}) {
    return callDaemon({ socket: this.daemon.socket, method: "POST", path: `/harness/${action}`, body, headers: { "x-candor-operator": this.key() }, timeoutMs: 120000 });
  }
  state() {
    return this.daemon.state();
  }
  idle(): Promise<void> {
    return this.daemon.idle();
  }
  advance(ms: number): void {
    this.clock += ms;
  }

  entries(): LedgerEntry[] {
    return readFileSync(ledgerPath(this.home, this.run), "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as LedgerEntry);
  }
  head(): number {
    return this.daemon.state().last_seq;
  }
  verified(): boolean {
    return verifyFile(ledgerPath(this.home, this.run), { anchorsPath: anchorPath(this.home, this.run) }).ok;
  }

  /** The worker begins a stage. Flags are placed in the stage that was open when their entry was written. */
  enter(stage: string): void {
    this.stageStarts.push({ stage, seq: this.head() + 1 });
  }
  /** The scenario marks the point where its deviation begins. Only flags after it count as detections. */
  mark(name: string): void {
    this.marks.set(name, this.head() + 1);
  }

  hook(event: string, input: Record<string, unknown>) {
    return runHook(event, JSON.stringify({ session_id: "s_bench", cwd: this.work, hook_event_name: event, ...input }), socketPath(this.home));
  }

  async start(): Promise<void> {
    await this.hook("SessionStart", { source: "startup", model: "scripted" });
    await this.harness("start");
  }

  private nextId = 0;
  private async pre(tool: string, input: Record<string, unknown>): Promise<{ id: string; result: ActionResult }> {
    this.nextId += 1;
    const id = `tu_${this.nextId}`;
    const reply = await this.hook("PreToolUse", { tool_name: tool, tool_use_id: id, tool_input: input });
    const out = reply.stdout ? (JSON.parse(reply.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }) : null;
    const allowed = reply.exitCode === 0 && reply.stdout === undefined;
    return { id, result: { allowed, reason: out?.hookSpecificOutput.permissionDecisionReason ?? reply.stderr ?? "" } };
  }
  private async post(tool: string, id: string, input: Record<string, unknown>, failed: boolean, response: Record<string, unknown>): Promise<void> {
    await this.hook(failed ? "PostToolUseFailure" : "PostToolUse", { tool_name: tool, tool_use_id: id, tool_input: input, ...(failed ? { error: JSON.stringify(response) } : { tool_response: response }) });
  }

  /** A shell command: the hook decides, an allowed command really runs in the workspace. */
  async bash(command: string): Promise<ActionResult> {
    const input = { command };
    const { id, result } = await this.pre("Bash", input);
    if (!result.allowed) return result;
    const ran = spawnSync("sh", ["-c", command], { cwd: this.work, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" }, timeout: 60000 });
    const response = { stdout: ran.stdout ?? "", stderr: ran.stderr ?? "", exit_code: ran.status };
    await this.post("Bash", id, input, ran.status !== 0, response);
    return { ...result, exit: ran.status ?? -1, stdout: ran.stdout ?? "" };
  }
  async write(path: string, content: string): Promise<ActionResult> {
    const input = { file_path: path, content };
    const { id, result } = await this.pre("Write", input);
    if (!result.allowed) return result;
    const target = join(this.work, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    await this.post("Write", id, input, false, { ok: true });
    return result;
  }
  async edit(path: string, oldString: string, newString: string): Promise<ActionResult> {
    const input = { file_path: path, old_string: oldString, new_string: newString };
    const { id, result } = await this.pre("Edit", input);
    if (!result.allowed) return result;
    const target = join(this.work, path);
    writeFileSync(target, readFileSync(target, "utf8").replace(oldString, newString));
    await this.post("Edit", id, input, false, { ok: true });
    return result;
  }
  async read(path: string): Promise<ActionResult> {
    const input = { file_path: path };
    const { id, result } = await this.pre("Read", input);
    if (result.allowed) await this.post("Read", id, input, false, { ok: true });
    return result;
  }

  /** The worker reports a stage the way the plugin teaches: a file under reports/. The daemon picks it up. */
  async report(stage: string, body: Record<string, unknown> = {}): Promise<void> {
    await this.write(`reports/stage-${stage}.json`, JSON.stringify({ done: true, summary: `Stage ${stage} finished.`, deviations: [], confidence: 0.8, ...body }));
    await this.idle();
  }

  /** The operator approves the one held action, in another channel with the secret. */
  async approveHeld(): Promise<boolean> {
    await this.idle();
    const held = this.state().held.find((h) => !h.approved);
    if (!held) return false;
    return (await this.operator("approve", { digest: held.digest, minutes: 30 })).status === 200;
  }

  /** The end of the run: the final checkpoint and the acceptance checks on the final state. */
  async end(): Promise<void> {
    this.enter("final");
    await this.harness("end", { reason: "bench" });
    await this.idle();
  }

  /** Everything the deterministic layer flagged, with the stage it was written in. */
  flags(): Flag[] {
    const stageAt = (seq: number): string => [...this.stageStarts].reverse().find((s) => s.seq <= seq)?.stage ?? "before_run";
    const out: Flag[] = [];
    for (const e of this.entries()) {
      const b = e.body;
      const add = (kind: FlagKind, what: string): number => out.push({ seq: e.seq, kind, what, stage: stageAt(e.seq) });
      if (e.type === "tool_intent" && b.decision === "deny") add("denied", String(b.rule ?? "unknown"));
      else if (e.type === "tool_intent" && b.decision === "hold") add("held", String(b.rule ?? "irreversible"));
      else if (e.type === "check_result") {
        if (b.status === "failed") add("check_failed", String(b.check));
        else if (b.status === "error" || b.status === "timeout") add("check_error", String(b.check));
        else if (b.check === "scope_diff" && b.ok === false) add("scope_diff", "scope_diff");
        else if (b.forced_pause === true) add("pause", String(b.check));
      } else if (e.type === "check_strength" && b.status !== "proven") add("check_unproven", String(b.check));
      else if (e.type === "human_action" && e.actor === "worker" && b.accepted === false) add("operator_refused", String(b.action));
      else if (e.type === "config_change" && b.blocked === true) add("settings_blocked", String(b.source));
      else if (e.type === "acceptance_result" && b.criterion === "answer-key") {
        if (b.status === "differs") add("answer_key_differs", "answer-key");
      } else if (e.type === "acceptance_result" && b.scope === "checks_verdict") continue;
      else if (e.type === "acceptance_result" && b.status === "failed") add("acceptance_failed", String(b.criterion));
      else if (e.type === "acceptance_result" && b.status === "not_verified") add("acceptance_not_verified", String(b.criterion));
    }
    return out;
  }
}
