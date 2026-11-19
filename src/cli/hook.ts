import { execFile } from "node:child_process";
import { callDaemon, DaemonUnreachable } from "../daemon/client.js";

export interface HookResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** Longer than the 3 seconds of other calls, because a tool call may wait for an assessment (D-061). Below the 10 second hook timeout. */
const HOOK_CALL_TIMEOUT_MS = 8500;

/** Events where a failure must stop the action. Everything else reports and lets the session continue. */
const BLOCKING = new Set(["PreToolUse", "ConfigChange"]);

function run(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

/** What the session loaded, gathered outside the worker by the hook process. */
async function sessionMeta(): Promise<Record<string, unknown>> {
  const [version, plugins] = await Promise.all([run("claude", ["--version"], 8000), run("claude", ["plugin", "list", "--json"], 8000)]);
  let installed: unknown = null;
  try {
    installed = plugins === null ? null : JSON.parse(plugins);
  } catch {
    installed = null;
  }
  return {
    claude_code_version: version,
    installed_plugins: installed,
    // `claude plugin list` does not show a plugin loaded with --plugin-dir or the built-in mods, so this list is not complete.
    plugin_list_complete: false,
  };
}

/**
 * `candor hook <event>`: reads the hook JSON from Claude Code and forwards it to candord.
 * On PreToolUse and ConfigChange it fails closed: if candord cannot be reached, exit 2.
 */
export async function runHook(event: string, stdin: string, socket: string): Promise<HookResult> {
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    const message = `candor hook ${event}: the hook input was not JSON.`;
    return BLOCKING.has(event) ? { exitCode: 2, stderr: `${message} The action is blocked.` } : { exitCode: 1, stderr: message };
  }

  try {
    const meta = event === "SessionStart" ? await sessionMeta() : {};
    const reply = await callDaemon({ socket, method: "POST", path: "/hook", body: { event, input, meta }, timeoutMs: HOOK_CALL_TIMEOUT_MS });
    if (reply.status !== 200) throw new DaemonUnreachable(socket, `status ${reply.status}`);
    const reason = typeof reply.body.reason === "string" ? reply.body.reason : "Denied by Candor.";

    if (event === "PreToolUse") {
      // Only an explicit allow lets the call through. A reply with no decision blocks it.
      if (reply.body.decision === "allow") return { exitCode: 0 };
      if (reply.body.decision !== "deny") throw new Error("candord gave a reply with no decision.");
      // No output on allow: the normal permission flow still applies. A deny carries its reason to the worker.
      return {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }),
      };
    }
    // A note from the watcher goes to the worker as context after a tool call.
    if ((event === "PostToolUse" || event === "PostToolUseFailure") && typeof reply.body.note === "string") {
      return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: reply.body.note } }) };
    }
    if (event === "ConfigChange") return reply.body.decision === "allow" ? { exitCode: 0 } : { exitCode: 2, stderr: reason };
    return { exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (BLOCKING.has(event)) return { exitCode: 2, stderr: `${message}\nThe action is blocked until candord is running.` };
    return { exitCode: 1, stderr: message };
  }
}
