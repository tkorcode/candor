import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { candorHome, socketPath } from "../core/paths.js";
import { verifyCommand, writeReceipt } from "../core/report/receipt.js";
import { checkClaudeCodeVersion, installedClaudeCodeVersion, MIN_CLAUDE_CODE_VERSION } from "../core/version.js";
import { callDaemon } from "../daemon/client.js";
import { type DaemonState, startDaemon } from "../daemon/server.js";
import { watcherFromEnv } from "../daemon/watch.js";
import { CHARTER_USAGE, runCharter } from "./charter.js";
import { runHook } from "./hook.js";
import { OPERATOR_USAGE, operatorCommand } from "./operator.js";
import { RESTART_USAGE, restartCommand } from "./restart.js";
import { RUN_USAGE, runCommand } from "./run.js";
import { runVerify } from "./verify.js";

const USAGE = `candor: commands

${CHARTER_USAGE}${RUN_USAGE}${OPERATOR_USAGE}${RESTART_USAGE}  candor receipt <run id> [--out <dir>] [--label live|scripted]
                                    Write the signed receipt (receipt.json and receipt.html)
  candor status [--json]            Show the run: held actions, budget, checkpoints
  candor verify <receipt.json | run id | ledger file> [--anchors <file>] [--ledger <file>]
                                    Check a receipt (signature, chain, anchors), or a ledger
  candor hook <event>               Called by Claude Code hooks. Reads hook JSON on stdin
  candor doctor                     Check the Claude Code version
  candord --run <id> --workspace <dir>
                                    The daemon. candor run starts it for you
`;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export async function main(args: string[]): Promise<number> {
  const home = candorHome();
  const socket = socketPath(home);
  const [command, ...rest] = args;

  try {
    switch (command) {
      case "charter":
        return runCharter(home, rest);
      case "verify":
        return runVerify(home, rest);
      case "hook": {
        const event = rest[0];
        if (!event) {
          process.stderr.write("candor hook needs an event name, such as PreToolUse.\n");
          return 2;
        }
        const result = await runHook(event, await readStdin(), socket);
        if (result.stdout) process.stdout.write(`${result.stdout}\n`);
        if (result.stderr) process.stderr.write(`${result.stderr}\n`);
        return result.exitCode;
      }
      case "daemon": {
        const run = option(rest, "--run");
        if (!run) throw new Error("candord needs --run <run id>. Approve a charter first: candor charter approve <file>");
        try {
          // The daemon reads its own settings from .env in the folder it was started in. The worker does not get them.
          process.loadEnvFile(".env");
        } catch {
          // No .env file. The environment may hold the values.
        }
        const watcher = watcherFromEnv(process.env) ?? undefined;
        const daemon = await startDaemon({ home, run, workspace: option(rest, "--workspace"), ...(watcher ? { watcher } : {}) });
        process.stdout.write(watcher ? `The watcher is on: ${watcher.model}, up to ${watcher.totalBudgetUsd} dollars for the run.\n` : "The watcher is off: no ANTHROPIC_API_KEY, so checkpoints are recorded as not scored.\n");
        process.stdout.write(`candord is listening at ${daemon.socket} for run ${run}\n`);
        const stop = (): void => {
          void daemon.close().then(() => process.exit(0));
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        await new Promise(() => {});
        return 0;
      }
      case "run":
        try {
          // The worker needs ANTHROPIC_API_KEY, and the model names come from the same file. A value already set in the shell wins.
          process.loadEnvFile(".env");
        } catch {
          // No .env file. The environment may hold the values.
        }
        return runCommand(home, rest);
      case "approve":
      case "continue":
      case "pause":
      case "checkpoint":
      case "rule":
        return operatorCommand(home, command, rest);
      case "restart":
        try {
          // The worker of the new branch needs ANTHROPIC_API_KEY, like the first one. A value already set in the shell wins.
          process.loadEnvFile(".env");
        } catch {
          // No .env file. The environment may hold the values.
        }
        return restartCommand(home, rest);
      case "receipt": {
        const run = rest[0];
        if (!run || run.startsWith("--")) {
          process.stderr.write("Usage: candor receipt <run id> [--out <dir>] [--label live|scripted]\n");
          return 2;
        }
        const label = option(rest, "--label");
        if (label !== undefined && label !== "live" && label !== "scripted") throw new Error("--label must be live or scripted. A recorded run is labelled one or the other.");
        const out = option(rest, "--out") ?? join(home, "runs", run, "receipt");
        const { json, html, receipt } = writeReceipt(home, run, out, { label });
        process.stdout.write(`Stayed on course: ${receipt.verdicts.stayed_on_course.verdict}. Result verified: ${receipt.verdicts.result_verified.verdict}.\n${receipt.findings.length} finding${receipt.findings.length === 1 ? "" : "s"}.\nWrote ${json}\nWrote ${html}\nThe receipt is signed. Key id ${receipt.integrity.key_id}\nTo check it, run in ${dirname(json)}:\n  ${verifyCommand(receipt)}\nGive the key id to the reviewer by another route than the folder.\n`);
        return 0;
      }
      case "status": {
        const reply = await callDaemon({ socket, method: "GET", path: "/state" });
        if (rest.includes("--json")) {
          process.stdout.write(`${JSON.stringify(reply.body)}\n`);
          return 0;
        }
        const s = reply.body as unknown as DaemonState;
        process.stdout.write(`run ${s.run}: ${s.entries} entries, ${s.paused ? `PAUSED (${s.pause_reason ?? "no reason recorded"})` : "not paused"}, last event ${s.last_event ?? "none"}\n`);
        process.stdout.write(`budget: ${s.budget.spent_usd} of ${s.budget.max_usd} dollars, ${s.budget.turns} of ${s.budget.max_turns} turns, ${s.budget.minutes} of ${s.budget.max_minutes} minutes\n`);
        process.stdout.write(`branch ${s.branch}, charter version ${s.charter_version}${s.branches.length > 0 ? `, restarts: ${s.branches.map((b) => `${b.id} from ${b.from} (${b.reason})`).join("; ")}` : ""}\n`);
        process.stdout.write(`checkpoints: ${s.checkpoints.map((c) => `${c.id} (${c.trigger}, ${c.safety})`).join(", ") || "none"}\n`);
        const r = s.suggested_restart;
        if (r) process.stdout.write(`restart point: ${r.kind === "suggested" ? `${r.checkpoint}. ${r.text} To restart: candor restart ${r.checkpoint} --reason "<what went wrong>"` : r.text}\n`);
        process.stdout.write(`watcher: ${s.watcher.configured ? `${s.watcher.model}, ${s.watcher.calls} scored, ${s.watcher.spent_usd} of ${s.watcher.budget_usd} dollars` : "off"}\n`);
        for (const d of s.drift.slice(-5)) process.stdout.write(`  ${d.checkpoint}: ${d.status === "scored" ? `${d.level} (${d.overall})${d.summary ? ` ${d.summary}` : ""}` : `${d.status}${d.summary ? `, ${d.summary}` : ""}`}\n`);
        for (const h of s.held) process.stdout.write(`HELD ${h.digest.slice(7, 19)}  ${h.summary}\n      approve with: candor approve ${h.digest.slice(7, 19)}\n`);
        if (s.refused_operator_attempts > 0) process.stdout.write(`${s.refused_operator_attempts} operator request${s.refused_operator_attempts === 1 ? "" : "s"} arrived without the secret and were refused\n`);
        return 0;
      }
      case "doctor": {
        const check = checkClaudeCodeVersion(installedClaudeCodeVersion());
        process.stdout.write(check.ok ? `Claude Code v${check.version} meets the minimum v${MIN_CLAUDE_CODE_VERSION}.\n` : `${check.message}\n`);
        // The demo project and its checks use the sqlite3 program.
        const sqlite = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
        const sqliteOk = sqlite.status === 0;
        process.stdout.write(sqliteOk ? `sqlite3 ${sqlite.stdout.trim().split(" ")[0]} is installed.\n` : "sqlite3 was not found. The demo project needs it. Install it (for example: apt-get install sqlite3, or brew install sqlite), then try again.\n");
        return check.ok && sqliteOk ? 0 : 1;
      }
      default:
        process.stdout.write(USAGE);
        return command === undefined || command === "help" || command === "--help" ? 0 : 2;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    // A daemon that failed to start must not stay alive.
    if (command === "daemon") process.exit(1);
    return 1;
  }
}
