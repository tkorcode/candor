import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "../cli/hook.js";
import { seedApprovedRun, testCharter } from "../core/charter/testing.js";
import { verifyFile } from "../core/ledger/verify.js";
import { anchorPath, ledgerPath, operatorKeyPath, socketPath } from "../core/paths.js";
import type { ApiRequest } from "../watcher/judge.js";
import { seqsIn, stubTransport } from "../watcher/stub.js";
import { callDaemon } from "./client.js";
import { type Daemon, type Entry, startDaemon } from "./server.js";
import type { WatcherConfig } from "./watch.js";

/** The watcher step of a checkpoint, with a stand-in for the model. The real model is tried in the live run. */
describe("the watcher at each checkpoint", () => {
  let base: string;
  let home: string;
  let work: string;
  let daemon: Daemon;
  let calls: ApiRequest[];
  let answer: (request: ApiRequest) => { dimensions: Record<string, number>; findings?: unknown[] };

  const now = () => new Date("2026-11-18T10:00:00.000Z");
  const entries = (): Entry[] =>
    readFileSync(ledgerPath(home, "r_w"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Entry);
  const scores = () => entries().filter((e) => e.type === "drift_score");
  const key = () => readFileSync(operatorKeyPath(home), "utf8").trim();
  const operator = (action: string) => callDaemon({ socket: daemon.socket, method: "POST", path: `/operator/${action}`, body: {}, headers: { "x-candor-operator": key() }, timeoutMs: 60000 });
  const hook = (event: string, input: Record<string, unknown>) => runHook(event, JSON.stringify({ session_id: "s1", cwd: work, hook_event_name: event, ...input }), socketPath(home));
  const pre = async (tool: string, tool_input: Record<string, unknown>, id = `t${Math.random()}`) => {
    const result = await hook("PreToolUse", { tool_name: tool, tool_use_id: id, tool_input });
    const out = result.stdout ? (JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }) : null;
    return { allowed: result.exitCode === 0 && result.stdout === undefined, reason: out?.hookSpecificOutput.permissionDecisionReason ?? result.stderr ?? "" };
  };
  const post = (id: string) => hook("PostToolUse", { tool_name: "Bash", tool_use_id: id, tool_input: { command: "ls reports" }, tool_response: { stdout: "ok" } });
  /** One stage of work, then its report, as a worker would produce them. */
  const finishProfile = async () => {
    await pre("Bash", { command: "ls reports" }, "w1");
    await post("w1");
    writeFileSync(join(work, "reports", "out.txt"), "rows: 3\n");
    writeFileSync(join(work, "reports", "stage-profile.json"), JSON.stringify({ done: true, summary: "Counted 3 rows.", deviations: [], confidence: 0.8 }));
    await post("w2");
    await daemon.idle();
  };
  const config = (over: Partial<WatcherConfig> = {}): WatcherConfig => ({
    model: "claude-opus-5-5",
    transport: stubTransport((request) => {
      calls.push(request);
      return answer(request);
    }),
    callBudgetUsd: 0.2,
    totalBudgetUsd: 0.5,
    waitMs: 3000,
    ...over,
  });
  const start = (watcher?: WatcherConfig) => startDaemon({ home, run: "r_w", workspace: work, now, ...(watcher ? { watcher } : {}) });

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "w-"));
    home = join(base, "h");
    work = join(base, "w");
    mkdirSync(home);
    for (const dir of ["migration", "reports", "data", "tests", "checks"]) mkdirSync(join(work, dir), { recursive: true });
    writeFileSync(join(work, "data", "c.db"), "db");
    seedApprovedRun(home, "r_w", testCharter());
    calls = [];
    answer = () => ({ dimensions: { goal: 0, scope: 0, plan: 0, evidence: 0 } });
    daemon = await start(config());
  });
  afterEach(async () => {
    await daemon.close();
    rmSync(base, { recursive: true, force: true });
  });

  it("scores a stage checkpoint with the actor watcher, cites real entries, and adds the cost to the run budget", async () => {
    answer = (request) => ({
      dimensions: { goal: 0.1, scope: 0.1, plan: 0.1, evidence: 0.1 },
      findings: [{ rule: "goal-1", severity: "low", summary: "Minor.", entries: [seqsIn(request).at(-1)] }],
    });
    const before = daemon.state().budget.spent_usd;
    await finishProfile();
    const [score] = scores();
    expect(score).toMatchObject({ actor: "watcher", body: { status: "scored", checkpoint: "A1", stage: "profile", level: "ok", judge_model: "claude-opus-5-5", rubric_version: 3 } });
    const cited = ((score?.body.findings ?? []) as { entries: number[] }[]).flatMap((f) => f.entries);
    const seqs = new Set(entries().map((e) => e.seq));
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((s) => seqs.has(s))).toBe(true);
    // 1000 input and 200 output tokens of the stand-in, at the price of the model.
    expect(score?.body.usage).toMatchObject({ cost_usd: 0.008, model: "claude-opus-5-5" });
    expect(daemon.state().budget.spent_usd).toBeCloseTo(before + 0.008, 6);
    expect(daemon.state().watcher).toMatchObject({ configured: true, calls: 1, spent_usd: 0.008 });
    // The whole bundle is kept so a later rule change can score it again.
    const stored = score?.body.bundle_json;
    const bundle = typeof stored === "string" ? (JSON.parse(stored) as { evidence: { seq: number }[] }) : null;
    expect(bundle?.evidence.map((e) => e.seq)).toEqual(expect.arrayContaining(cited));
  });

  it("sends the charter rules, the stage, the changes and the stage report as data, with no tools and no reasoning", async () => {
    writeFileSync(join(work, "migration", "note.txt"), "contact jane.doe@example.org about the load\n");
    await finishProfile();
    expect(calls).toHaveLength(1);
    const request = calls[0] as ApiRequest;
    expect(request).not.toHaveProperty("tools");
    const text = request.messages[0]?.content ?? "";
    expect(text).toContain("goal-1 [goal]");
    expect(text).toContain("id: profile");
    expect(text).toContain("reports/out.txt");
    expect(text).toContain("Counted 3 rows.");
    expect(text).toContain("Stages completed before this one: none.");
    // Personal data is redacted before the text leaves the machine.
    expect(text).not.toContain("jane.doe");
    expect(text).toContain("REDACTED:email");
  });

  it("shows a changed text file as its lines and a binary file as its size only", async () => {
    writeFileSync(join(work, "migration", "dedup.js"), "const keep = 'latest';\n");
    writeFileSync(join(work, "migration", "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));
    await finishProfile();
    const text = calls[0]?.messages[0]?.content ?? "";
    expect(text).toContain("+const keep = 'latest';");
    expect(text).toMatch(/added binary file migration\/blob\.bin \(5 bytes\)/);
  });

  it("pauses the run on a pause score, denies tool calls with the reason, and lets the operator continue", async () => {
    answer = (request) => ({
      dimensions: { goal: 0.1, scope: 0.9, plan: 0, evidence: 0 },
      findings: [{ rule: "goal-1", severity: "high", summary: "Rewrote rows that are not duplicates.", entries: [seqsIn(request).at(-1)] }],
    });
    await finishProfile();
    expect(scores()[0]?.body).toMatchObject({ level: "pause", overall: 0.9 });
    expect(daemon.state().paused).toBe(true);
    const denied = await pre("Read", { file_path: "data/c.db" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/watcher paused the run at checkpoint A1.*Rewrote rows/);
    expect((await operator("continue")).status).toBe(200);
    expect((await pre("Read", { file_path: "data/c.db" })).allowed).toBe(true);
    // The pause survives a restart of the daemon until the operator continues. After the continue it does not come back.
    await daemon.close();
    daemon = await start(config());
    expect(daemon.state().paused).toBe(false);
    expect(verifyFile(ledgerPath(home, "r_w"), { anchorsPath: anchorPath(home, "r_w") })).toMatchObject({ ok: true });
  });

  it("keeps a pause across a restart when the operator has not continued", async () => {
    answer = () => ({ dimensions: { goal: 0, scope: 0.8, plan: 0, evidence: 0 } });
    await finishProfile();
    await daemon.close();
    daemon = await start(config());
    expect(daemon.state().paused).toBe(true);
    expect(daemon.state().pause_reason).toMatch(/watcher paused/);
  });

  it("gives the worker a warning once, after a tool call, and records the delivery", async () => {
    answer = (request) => ({
      dimensions: { goal: 0, scope: 0.5, plan: 0, evidence: 0 },
      findings: [{ rule: "goal-1", severity: "medium", summary: "Some extra tidying.", entries: [seqsIn(request).at(-1)] }],
    });
    await finishProfile();
    expect(daemon.state().paused).toBe(false);
    expect((await pre("Read", { file_path: "data/c.db" })).allowed).toBe(true);
    const first = await post("w3");
    const context = (JSON.parse(first.stdout ?? "{}") as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;
    expect(context).toMatch(/watcher warns at checkpoint A1.*Some extra tidying/);
    expect((await post("w4")).stdout).toBeUndefined();
    expect(entries().filter((e) => e.type === "check_result" && e.body.check === "watcher_note")).toHaveLength(1);
  });

  it("records that the watcher failed and lets the job continue", async () => {
    await daemon.close();
    daemon = await start(
      config({
        transport: async () => {
          throw new Error("network down");
        },
      }),
    );
    await finishProfile();
    expect(scores()[0]).toMatchObject({ actor: "watcher", body: { status: "unavailable", reason: "api", level: null, findings: [{ rule: "watcher_unavailable" }] } });
    expect(daemon.state().paused).toBe(false);
    expect((await pre("Read", { file_path: "data/c.db" })).allowed).toBe(true);
  });

  it("records an answer that did not match the schema, with the cost already spent, and lets the job continue", async () => {
    await daemon.close();
    daemon = await start(config({ transport: async () => ({ content: [{ type: "text", text: "not json" }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 50 } }) }));
    await finishProfile();
    expect(scores()[0]?.body).toMatchObject({ status: "unavailable", reason: "invalid_output" });
    expect(((scores()[0]?.body.usage ?? {}) as { cost_usd?: number }).cost_usd).toBeGreaterThan(0);
    expect(daemon.state().paused).toBe(false);
  });

  it("stops at the watcher budget without calling the model", async () => {
    await daemon.close();
    daemon = await start(config({ totalBudgetUsd: 0.01 }));
    await finishProfile();
    expect(calls).toHaveLength(0);
    expect(scores()[0]?.body).toMatchObject({ status: "unavailable", reason: "budget" });
    expect(daemon.state().paused).toBe(false);
  });

  it("stops when the whole watcher budget is spent by earlier calls", async () => {
    await daemon.close();
    // One call costs 0.008. A total of 0.035 leaves 0.027 after one call, which is below the smallest call worth starting.
    daemon = await start(config({ totalBudgetUsd: 0.035 }));
    await finishProfile();
    writeFileSync(join(work, "reports", "stage-map.json"), JSON.stringify({ done: true }));
    await pre("Bash", { command: "ls reports" }, "m1");
    await post("m1");
    await daemon.idle();
    expect(scores().map((s) => s.body.status)).toEqual(["scored", "unavailable"]);
    expect(calls).toHaveLength(1);
  });

  it("says so when no watcher is configured, and does not pause", async () => {
    await daemon.close();
    daemon = await start();
    await finishProfile();
    expect(scores()[0]).toMatchObject({ actor: "watcher", body: { status: "unavailable", reason: "not_configured" } });
    expect(daemon.state().watcher.configured).toBe(false);
  });

  it("does not judge a checkpoint with no new work, and says so", async () => {
    await finishProfile();
    await operator("checkpoint");
    expect(scores().map((s) => s.body.status)).toEqual(["scored", "skipped"]);
    expect(calls).toHaveLength(1);
  });

  it("does not let the stage reports of earlier stages count as work of this one", async () => {
    await finishProfile();
    await pre("Bash", { command: "ls reports" }, "m1");
    await post("m1");
    writeFileSync(join(work, "reports", "stage-map.json"), JSON.stringify({ done: true, summary: "Mapped." }));
    await post("m2");
    await daemon.idle();
    const second = calls[1]?.messages[0]?.content ?? "";
    expect(second).toContain("Stages completed before this one: profile.");
    expect(second).toContain("Counted 3 rows.");
    expect(second).toContain("Mapped.");
  });

  it("records a refusal of the worker to be the operator in the bundle, as a refused action", async () => {
    await callDaemon({ socket: daemon.socket, method: "POST", path: "/operator/approve", body: {} });
    await finishProfile();
    expect(calls[0]?.messages[0]?.content).toContain("approve by worker, refused");
  });

  it("publishes the suggested restart point, and works it out again when a score arrives", async () => {
    expect(daemon.state().suggested_restart.kind).toBe("no_basis");
    answer = () => ({ dimensions: { goal: 0.1, scope: 0.1, plan: 0.1, evidence: 0.1 } });
    await finishProfile();
    expect(daemon.state().suggested_restart.kind).toBe("on_course");
  });

  it("records each checkpoint when it is triggered, and keeps later work out of its evidence, while a slow judgement runs", async () => {
    // A slow score keeps the queue busy, as on a loaded machine. The worker goes on meanwhile.
    await daemon.close();
    const slow: WatcherConfig["transport"] = async (request) => {
      calls.push(request);
      await new Promise((r) => setTimeout(r, 600));
      return stubTransport(() => answer(request))(request);
    };
    daemon = await start(config({ transport: slow, waitMs: 50 }));
    await pre("Bash", { command: "ls reports" }, "w1");
    await post("w1");
    writeFileSync(join(work, "reports", "out.txt"), "rows: 3\n");
    writeFileSync(join(work, "reports", "stage-profile.json"), JSON.stringify({ done: true, summary: "Counted 3 rows.", deviations: [] }));
    await post("w2");
    writeFileSync(join(work, "reports", "stage-map.json"), JSON.stringify({ done: true, summary: "Mapped the columns later.", deviations: [] }));
    await post("w3");
    // The next stage begins before either assessment has returned.
    await pre("Bash", { command: "ls migration/after-the-map-stage" }, "w4");
    await daemon.idle();

    const seqOf = (pred: (e: Entry) => boolean) => entries().find(pred)?.seq ?? -1;
    const a2 = seqOf((e) => e.type === "checkpoint" && e.body.id === "A2");
    const next = seqOf((e) => e.type === "tool_intent" && String(e.body.summary).includes("after-the-map-stage"));
    expect(a2).toBeGreaterThan(0);
    expect(next).toBeGreaterThan(a2);
    const requestFor = (id: string) => calls.find((c) => (c.messages[0]?.content ?? "").includes(`checkpoint: ${id}`))?.messages[0]?.content ?? "";
    expect(requestFor("A1")).not.toBe("");
    expect(requestFor("A2")).not.toBe("");
    // A1 sees neither the report of the next stage nor the action after it. A2 does not see the action after it.
    expect(requestFor("A1")).not.toContain("Mapped the columns later.");
    expect(requestFor("A1")).not.toContain("after-the-map-stage");
    expect(requestFor("A2")).not.toContain("after-the-map-stage");
    // The exit check of the profile stage, written after its checkpoint, is still in the evidence of A1.
    expect(requestFor("A1")).toContain("has-output");
  });
});
