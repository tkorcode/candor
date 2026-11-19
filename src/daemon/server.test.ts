import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "../cli/hook.js";
import { verifyFile } from "../core/ledger/verify.js";
import { ledgerPath, operatorKeyPath, socketPath, statePath } from "../core/paths.js";
import { callDaemon } from "./client.js";
import { seedApprovedRun, testCharter } from "../core/charter/testing.js";
import { FAKE_SECRET } from "../core/ledger/testing.js";
import { type Daemon, type Entry, insideWorkspace, startDaemon } from "./server.js";

describe("candord capture and operator channel", () => {
  let base: string;
  let home: string;
  let work: string;
  let daemon: Daemon;

  const entries = (): Entry[] =>
    readFileSync(ledgerPath(home, "r_test"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Entry);
  const start = () => startDaemon({ home, run: "r_test", workspace: work });
  const hook = (event: string, input: Record<string, unknown>) =>
    runHook(event, JSON.stringify({ session_id: "s1", cwd: work, hook_event_name: event, ...input }), socketPath(home));

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "cd-"));
    home = join(base, "home");
    work = join(base, "work");
    mkdirSync(home);
    mkdirSync(join(work, "reports"), { recursive: true });
    seedApprovedRun(home, "r_test", testCharter({ scope: { allow_paths: ["**"], deny_paths: [], allow_commands: ["*"], network: false } }));
    daemon = await start();
  });

  afterEach(async () => {
    await daemon.close();
    rmSync(base, { recursive: true, force: true });
  });

  it("records intent before a tool call and result after, with the actor set by the daemon", async () => {
    const pre = await hook("PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" }, actor: "operator" });
    const post = await hook("PostToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" }, tool_response: { stdout: "a" } });
    expect(pre).toEqual({ exitCode: 0 });
    expect(post).toEqual({ exitCode: 0 });
    const all = entries();
    const intent = all.find((e) => e.type === "tool_intent");
    const result = all.find((e) => e.type === "tool_result");
    expect(intent).toMatchObject({ type: "tool_intent", actor: "worker", body: { tool: "Bash", tool_use_id: "t1", decision: "allow" } });
    expect(result).toMatchObject({ type: "tool_result", actor: "worker", body: { tool_use_id: "t1", failed: false } });
    expect(result?.seq).toBe((intent?.seq ?? 0) + 1);
  });

  it("fails closed on PreToolUse when candord cannot be reached", async () => {
    await daemon.close();
    const result = await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/candord cannot be reached/);
    expect(result.stderr).toMatch(/candor daemon/);
    daemon = await start();
  });

  it("does not block the session on other events when candord cannot be reached", async () => {
    await daemon.close();
    expect((await hook("PostToolUse", { tool_name: "Bash" })).exitCode).toBe(1);
    daemon = await start();
  });

  it("refuses an operator action without the secret and records the attempt as the worker", async () => {
    const reply = await callDaemon({ socket: daemon.socket, method: "POST", path: "/operator/pause", body: { actor: "operator" } });
    expect(reply.status).toBe(403);
    expect(daemon.state().paused).toBe(false);
    expect(entries().at(-1)).toMatchObject({ type: "human_action", actor: "worker", body: { action: "pause", accepted: false } });
  });

  it("accepts an operator action with the secret, and a paused run denies tool calls with a reason", async () => {
    const key = readFileSync(operatorKeyPath(home), "utf8").trim();
    const reply = await callDaemon({ socket: daemon.socket, method: "POST", path: "/operator/pause", body: {}, headers: { "x-candor-operator": key } });
    expect(reply.status).toBe(200);
    expect(entries().at(-1)).toMatchObject({ type: "human_action", actor: "operator", body: { accepted: true } });

    const denied = await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(denied.exitCode).toBe(0);
    const output = JSON.parse(denied.stdout ?? "{}") as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/paused/);
  });

  it("blocks a settings change and records it", async () => {
    const result = await hook("ConfigChange", { source: "project_settings", file_path: join(work, ".claude/settings.json") });
    expect(result.exitCode).toBe(2);
    expect(entries().at(-1)).toMatchObject({ type: "config_change", body: { source: "project_settings", blocked: true } });
  });

  it("delivers a stage report when a hook picks up a report file, once", async () => {
    writeFileSync(join(work, "reports", "stage-map.json"), '{"done":true,"confidence":0.9}');
    await hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: "reports/stage-map.json" }, tool_response: {} });
    await hook("PostToolUse", { tool_name: "Read", tool_input: {}, tool_response: {} });
    const reports = entries().filter((entry) => entry.type === "stage_report");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ body: { stage: "map", form: "file", accepted: true } });
  });

  it("refuses a report path outside the workspace", async () => {
    writeFileSync(join(base, "outside.md"), "secret");
    symlinkSync(join(base, "outside.md"), join(work, "reports", "stage-profile.json"));
    await hook("PostToolUse", { tool_name: "Read", tool_input: {}, tool_response: {} });
    expect(entries().filter((e) => e.type === "stage_report" && e.body.accepted === true)).toEqual([]);
    expect(insideWorkspace(work, "../outside.md")).toBeNull();
    expect(insideWorkspace(work, operatorKeyPath(home))).toBeNull();
  });

  it("refuses to start when the socket path is too long, and says what to do", async () => {
    const long = join(base, "x".repeat(120));
    mkdirSync(long);
    await expect(startDaemon({ home: long, run: "r_test" })).rejects.toThrow(/Set CANDOR_HOME to a shorter folder/);
  });

  it("starts the ledger with the approved charter, then run_start, and writes a heartbeat", () => {
    const types = entries().map((e) => e.type);
    expect(types.slice(0, 4)).toEqual(["charter_approved", "charter_review", "run_start", "heartbeat"]);
    expect(entries()[2]).toMatchObject({ actor: "candord", body: { workspace: expect.stringContaining("work") } });
  });

  it("blocks a PreToolUse call when the reply has no decision", async () => {
    await daemon.close();
    const impostor = createServer((_req, res) => res.end("{}"));
    await new Promise<void>((resolve) => impostor.listen(socketPath(home), resolve));
    const result = await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    await new Promise<void>((resolve) => impostor.close(() => resolve()));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/no decision/);
    daemon = await start();
  });

  it("does not take over a socket that a live daemon holds", async () => {
    await expect(start()).rejects.toThrow(/already running/);
    expect(daemon.state().entries).toBeGreaterThan(0);
    expect((await hook("PreToolUse", { tool_name: "Read", tool_input: {} })).exitCode).toBe(0);
  });

  it("stays paused after a restart, because the pause is rebuilt from the ledger", async () => {
    const key = readFileSync(operatorKeyPath(home), "utf8").trim();
    await callDaemon({ socket: daemon.socket, method: "POST", path: "/operator/pause", body: {}, headers: { "x-candor-operator": key } });
    await daemon.close();
    daemon = await start();
    expect(daemon.state().paused).toBe(true);
    await callDaemon({ socket: daemon.socket, method: "POST", path: "/operator/continue", body: {}, headers: { "x-candor-operator": key } });
    await daemon.close();
    daemon = await start();
    expect(daemon.state().paused).toBe(false);
  });

  it("answers requests right after repeated restarts on the same socket", async () => {
    for (let i = 0; i < 25; i++) {
      await daemon.close();
      daemon = await start();
      const reply = await callDaemon({ socket: daemon.socket, method: "GET", path: "/state" });
      expect(reply.status).toBe(200);
    }
  });

  it("uses the fixed workspace and ignores a cwd that the caller makes up", async () => {
    mkdirSync(join(base, "reports"), { recursive: true });
    writeFileSync(join(base, "reports", "stage-map.json"), '{"done":true}');
    await hook("PostToolUse", { cwd: base, tool_name: "Read", tool_input: {}, tool_response: {} });
    await hook("PostToolUse", { cwd: "/", tool_name: "Read", tool_input: {}, tool_response: {} });
    expect(entries().filter((entry) => entry.type === "stage_report")).toEqual([]);
  });

  it("records an oversize report once, not on every tool call", async () => {
    writeFileSync(join(work, "reports", "stage-map.json"), "x".repeat(300 * 1024));
    for (let i = 0; i < 4; i++) await hook("PostToolUse", { tool_name: "Read", tool_input: {}, tool_response: {} });
    const refused = entries().filter((entry) => entry.type === "stage_report" && entry.body.accepted === false);
    expect(refused).toHaveLength(1);
  });

  it("does not block on a named pipe in the reports folder", async () => {
    execFileSync("mkfifo", [join(work, "reports", "stage-profile.json")]);
    await hook("PostToolUse", { tool_name: "Read", tool_input: {}, tool_response: {} });
    expect(entries().at(-1)).toMatchObject({ type: "stage_report", body: { stage: "profile", accepted: false } });
  });

  it("records a changed report again with its new digest", async () => {
    writeFileSync(join(work, "reports", "stage-map.json"), '{"done":false,"confidence":0.1}');
    await hook("PostToolUse", { tool_name: "Read", tool_input: {}, tool_response: {} });
    writeFileSync(join(work, "reports", "stage-map.json"), '{"done":false,"confidence":0.2}');
    await hook("PostToolUse", { tool_name: "Read", tool_input: {}, tool_response: {} });
    const digests = entries().filter((entry) => entry.type === "stage_report").map((entry) => entry.body.report_digest);
    expect(digests).toHaveLength(2);
    expect(digests[0]).not.toBe(digests[1]);
  });

  it("keeps the fixed fields of a session start when the caller sends the same names", async () => {
    await runHook("SessionStart", JSON.stringify({ session_id: "real", cwd: work, source: "startup" }), socketPath(home)).catch(() => undefined);
    const reply = await callDaemon({ socket: daemon.socket, method: "POST", path: "/hook", body: { event: "SessionStart", input: { session_id: "real", cwd: work, source: "startup" }, meta: { session: "forged", source: "forged", workspace: "/" } } });
    expect(reply.status).toBe(200);
    expect(entries().at(-1)?.body).toMatchObject({ session: "real", source: "startup", workspace: expect.stringContaining("work") });
  });

  it("publishes state to a file the pane can read", async () => {
    await hook("PreToolUse", { tool_name: "Read", tool_input: {} });
    const state = JSON.parse(readFileSync(statePath(home), "utf8")) as { run: string; entries: number; paused: boolean };
    expect(state).toMatchObject({ run: "r_test", paused: false });
    expect(state.entries).toBeGreaterThan(4);
  });

  it("writes a ledger that verifies, and keeps the operator secret and a pasted key out of it", async () => {
    const key = readFileSync(operatorKeyPath(home), "utf8").trim();
    await hook("PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "echo hi" } });
    await hook("PostToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "echo hi" }, tool_response: { stdout: "hi" } });
    await hook("SessionStart", { source: "startup", model: `key ${key} and ${FAKE_SECRET.anthropic("abcdefghijklmnopqrstuvwxyz")} and jane@example.org` });
    expect(verifyFile(ledgerPath(home, "r_test"))).toMatchObject({ ok: true });
    const text = readFileSync(ledgerPath(home, "r_test"), "utf8");
    expect(text).not.toContain(key);
    expect(text).not.toContain("sk-ant-api03");
    expect(text).not.toContain("jane@example.org");
  });

  it("refuses to start on a ledger that was changed, and says so", async () => {
    await hook("PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } });
    await daemon.close();
    const file = ledgerPath(home, "r_test");
    writeFileSync(file, readFileSync(file, "utf8").replace('"decision":"allow"', '"decision":"deny"'));
    await expect(start()).rejects.toThrow(/does not verify/);
    // The afterEach hook closes the daemon again, so give it one that is running.
    seedApprovedRun(home, "r_other", testCharter());
    daemon = await startDaemon({ home, run: "r_other", workspace: work });
  });
});
