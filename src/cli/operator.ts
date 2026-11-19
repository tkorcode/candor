import { readFileSync } from "node:fs";
import { operatorKeyPath, socketPath } from "../core/paths.js";
import { callDaemon } from "../daemon/client.js";
import { ensureDaemon } from "./daemonctl.js";
import { waitForDaemon } from "./run.js";

/**
 * Operator actions: approve, continue, pause, checkpoint, rule and restart. Run them outside the worker session.
 * The command reads the operator secret from the Candor home and sends it with the request. A worker
 * session cannot read that file (D-024), so there the command sends no secret, and candord refuses
 * the request and records it as the worker.
 */

export const OPERATOR_USAGE = `  candor approve <held action digest> [--minutes <n>]
                                    Approve one held action, once, for a limited time
  candor continue | pause           Continue or pause the run
  candor checkpoint                 Take a checkpoint now
  candor rule "<text>" [--dimension goal|scope|plan|evidence] [--reason "<text>"] [--continue]
                                    Add a drift rule. This makes a new charter version, and every earlier
                                    checkpoint is scored again with the watcher. --continue also lifts a pause
`;

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function readKey(home: string): string | null {
  try {
    return readFileSync(operatorKeyPath(home), "utf8").trim();
  } catch {
    return null;
  }
}

export async function operatorCommand(home: string, action: string, args: string[]): Promise<number> {
  const body: Record<string, unknown> = {};
  if (action === "approve") {
    const digest = args[0];
    if (!digest || digest.startsWith("--")) {
      process.stderr.write("Usage: candor approve <held action digest> [--minutes <n>]\nList held actions with: candor status\n");
      return 2;
    }
    body.digest = digest;
    const minutes = option(args, "--minutes");
    if (minutes) body.minutes = Number(minutes);
  }
  if (action === "rule") {
    const text = args[0];
    if (!text || text.startsWith("--")) {
      process.stderr.write('Usage: candor rule "<text>" [--dimension goal|scope|plan|evidence] [--reason "<text>"] [--continue]\n');
      return 2;
    }
    body.text = text;
    const dimension = option(args, "--dimension");
    if (dimension) body.dimension = dimension;
    const reason = option(args, "--reason");
    if (reason) body.reason = reason;
    if (args.includes("--continue")) body.continue = true;
  }
  const key = readKey(home);
  // A rule is the one operator action that is also made on a run whose worker has stopped. It starts candord from the ledger if none is running.
  const handle = action === "rule" ? await ensureDaemon(home, option(args, "--run"), waitForDaemon) : null;
  const reply = await callDaemon({
    socket: socketPath(home),
    method: "POST",
    path: `/operator/${action}`,
    body,
    headers: key ? { "x-candor-operator": key } : {},
    timeoutMs: 600000,
  }).finally(() => handle?.stop());
  if (reply.status !== 200) {
    process.stderr.write(`candord refused the action: ${String(reply.body.error ?? reply.status)}\n${key ? "" : "The operator secret could not be read here, so the request was sent without it. Run this command outside the worker session.\n"}`);
    return 1;
  }
  switch (action) {
    case "rule": {
      const scores = (reply.body.scores ?? []) as RescoreRow[];
      process.stdout.write(`Rule ${(reply.body.rule as { id: string }).id} added. The charter is now version ${String(reply.body.version)}.\n`);
      process.stdout.write(scores.length === 0 ? "No earlier checkpoint existed, so nothing was scored again.\n" : `Earlier checkpoints scored again (the first score, the score before this change, and the new score):\n${scores.map(rescoreLine).join("\n")}\n`);
      if (reply.body.paused === true) process.stdout.write("The run is still paused. Choose: candor continue, or candor restart <checkpoint> --reason \"<text>\".\n");
      break;
    }
    case "approve":
      process.stdout.write(`Approved for one use until ${String(reply.body.expires_at)}. The worker must retry that exact action.\n`);
      break;
    case "checkpoint":
      process.stdout.write(`Checkpoint ${String(reply.body.checkpoint)} taken.\n`);
      break;
    case "pause":
      process.stdout.write("The run is paused.\n");
      break;
    default:
      process.stdout.write("The run continues.\n");
  }
  return 0;
}

interface RescoreRow {
  checkpoint: string;
  status: string;
  reason: string | null;
  first: { overall: number | null; level: string | null } | null;
  previous: { overall: number | null; level: string | null } | null;
  overall: number | null;
  level: string | null;
}

const show = (s: { overall: number | null; level: string | null } | null): string => (s && s.overall !== null ? `${s.overall} ${s.level ?? ""}`.trim() : "not scored");

function rescoreLine(r: RescoreRow): string {
  if (r.status !== "scored") return `  ${r.checkpoint}: first ${show(r.first)}, not scored again (${r.reason ?? r.status})`;
  const moved = r.previous && r.previous.overall !== null && r.overall !== null && r.level !== r.previous.level ? `  <- the level changed from ${r.previous.level ?? "none"} to ${r.level ?? "none"}` : "";
  return `  ${r.checkpoint}: first ${show(r.first)}, before this change ${show(r.previous)}, now ${show(r)}${moved}`;
}
