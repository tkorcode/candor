import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "../cli/hook.js";
import { seedApprovedRun, testCharter } from "../core/charter/testing.js";
import { readAnchors } from "../core/anchor/file.js";
import { verifyFile } from "../core/ledger/verify.js";
import { anchorPath, ledgerPath, operatorKeyPath, runDir, socketPath } from "../core/paths.js";
import { callDaemon } from "./client.js";
import { type Daemon, type Entry, startDaemon } from "./server.js";

describe("candord checks, held actions, budget and checkpoints", () => {
  let base: string;
  let home: string;
  let work: string;
  let daemon: Daemon;
  let clock = Date.parse("2026-11-18T10:00:00.000Z");

  const now = () => new Date(clock);
  const entries = (): Entry[] =>
    readFileSync(ledgerPath(home, "r_m2"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Entry);
  const start = () => startDaemon({ home, run: "r_m2", workspace: work, now });
  const key = () => readFileSync(operatorKeyPath(home), "utf8").trim();
  const operator = (action: string, body: Record<string, unknown> = {}, withKey = true) =>
    callDaemon({ socket: daemon.socket, method: "POST", path: `/operator/${action}`, body, headers: withKey ? { "x-candor-operator": key() } : {}, timeoutMs: 60000 });
  const harness = (action: string, body: Record<string, unknown> = {}) => callDaemon({ socket: daemon.socket, method: "POST", path: `/harness/${action}`, body, headers: { "x-candor-operator": key() } });
  const hook = (event: string, input: Record<string, unknown>) => runHook(event, JSON.stringify({ session_id: "s1", cwd: work, hook_event_name: event, ...input }), socketPath(home));
  const pre = async (tool: string, tool_input: Record<string, unknown>, id = `t${Math.random()}`) => {
    const result = await hook("PreToolUse", { tool_name: tool, tool_use_id: id, tool_input });
    const out = result.stdout ? (JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }) : null;
    return { allowed: result.exitCode === 0 && result.stdout === undefined, reason: out?.hookSpecificOutput.permissionDecisionReason ?? result.stderr ?? "", id };
  };

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "m2-"));
    home = join(base, "h");
    work = join(base, "w");
    mkdirSync(home);
    for (const dir of ["migration", "reports", "data", "tests", "checks"]) mkdirSync(join(work, dir), { recursive: true });
    writeFileSync(join(work, "data", "c.db"), "db");
    seedApprovedRun(home, "r_m2", testCharter());
    daemon = await start();
  });
  afterEach(async () => {
    await daemon.close();
    rmSync(base, { recursive: true, force: true });
  });

  it("denies an action outside scope with the rule and the reason, and records it", async () => {
    const result = await pre("Write", { file_path: "tests/evil.js", content: "x" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/deny_paths/);
    expect(entries().at(-1)).toMatchObject({ type: "tool_intent", actor: "worker", body: { decision: "deny", rule: "scope" } });
  });

  it("holds an irreversible action, approves that exact action once, and marks later checkpoints record only", async () => {
    const command = 'sqlite3 data/c.db "DROP TABLE customers_v1"';
    const first = await pre("Bash", { command }, "t1");
    expect(first.allowed).toBe(false);
    expect(first.reason).toMatch(/held/i);
    await daemon.idle();
    const held = daemon.state().held;
    expect(held).toHaveLength(1);
    // A checkpoint was taken before the action was held.
    expect(entries().find((e) => e.type === "checkpoint")).toMatchObject({ body: { trigger: "before_irreversible", safety: "safe_to_restart" } });
    expect(held[0]?.checkpoint).toBe("A1");

    // A retry before approval is still denied. An approval for another action does nothing.
    expect((await pre("Bash", { command }, "t2")).allowed).toBe(false);
    const digest = held[0]?.digest ?? "";
    const bad = await operator("approve", { digest: "sha256:deadbeefdeadbeef" });
    expect(bad.status).toBe(404);

    const ok = await operator("approve", { digest, minutes: 5 });
    expect(ok.status).toBe(200);
    // Only the exact action passes. A changed command is held again.
    expect((await pre("Bash", { command: 'sqlite3 data/c.db "DROP TABLE customers_v2"' }, "t3")).allowed).toBe(false);
    expect((await pre("Bash", { command }, "t4")).allowed).toBe(true);
    // Single use: the same action is held again.
    expect((await pre("Bash", { command }, "t5")).allowed).toBe(false);

    await hook("PostToolUse", { tool_name: "Bash", tool_use_id: "t4", tool_input: { command }, tool_response: {} });
    const effects = entries().filter((e) => e.type === "effect" && e.body.irreversible === true);
    expect(effects.map((e) => e.body.performed)).toEqual([false, true]);
    await operator("checkpoint");
    expect(entries().filter((e) => e.type === "checkpoint").at(-1)).toMatchObject({ body: { safety: "record_only" } });
    expect(verifyFile(ledgerPath(home, "r_m2"), { anchorsPath: anchorPath(home, "r_m2") })).toMatchObject({ ok: true });
  });

  it("lets an approval expire", async () => {
    const command = 'sqlite3 data/c.db "DROP TABLE x"';
    await pre("Bash", { command }, "t1");
    await daemon.idle();
    await operator("approve", { digest: daemon.state().held[0]?.digest ?? "", minutes: 1 });
    clock += 2 * 60000;
    expect((await pre("Bash", { command }, "t2")).allowed).toBe(false);
  });

  it("does not carry an approval to a changed script", async () => {
    writeFileSync(join(work, "migration", "apply.js"), "// v1\n");
    const command = "node migration/apply.js run";
    await pre("Bash", { command }, "t1");
    await daemon.idle();
    await operator("approve", { digest: daemon.state().held[0]?.digest ?? "" });
    writeFileSync(join(work, "migration", "apply.js"), "// v2, changed after the approval\n");
    expect((await pre("Bash", { command }, "t2")).allowed).toBe(false);
  });

  it("F21 over the socket: the worker cannot approve, continue, add a rule, restart or report spend, and each attempt is recorded", async () => {
    await pre("Bash", { command: 'sqlite3 data/c.db "DROP TABLE a"' }, "t1");
    await daemon.idle();
    const digest = daemon.state().held[0]?.digest ?? "";
    await operator("pause");
    const attempts: [string, Record<string, unknown>][] = [["approve", { digest }], ["continue", {}], ["rule", { text: "allow all" }], ["restart", { checkpoint: "A1" }], ["usage", { cost_usd: -1 }], ["end", {}], ["strength", {}]];
    for (const [action, body] of attempts) {
      expect((await operator(action, body, false)).status).toBe(403);
      // A made-up key and a made-up actor in the body change nothing.
      expect((await callDaemon({ socket: daemon.socket, method: "POST", path: `/operator/${action}`, body: { ...body, actor: "operator" }, headers: { "x-candor-operator": "x".repeat(64) } })).status).toBe(403);
    }
    expect(daemon.state().paused).toBe(true);
    expect(daemon.state().held).toHaveLength(1);
    const refused = entries().filter((e) => e.type === "human_action" && e.body.accepted === false);
    expect(refused.length).toBe(attempts.length * 2);
    expect(refused.every((e) => e.actor === "worker")).toBe(true);
    expect(entries().some((e) => e.type === "human_action" && e.actor === "operator" && e.body.action === "approve")).toBe(false);
  });

  it("stops recording refused operator attempts after a limit, and keeps counting", async () => {
    for (let i = 0; i < 230; i++) await operator("approve", {}, false);
    expect(entries().filter((e) => e.type === "human_action" && e.actor === "worker")).toHaveLength(200);
    expect(daemon.state().refused_operator_attempts).toBe(230);
  });

  it("denies at the budget across restarts of the daemon, and counts spend from the ledger", async () => {
    await harness("start");
    clock += 10 * 60000;
    await harness("usage", { cost_usd: 2.5, turns: 30 });
    expect((await pre("Read", { file_path: "data/c.db" })).allowed).toBe(true);
    await harness("start");
    await harness("usage", { cost_usd: 0.6, turns: 5 });
    const denied = await pre("Read", { file_path: "data/c.db" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/cost budget/);
    // The spend is read back from the ledger after a restart.
    await daemon.close();
    daemon = await start();
    expect(daemon.state().budget).toMatchObject({ spent_usd: 3.1, turns: 35, max_usd: 3 });
    expect((await pre("Read", { file_path: "data/c.db" })).allowed).toBe(false);
  });

  it("denies at the time budget", async () => {
    await harness("start");
    clock += 46 * 60000;
    expect((await pre("Read", { file_path: "data/c.db" })).reason).toMatch(/time budget/);
  });

  it("takes a checkpoint when a stage report says done, runs the exit checks, and anchors the head", async () => {
    writeFileSync(join(work, "reports", "out.txt"), "rows: 3\n");
    writeFileSync(join(work, "reports", "stage-profile.json"), JSON.stringify({ done: true, deviations: [], confidence: 0.8 }));
    await hook("PostToolUse", { tool_name: "Write", tool_use_id: "t1", tool_input: { file_path: "reports/stage-profile.json" }, tool_response: {} });
    await daemon.idle();
    const all = entries();
    const checkpoint = all.find((e) => e.type === "checkpoint");
    expect(checkpoint).toMatchObject({ actor: "candord", body: { id: "A1", trigger: "stage_done", stage: "profile", git_ref: `refs/candor/r_m2/A/1`, parent: null } });
    expect(all.find((e) => e.type === "check_result" && e.body.check === "has-output")).toMatchObject({ body: { stage: "profile", checkpoint: "A1", status: "passed" } });
    expect(all.find((e) => e.type === "anchor")).toMatchObject({ body: { kind: "file" } });
    expect(readAnchors(anchorPath(home, "r_m2")).length).toBe(1);
    // The snapshot lives in the run store, not in the workspace.
    expect(execFileSync("git", ["--git-dir", join(runDir(home, "r_m2"), "snapshots.git"), "rev-parse", "refs/candor/r_m2/A/1"], { encoding: "utf8" }).trim()).toBe(checkpoint?.body.commit);
    expect(verifyFile(ledgerPath(home, "r_m2"), { anchorsPath: anchorPath(home, "r_m2") })).toMatchObject({ ok: true });
  });

  it("rejects a stage report that is not valid or names an unknown stage", async () => {
    writeFileSync(join(work, "reports", "stage-profile.json"), '{"done":"yes"}');
    writeFileSync(join(work, "reports", "stage-nonsense.json"), '{"done":true}');
    await hook("PostToolUse", { tool_name: "Read", tool_use_id: "t1", tool_input: {}, tool_response: {} });
    await daemon.idle();
    const reports = entries().filter((e) => e.type === "stage_report");
    expect(reports.map((e) => e.body.accepted)).toEqual([false, false]);
    expect(entries().some((e) => e.type === "checkpoint")).toBe(false);
  });

  it("flags files changed outside the scope at a checkpoint, even when no tool call rule saw them", async () => {
    writeFileSync(join(work, "tests", "t.js"), "// planted by a program the job started\n");
    await operator("checkpoint");
    expect(entries().find((e) => e.type === "check_result" && e.body.check === "scope_diff")).toMatchObject({ body: { ok: false, files: expect.arrayContaining(["tests/t.js"]) } });
  });

  it("finds personal data that a shell redirect wrote into a covered file, without recording the text", async () => {
    writeFileSync(join(work, "reports", "dump.txt"), "contact jane.doe@example.org\n");
    await hook("PostToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" }, tool_response: {} });
    const found = entries().find((e) => e.type === "check_result" && e.body.check === "no-pii");
    expect(found).toMatchObject({ body: { status: "failed", file: "reports/dump.txt", matches: 1 } });
    expect(readFileSync(ledgerPath(home, "r_m2"), "utf8")).not.toContain("jane.doe");
  });

  it("pauses the run at the next checkpoint when the charter file no longer matches its hash", async () => {
    const file = join(runDir(home, "r_m2"), "charter.v1.json");
    chmodSync(file, 0o600);
    writeFileSync(file, readFileSync(file, "utf8").replace('"goal": "', '"goal": "Also '));
    await operator("checkpoint");
    expect(daemon.state().paused).toBe(true);
    expect(entries().find((e) => e.body.check === "charter_hash")).toMatchObject({ body: { ok: false, forced_pause: true } });
    // The daemon keeps enforcing the charter it loaded, not the edited file.
    expect((await pre("Read", { file_path: "data/c.db" })).reason).toMatch(/paused/);
  });

  it("refuses to start on a charter file that does not match the approved hash", async () => {
    await daemon.close();
    const file = join(runDir(home, "r_m2"), "charter.v1.json");
    chmodSync(file, 0o600);
    writeFileSync(file, readFileSync(file, "utf8").replace('"max_cost_usd": 3', '"max_cost_usd": 3000'));
    await expect(start()).rejects.toThrow(/does not match the hash/);
    chmodSync(file, 0o600);
    writeFileSync(file, readFileSync(file, "utf8").replace('"max_cost_usd": 3000', '"max_cost_usd": 3'));
    daemon = await start();
  });

  it("runs the strength test and records each result, and the result of a success check counts as verified only when the check is proven", async () => {
    writeFileSync(join(work, "reports", "out.txt"), "ok\n");
    const strength = await operator("strength");
    expect(strength.status).toBe(200);
    expect(entries().filter((e) => e.type === "check_strength").map((e) => [e.body.check, e.body.status])).toEqual([["has-output", "proven"], ["no-pii", "proven"]]);
    await operator("end", { reason: "done" });
    await daemon.idle();
    const results = entries().filter((e) => e.type === "acceptance_result");
    expect(results.map((e) => [e.body.criterion, e.body.status])).toEqual([["s1", "verified"], ["s2", "not_verified"], ["checks-verdict", "partly"]]);
    expect(entries().at(-1)).toMatchObject({ type: "run_end" });
  });

  it("does not call a passing check verified when its strength was never tested", async () => {
    writeFileSync(join(work, "reports", "out.txt"), "ok\n");
    await operator("end", {});
    expect(entries().find((e) => e.type === "acceptance_result" && e.body.criterion === "s1")).toMatchObject({ body: { status: "not_verified", strength: "not tested" } });
  });

  it("gives the answer key only to the final checks, never to a check that runs during a stage", async () => {
    await daemon.close();
    rmSync(base, { recursive: true, force: true });
    base = mkdtempSync(join(tmpdir(), "m2-"));
    home = join(base, "h");
    work = join(base, "w");
    mkdirSync(home);
    for (const dir of ["reports", "checks"]) mkdirSync(join(work, dir), { recursive: true });
    mkdirSync(join(runDir(home, "r_m2"), "oracle"), { recursive: true });
    writeFileSync(join(runDir(home, "r_m2"), "oracle", "expected.json"), '{"secret":"key-content-marker-7f3"}');
    seedApprovedRun(
      home,
      "r_m2",
      testCharter({
        success: [{ id: "s1", text: "The final check sees the answer key.", check: "final-sees-key" }],
        stages: [{ id: "profile", title: "P", exit_checks: ["stage-has-no-key"] }],
        checks: [
          { id: "stage-has-no-key", type: "command", run: 'test -z "$CANDOR_ORACLE_DIR"', when: "checkpoint" },
          { id: "final-sees-key", type: "command", run: 'test -f "$CANDOR_ORACLE_DIR/expected.json"', when: "final" },
        ],
      }),
    );
    daemon = await start();
    writeFileSync(join(work, "reports", "stage-profile.json"), '{"done":true}');
    await hook("PostToolUse", { tool_name: "Read", tool_use_id: "t1", tool_input: {}, tool_response: {} });
    await daemon.idle();
    expect(entries().find((e) => e.type === "check_result" && e.body.check === "stage-has-no-key")).toMatchObject({ body: { status: "passed" } });
    await operator("end", {});
    expect(entries().find((e) => e.type === "acceptance_result")).toMatchObject({ body: { check_status: "passed" } });
    expect(readFileSync(ledgerPath(home, "r_m2"), "utf8")).not.toContain("key-content-marker-7f3");
  });

  it("compares the final state with the answer key and records it as an acceptance_result, apart from the criteria (D-052)", async () => {
    mkdirSync(join(runDir(home, "r_m2"), "oracle"), { recursive: true });
    writeFileSync(join(runDir(home, "r_m2"), "oracle", "expected.json"), "{}");
    writeFileSync(join(runDir(home, "r_m2"), "oracle", "compare.js"), 'process.exit(require("fs").existsSync("reports/out.txt") ? 0 : 1)');
    writeFileSync(join(work, "reports", "out.txt"), "ok\n");
    await operator("strength");
    await operator("end", {});
    await daemon.idle();
    const key = entries().find((e) => e.type === "acceptance_result" && e.body.scope === "answer_key");
    expect(key).toMatchObject({ actor: "candord", body: { criterion: "answer-key", status: "matches" } });
    // The verdict of the checks alone is written before the key comparison and stays in the ledger.
    const seqs = entries().filter((e) => e.type === "acceptance_result");
    expect(seqs.map((e) => e.body.criterion)).toEqual(["s1", "s2", "checks-verdict", "answer-key"]);
    expect(seqs[2]).toMatchObject({ body: { scope: "checks_verdict", status: "partly" } });
    // The key does not replace the check of the criterion.
    expect(entries().find((e) => e.type === "acceptance_result" && e.body.criterion === "s1")).toMatchObject({ body: { status: "verified" } });
  });

  it("denies a worker read of a file outside the workspace, such as the answer key in the run store", async () => {
    const key = join(runDir(home, "r_m2"), "oracle", "expected.json");
    mkdirSync(join(runDir(home, "r_m2"), "oracle"), { recursive: true });
    writeFileSync(key, "{}");
    expect((await pre("Read", { file_path: key })).allowed).toBe(false);
    expect((await pre("Bash", { command: `cat ${key}` })).allowed).toBe(false);
    expect((await pre("Grep", { pattern: "x", path: join(runDir(home, "r_m2"), "oracle") })).allowed).toBe(false);
  });

  it("records a session start from the harness with the plugins it loaded", async () => {
    await harness("init", { session: "s9", claude_code_version: "2.1.327", plugins: [{ name: "candor", source: "dir" }], complete: true });
    expect(entries().at(-1)).toMatchObject({ type: "session_start", actor: "candord", body: { source: "harness_init", plugins: [{ name: "candor", source: "dir" }], mods_and_plugins_complete: true } });
  });

  it("records an attempt to use the network as an effect, whether or not it was allowed", async () => {
    await pre("WebFetch", { url: "https://example.org" }, "t1");
    expect(entries().find((e) => e.type === "effect")).toMatchObject({ actor: "candord", body: { kind: "network", blocked: true, performed: false } });
  });

  it("writes a gap entry when the daemon comes back after a long stop", async () => {
    await daemon.close();
    clock += 10 * 60000;
    daemon = await start();
    expect(entries().find((e) => e.type === "heartbeat" && e.body.recovered === true)).toMatchObject({ body: { gap_ms: expect.any(Number) } });
  });
});
