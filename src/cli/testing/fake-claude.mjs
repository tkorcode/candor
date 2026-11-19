#!/usr/bin/env node
// A stand-in for the claude command, for tests of `candor run`. It prints a version, and in -p mode it
// plays a short scripted worker: it reads the hook commands from the settings file it was given and runs
// them the way Claude Code would, with hook JSON on stdin. Nothing here calls a model.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(process.env.FAKE_CLAUDE_VERSION ?? "2.1.327 (Claude Code)");
  process.exit(0);
}
const flag = (name) => args[args.indexOf(name) + 1];
const settings = JSON.parse(readFileSync(flag("--settings"), "utf8"));
const log = (record) => process.env.FAKE_CLAUDE_LOG && appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(record)}\n`);
// Like Claude Code, a conversation is kept in a folder named after the working directory, and --resume looks only there.
const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const sessionFile = (id) => join(projects, realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
const resume = args.includes("--resume") ? flag("--resume") : null;
const forking = args.includes("--fork-session");
log({ argv: args.map((a) => (a.length > 120 ? `${a.slice(0, 120)}...` : a)), cwd: process.cwd() });
if (resume && !existsSync(sessionFile(resume))) {
  console.error(`No conversation found with session ID: ${resume}`);
  process.exit(1);
}
// A fork gets its own session. A plain resume keeps the one it was given.
const session = resume && !forking ? resume : randomUUID();
mkdirSync(join(sessionFile(session), ".."), { recursive: true });
if (!existsSync(sessionFile(session))) writeFileSync(sessionFile(session), `${JSON.stringify({ type: "user", session })}\n`);
const out = (event) => console.log(JSON.stringify({ session_id: session, ...event }));
const runHook = (event, input) => {
  const spec = settings.hooks[event][0].hooks[0];
  const result = spawnSync(spec.command, spec.args, { input: JSON.stringify({ session_id: session, cwd: process.cwd(), hook_event_name: event, ...input }), encoding: "utf8" });
  return result;
};
// A message that says something and holds no tool call is a clean place to fork. A message with a tool call is not.
const say = () => {
  const uuid = randomUUID();
  out({ type: "assistant", uuid, message: { content: [{ type: "text", text: "Working on it." }] } });
  log({ clean_message: uuid });
};
const tool = (name, input, effect) => {
  const id = randomUUID();
  out({ type: "assistant", uuid: randomUUID(), message: { content: [{ type: "tool_use", id, name }] } });
  const pre = runHook("PreToolUse", { tool_name: name, tool_use_id: id, tool_input: input });
  const denied = pre.status !== 0 || (pre.stdout ?? "").includes('"deny"');
  if (!denied) {
    effect?.();
    runHook("PostToolUse", { tool_name: name, tool_use_id: id, tool_input: input, tool_response: { ok: true } });
  }
  return denied;
};

out({ type: "system", subtype: "init", model: "fake-model", claude_code_version: "2.1.327", plugins: [{ name: "fake", source: "test" }], tools: ["Bash", "Write"] });
runHook("SessionStart", { source: "startup", model: "fake-model" });
say();
tool("Bash", { command: "sqlite3 data/customers.db 'select count(*) from customers_v1'" });
say();
tool("Write", { file_path: "reports/profile.json", content: '{"row_count": 58}' }, () => writeFileSync("reports/profile.json", '{"row_count": 58}'));
tool("Write", { file_path: "reports/stage-profile.json", content: "" }, () => writeFileSync("reports/stage-profile.json", JSON.stringify({ done: true, deviations: [], confidence: 0.9 })));
const outside = tool("Write", { file_path: "tests/smoke.js", content: "// changed" });
const held = tool("Bash", { command: "sqlite3 data/customers.db 'DROP TABLE customers_v1'" });
runHook("Stop", {});
runHook("SessionEnd", {});
out({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1234, num_turns: 4, duration_ms: 1000, result: `outside denied: ${outside}, held: ${held}` });
