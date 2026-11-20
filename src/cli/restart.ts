import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApprovedCharter } from "../core/charter/run.js";
import { Ledger } from "../core/ledger/ledger.js";
import { ledgerPath, operatorKeyPath, runDir, socketPath } from "../core/paths.js";
import { FORK_CANNOT, FORK_KEEPS } from "../core/restart-text.js";
import { copySessionFile } from "../core/run/claude.js";
import { userIsolation } from "../core/run/isolation.js";
import { buildWorkerSettings } from "../core/run/settings.js";
import { checkClaudeCodeVersion, installedClaudeCodeVersion } from "../core/version.js";
import { callDaemon } from "../daemon/client.js";
import { ensureDaemon } from "./daemonctl.js";
import { driveWorker, seededInstruction, shareSettings, toldRules, waitForDaemon, workerPrompt } from "./run.js";

export const RESTART_USAGE = `  candor restart <checkpoint> --reason "<text>" [--run <id>] [--dimension goal|scope|plan|evidence]
                                    [--model <id>] [--max-usd <n>] [--wait-approval <minutes>] [--no-worker]
                                    Fork the run from a safe checkpoint into a new branch and a new worktree.
                                    The reason becomes a drift rule and an instruction on the new branch
`;

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface RestartReply {
  branch: string;
  from: string;
  from_branch: string;
  workspace: string;
  session: string | null;
  message_uuid: string | null;
  conversation: "fork" | "fresh";
  charter_version: number;
  rule: { id: string; text: string };
  instruction: string;
}

/**
 * `candor restart` (R7). The daemon does the part that must be recorded: it checks that the checkpoint is
 * safe to restart from, builds the worktree from the snapshot, installs the reason as a rule, and moves the
 * run to the new branch. This command then starts the worker in the worktree with the old conversation
 * forked at the message of the checkpoint, under the same run budget.
 */
export async function restartCommand(home: string, args: string[]): Promise<number> {
  const checkpoint = args[0];
  const reason = option(args, "--reason");
  if (!checkpoint || checkpoint.startsWith("--") || !reason) {
    process.stderr.write(`Usage:\n${RESTART_USAGE}`);
    return 2;
  }
  const socket = socketPath(home);
  const bin = join(root, "bin", "candor.js");
  const withWorker = !args.includes("--no-worker");
  if (withWorker) {
    const version = checkClaudeCodeVersion(installedClaudeCodeVersion());
    if (!version.ok) {
      process.stderr.write(`${version.message}\n`);
      return 1;
    }
  }
  if (!existsSync(join(root, "dist", "cli", "main.js"))) throw new Error("Candor is not built. Run: npm run build");

  const handle = await ensureDaemon(home, option(args, "--run"), waitForDaemon);
  const run = handle.run;
  try {
    const key = readFileSync(operatorKeyPath(home), "utf8").trim();
    const call = (path: string, body: Record<string, unknown> = {}) => callDaemon({ socket, method: "POST", path, body, headers: { "x-candor-operator": key }, timeoutMs: 300000 });

    const before = (await callDaemon({ socket, method: "GET", path: "/state" })).body as { workspace?: string };
    const reply = await call("/operator/restart", { checkpoint, reason, ...(option(args, "--dimension") ? { dimension: option(args, "--dimension") } : {}) });
    if (reply.status !== 200) {
      process.stderr.write(`candord refused the restart: ${String(reply.body.error ?? reply.status)}\n`);
      return 1;
    }
    const r = reply.body as unknown as RestartReply;
    process.stdout.write(
      `Branch ${r.branch} started from checkpoint ${r.from} (branch ${r.from_branch}).\n  Worktree:        ${r.workspace}\n  Charter version: ${r.charter_version}, with the new rule ${r.rule.id}: ${r.rule.text}\n  Conversation:    ${r.conversation === "fork" ? `fork of session ${String(r.session)} at message ${String(r.message_uuid)}` : "no message was recorded at that checkpoint, so the worker starts a new conversation"}\n  Branch ${r.from_branch} is unchanged. Approvals of the old branch do not apply here. Spend counts against the same run budget.\nA restart is a fork, not a replay.\n  It keeps:\n${FORK_KEEPS.map((k) => `    - ${k}`).join("\n")}\n  It cannot:\n${FORK_CANNOT.map((k) => `    - ${k}`).join("\n")}\n`,
    );
    if (!withWorker) return 0;

    const { charter } = loadApprovedCharter(runDir(home, run), Ledger.open({ path: ledgerPath(home, run), run }).entries());
    const oracleDir = join(runDir(home, run), "oracle");
    const settingsFile = join(runDir(home, run), "worker-settings.json");
    mkdirSync(runDir(home, run), { recursive: true });
    // The settings are written again, so a worker on the new branch has the same limits as the first one.
    writeFileSync(settingsFile, JSON.stringify(buildWorkerSettings({ home, candorBin: bin, weakNestedSandbox: process.env.CANDOR_SANDBOX_WEAK_NESTED === "1", protectedReads: existsSync(oracleDir) ? [oracleDir] : [], usersIsolation: userIsolation() !== null }), null, 2), { mode: 0o600 });
    chmodSync(settingsFile, 0o600);
    const workerSettings = shareSettings(settingsFile);

    const model = option(args, "--model") ?? process.env.CANDOR_WORKER_MODEL ?? "claude-sonnet-5-5";
    const rules = toldRules(charter);
    const common = {
      home,
      run,
      socket,
      bin,
      key,
      cwd: realpathSync(r.workspace),
      systemPrompt: workerPrompt({ goal: charter.goal, stages: charter.stages, allowPaths: charter.scope.allow_paths, allowCommands: charter.scope.allow_commands, network: charter.scope.network, rules }) + seededInstruction(),
      model,
      settingsFile: workerSettings,
      maxUsd: Number(option(args, "--max-usd") ?? Number.POSITIVE_INFINITY),
      waitMinutes: Number(option(args, "--wait-approval") ?? 0),
      call,
    };

    let conversation: "fork" | "fresh" = r.conversation;
    let result: Awaited<ReturnType<typeof driveWorker>>;
    if (r.conversation === "fork" && r.session && r.message_uuid) {
      const copied = before.workspace ? copySessionFile(before.workspace, r.workspace, r.session) : "missing";
      if (copied === "missing") {
        conversation = "fresh";
        await call("/harness/fork-result", { ok: false, conversation: "fresh", from_session: r.session, reason: "The conversation file of the old session was not found, so it could not be copied to the new worktree. The worker starts a new conversation." });
        process.stdout.write("The old conversation file was not found. The worker starts a new conversation with the instruction only.\n");
        result = await driveWorker({ ...common, prompt: r.instruction });
      } else {
        result = await driveWorker({ ...common, prompt: r.instruction, resume: { session: r.session, atMessage: r.message_uuid } });
        const forked = result.session !== null && result.session !== r.session;
        if (result.lastOutcome !== null) await call("/harness/fork-result", { ok: result.spent && forked, conversation: result.spent && forked ? "fork" : "fresh", from_session: r.session, new_session: result.session, reason: result.spent && forked ? "The conversation was forked at the message of the checkpoint." : `The forked call gave no result. ${(result.lastOutcome?.stderr ?? "").slice(0, 300)}` });
        if (!result.spent && result.lastOutcome !== null) {
          // The fork failed before any work. Say so, and start a new conversation under what is left of the budget.
          conversation = "fresh";
          process.stdout.write("The forked conversation did not start. The worker starts a new conversation with the instruction only.\n");
          result = await driveWorker({ ...common, prompt: r.instruction });
        }
      }
    } else {
      result = await driveWorker({ ...common, prompt: r.instruction });
    }
    if (!result.spent) process.stderr.write(`The worker produced no result. ${(result.lastOutcome?.stderr ?? "").slice(0, 500)}\n`);
    await call("/harness/end", { reason: result.spent ? `worker finished on branch ${r.branch} (${conversation} conversation)` : "worker did not run" });
    process.stdout.write(`Branch ${r.branch} ended. Next: candor receipt ${run}\n`);
    return result.spent ? 0 : 1;
  } finally {
    await handle.stop();
  }
}
