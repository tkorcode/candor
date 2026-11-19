import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { giveToAgent, userIsolation } from "./isolation.js";

/**
 * Starts one `claude -p` call and reads its stream output. Every call sets --max-budget-usd and
 * --max-turns (D-026). `candor run` reports what it reads to candord, which keeps the totals for the
 * whole run.
 */

export interface ClaudeCall {
  cwd: string;
  prompt: string;
  appendSystemPrompt: string;
  model: string;
  settingsFile: string;
  maxBudgetUsd: number;
  maxTurns: number;
  tools: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Set to continue an earlier session. */
  resume?: string;
  /** Set with `resume` to copy the conversation up to one message into a new session (D-021, D-026). The old session is not changed. */
  fork?: { atMessage: string };
  command?: string;
  /** In a container with separate users, the user Claude Code runs as (src/core/run/isolation.ts). */
  user?: { uid: number; gid: number };
}

export interface StreamHandlers {
  onInit(init: { session: string; model: string | null; version: string | null; plugins: unknown[]; tools: string[]; raw: Record<string, unknown> }): void;
  /** `endsCleanly` is false when the message holds a tool call, because a fork there would leave the call without its result. */
  onAssistant(message: { session: string; uuid: string; endsCleanly: boolean }): void;
  onResult(result: { session: string; costUsd: number; turns: number; durationMs: number; isError: boolean; subtype: string; text: string }): void;
}

export interface ClaudeOutcome {
  exitCode: number | null;
  stderr: string;
  sawResult: boolean;
  transcript: string[];
}

/**
 * The worker loads no MCP server and no claude.ai connector. Without --strict-mcp-config, Claude Code gives the
 * worker every MCP server and connector set up on the computer and the account, which can reach systems outside the
 * charter. Candor passes no --mcp-config, so the worker has none. The environment variable turns off claude.ai
 * connectors a second way.
 */
export const NO_CONNECTORS_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } as const;

export function claudeArgs(call: ClaudeCall): string[] {
  return [
    "-p",
    call.prompt,
    "--model",
    call.model,
    "--settings",
    call.settingsFile,
    "--max-turns",
    String(call.maxTurns),
    "--max-budget-usd",
    call.maxBudgetUsd.toFixed(4),
    "--allowedTools",
    call.tools.join(","),
    "--append-system-prompt",
    call.appendSystemPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    ...(call.resume ? ["--resume", call.resume] : []),
    ...(call.resume && call.fork ? ["--fork-session", "--resume-session-at", call.fork.atMessage] : []),
  ];
}

export function runClaude(call: ClaudeCall, handlers: StreamHandlers): Promise<ClaudeOutcome> {
  return new Promise((resolve) => {
    // With separate users, setpriv starts Claude Code as the agent user with all its groups, so it can write the
    // project, which belongs to a group it shares with the worker. Node's own uid option drops those groups.
    const command = call.command ?? "claude";
    const [file, args] = call.user ? ["setpriv", [`--reuid=${call.user.uid}`, `--regid=${call.user.gid}`, "--init-groups", "--", command, ...claudeArgs(call)]] : [command, claudeArgs(call)];
    const child = spawn(file, args, { cwd: call.cwd, env: { ...call.env, ...NO_CONNECTORS_ENV }, stdio: ["ignore", "pipe", "pipe"] });
    const transcript: string[] = [];
    let stderr = "";
    let sawResult = false;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8000) stderr += chunk.toString("utf8");
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      transcript.push(line);
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const session = typeof event.session_id === "string" ? event.session_id : "unknown";
      if (event.type === "system" && event.subtype === "init") {
        handlers.onInit({
          session,
          model: typeof event.model === "string" ? event.model : null,
          version: typeof event.claude_code_version === "string" ? event.claude_code_version : null,
          plugins: Array.isArray(event.plugins) ? event.plugins : [],
          tools: Array.isArray(event.tools) ? event.tools.filter((t): t is string => typeof t === "string") : [],
          raw: event,
        });
      } else if (event.type === "assistant" && typeof event.uuid === "string") {
        const content = (event.message as { content?: unknown } | undefined)?.content;
        const hasToolUse = Array.isArray(content) && content.some((block) => (block as { type?: unknown } | null)?.type === "tool_use");
        handlers.onAssistant({ session, uuid: event.uuid, endsCleanly: !hasToolUse });
      } else if (event.type === "result") {
        sawResult = true;
        handlers.onResult({
          session,
          costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0,
          turns: typeof event.num_turns === "number" ? event.num_turns : 0,
          durationMs: typeof event.duration_ms === "number" ? event.duration_ms : 0,
          isError: event.is_error === true,
          subtype: typeof event.subtype === "string" ? event.subtype : "unknown",
          text: typeof event.result === "string" ? event.result : "",
        });
      }
    });
    child.on("error", (error) => resolve({ exitCode: null, stderr: `${error.message}\n${stderr}`, sawResult, transcript }));
    child.on("close", (code) => resolve({ exitCode: code, stderr, sawResult, transcript }));
  });
}

/**
 * Claude Code keeps a conversation in a folder named after the working directory it ran in, so a fork started
 * from a different folder cannot find it. The restart gives the new worktree its own copy of the old
 * conversation file. The old file stays where it is. Returns what happened, so the ledger can say it.
 */
export function copySessionFile(oldCwd: string, newCwd: string, session: string, env: NodeJS.ProcessEnv = process.env): "copied" | "present" | "missing" {
  if (!/^[0-9a-f-]{8,64}$/i.test(session)) return "missing";
  const base = join(env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude"), "projects");
  const folderFor = (cwd: string): string => join(base, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const real = (cwd: string): string => {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  };
  const target = join(folderFor(real(newCwd)), `${session}.jsonl`);
  if (existsSync(target)) return "present";
  const source = [real(oldCwd), oldCwd].map((cwd) => join(folderFor(cwd), `${session}.jsonl`)).find((file) => existsSync(file));
  if (!source) return "missing";
  mkdirSync(folderFor(real(newCwd)), { recursive: true });
  copyFileSync(source, target);
  const iso = userIsolation(env);
  if (iso) {
    giveToAgent(folderFor(real(newCwd)), iso);
    giveToAgent(target, iso);
  }
  return "copied";
}
