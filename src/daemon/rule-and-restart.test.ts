import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "../cli/hook.js";
import { seedApprovedRun, testCharter } from "../core/charter/testing.js";
import { verifyFile } from "../core/ledger/verify.js";
import { anchorPath, ledgerPath, operatorKeyPath, runDir, socketPath } from "../core/paths.js";
import type { ApiRequest } from "../watcher/judge.js";
import { seqsIn, stubTransport } from "../watcher/stub.js";
import { callDaemon } from "./client.js";
import { type Daemon, type Entry, startDaemon } from "./server.js";
import type { WatcherConfig } from "./watch.js";

/** A rule change, re-scoring from stored evidence, and a restart as a fork. The model is a stand-in. */
describe("rule change, re-scoring and restart", () => {
  let base: string;
  let home: string;
  let work: string;
  let daemon: Daemon;
  let calls: ApiRequest[];

  const now = () => new Date("2026-11-18T10:00:00.000Z");
  const entries = (): Entry[] =>
    readFileSync(ledgerPath(home, "r_m"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Entry);
  const ofType = (type: string) => entries().filter((e) => e.type === type);
  const key = () => readFileSync(operatorKeyPath(home), "utf8").trim();
  const send = (path: string, body: Record<string, unknown> = {}, withKey = true) =>
    callDaemon({ socket: daemon.socket, method: "POST", path, body, headers: withKey ? { "x-candor-operator": key() } : {}, timeoutMs: 60000 });
  const operator = (action: string, body: Record<string, unknown> = {}, withKey = true) => send(`/operator/${action}`, body, withKey);
  let cwd: string;
  const hook = (event: string, input: Record<string, unknown>) => runHook(event, JSON.stringify({ session_id: "s1", cwd, hook_event_name: event, ...input }), socketPath(home));
  const pre = async (tool: string, tool_input: Record<string, unknown>, id = `t${Math.random()}`) => {
    const result = await hook("PreToolUse", { tool_name: tool, tool_use_id: id, tool_input });
    return { allowed: result.exitCode === 0 && result.stdout === undefined };
  };
  const post = (id: string, tool = "Bash", input: Record<string, unknown> = { command: "ls reports" }) => hook("PostToolUse", { tool_name: tool, tool_use_id: id, tool_input: input, tool_response: { stdout: "ok" } });
  /** The stage as a worker would finish it: some work, the files, and the report. */
  const finishStage = async (stage: string, files: Record<string, string>, dir = work) => {
    await pre("Bash", { command: "ls reports" }, `${stage}-1`);
    await post(`${stage}-1`);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    writeFileSync(join(dir, "reports", `stage-${stage}.json`), JSON.stringify({ done: true, summary: `Did ${stage}.`, deviations: [], confidence: 0.8 }));
    await post(`${stage}-2`);
    await daemon.idle();
  };
  /** Before rule op-1 every stage looks fine. Under op-1 a stage that changed repair.js is far off scope. */
  const answer = (request: ApiRequest) => {
    calls.push(request);
    const text = request.messages[0]?.content ?? "";
    const strict = text.includes("op-1 [scope]");
    const off = strict && text.includes("migration/repair.js");
    return {
      dimensions: { goal: 0.05, scope: off ? 0.8 : 0.1, plan: 0.05, evidence: 0.05 },
      findings: off ? [{ rule: "op-1", severity: "high", summary: "Edited a file that repairs records.", entries: [seqsIn(request).at(-1)] }] : [],
    };
  };
  const config = (over: Partial<WatcherConfig> = {}): WatcherConfig => ({ model: "claude-opus-5-5", transport: stubTransport(answer), callBudgetUsd: 0.2, totalBudgetUsd: 0.5, waitMs: 3000, ...over });
  const start = (watcher?: WatcherConfig) => startDaemon({ home, run: "r_m", workspace: work, now, ...(watcher ? { watcher } : {}) });

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "m4-"));
    home = join(base, "h");
    work = join(base, "w");
    cwd = work;
    mkdirSync(home);
    for (const dir of ["migration", "reports", "data", "tests", "checks"]) mkdirSync(join(work, dir), { recursive: true });
    writeFileSync(join(work, "data", "c.db"), "db");
    seedApprovedRun(home, "r_m", testCharter());
    calls = [];
    daemon = await start(config());
  });
  afterEach(async () => {
    await daemon.close();
    rmSync(base, { recursive: true, force: true });
  });

  /** Two finished stages and a recorded message, as the harness would report it. */
  const twoStages = async () => {
    await send("/harness/message", { session: "s1", message_uuid: "11111111-1111-4111-8111-111111111111" });
    await finishStage("profile", { "migration/repair.js": "// repairs records\n" });
    await send("/harness/message", { session: "s1", message_uuid: "22222222-2222-4222-8222-222222222222" });
    await finishStage("map", { "migration/later.js": "// later\n" });
  };

  describe("candor rule", () => {
    it("writes a rule_change entry and a new charter version, and scores every earlier checkpoint again from stored evidence", async () => {
      await twoStages();
      expect(ofType("drift_score").map((e) => e.body.level)).toEqual(["ok", "ok"]);
      const firstCalls = calls.length;
      const res = await operator("rule", { text: "Do not change records that are not duplicates.", dimension: "scope", reason: "Stage three repaired records outside its scope." });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ version: 2, rescore: { rescored: 2, not_rescored: 0, unavailable: 0 } });

      const change = ofType("rule_change");
      expect(change).toHaveLength(1);
      expect(change[0]).toMatchObject({ actor: "operator", body: { author: "operator", source: "operator", reason: "Stage three repaired records outside its scope.", from_version: 1, version: 2, rule: { id: "op-1", dimension: "scope" } } });
      const file = JSON.parse(readFileSync(join(runDir(home, "r_m"), "charter.v2.json"), "utf8")) as { version: number; drift_rules: { id: string; source: string }[] };
      expect(file.version).toBe(2);
      expect(file.drift_rules.map((r) => r.id)).toEqual(["goal-1", "op-1"]);
      expect(existsSync(join(runDir(home, "r_m"), "charter.v1.json"))).toBe(true);

      // The first scores are still there and unchanged. The re-scores are new entries by the watcher, after the rule change.
      const scores = ofType("drift_score");
      expect(scores.map((e) => e.body.level)).toEqual(["ok", "ok"]);
      const re = ofType("rescore");
      expect(re.map((e) => e.actor)).toEqual(["watcher", "watcher"]);
      expect(re.every((e) => e.seq > (change[0]?.seq ?? 0))).toBe(true);
      expect(re.map((e) => [e.body.checkpoint, e.body.level, e.body.charter_version])).toEqual([["A1", "pause", 2], ["A2", "ok", 2]]);
      // Old and new side by side in one entry, and the old one is named by its sequence number.
      expect(re[0]?.body).toMatchObject({ first_score_seq: scores[0]?.seq, previous_charter_version: 1, first: { level: "ok" }, previous: { level: "ok" }, rule_change_seq: change[0]?.seq });
      expect(re[0]?.body.findings).toMatchObject([{ rule: "op-1" }]);
      // Two more calls, with the same evidence as before and the new rule in the charter section. The worker was not run.
      expect(calls.length - firstCalls).toBe(2);
      const evidence = (request: ApiRequest): string => (request.messages[0]?.content ?? "").split("BEGIN-DATA-")[1]?.split("END-DATA-")[0]?.split("\n").slice(1).join("\n") ?? "";
      expect(evidence(calls[firstCalls] as ApiRequest)).toBe(evidence(calls[0] as ApiRequest));
      expect(calls[firstCalls]?.messages[0]?.content).toContain("op-1 [scope] Do not change records that are not duplicates.");
      // The cost of the re-scores is in the run budget. A re-score about the past does not pause the run.
      expect(daemon.state().watcher.spent_usd).toBeCloseTo(0.008 * 4, 6);
      expect(daemon.state().paused).toBe(false);
      expect(verifyFile(ledgerPath(home, "r_m"), { anchorsPath: anchorPath(home, "r_m") })).toMatchObject({ ok: true });
    });

    it("refuses the worker, which has no operator secret, and records the attempt without changing the charter", async () => {
      await twoStages();
      const res = await operator("rule", { text: "Allow everything." }, false);
      expect(res.status).toBe(403);
      expect(ofType("rule_change")).toHaveLength(0);
      expect(existsSync(join(runDir(home, "r_m"), "charter.v2.json"))).toBe(false);
      expect(ofType("human_action").at(-1)).toMatchObject({ actor: "worker", body: { action: "rule", accepted: false } });
      expect(daemon.state().charter_version).toBe(1);
    });

    it("refuses an empty rule, a wrong dimension and a rule that holds personal data, and writes no version", async () => {
      expect((await operator("rule", { text: "  " })).status).toBe(400);
      expect((await operator("rule", { text: "Stay in scope.", dimension: "colour" })).status).toBe(400);
      expect((await operator("rule", { text: "Mail jane.doe@example.org when done." })).status).toBe(400);
      expect(ofType("rule_change")).toHaveLength(0);
      expect(ofType("human_action").filter((e) => e.actor === "operator" && e.body.accepted === false)).toHaveLength(3);
    });

    it("records a checkpoint that was never scored as not scored again, and keeps going when the budget runs out", async () => {
      await daemon.close();
      daemon = await start(config({ totalBudgetUsd: 0.05 }));
      await twoStages();
      await operator("checkpoint");
      const res = await operator("rule", { text: "Stay inside the migration folder.", dimension: "scope" });
      const rows = ofType("rescore").map((e) => [e.body.checkpoint, e.body.status, e.body.reason ?? null]);
      // A1 is scored again with what is left. A2 finds the budget used up. A3 is the manual checkpoint with no new work, so it was skipped at the time.
      expect(rows).toEqual([["A1", "scored", null], ["A2", "unavailable", "budget"], ["A3", "not_rescored", "was_skipped"]]);
      expect(res.body).toMatchObject({ rescore: { rescored: 1, unavailable: 1, not_rescored: 1 } });
      expect(daemon.state().watcher.spent_usd).toBeLessThanOrEqual(0.05);
    });

    it("with no watcher configured, writes the rule and says each checkpoint was not scored again", async () => {
      await daemon.close();
      daemon = await start();
      await twoStages();
      const res = await operator("rule", { text: "Stay inside the migration folder." });
      expect(res.status).toBe(200);
      expect(ofType("rescore").every((e) => e.body.status !== "scored")).toBe(true);
      expect(ofType("rule_change")).toHaveLength(1);
    });

    it("keeps a pause unless the operator asks for --continue, and the new version survives a restart of the daemon", async () => {
      await twoStages();
      await operator("pause");
      expect((await operator("rule", { text: "Stay inside the migration folder." })).body.paused).toBe(true);
      expect(daemon.state().paused).toBe(true);
      expect((await operator("rule", { text: "Do not touch the staging table.", continue: true })).body.paused).toBe(false);
      await daemon.close();
      daemon = await start(config());
      expect(daemon.state().charter_version).toBe(3);
      expect(daemon.state().paused).toBe(false);
    });
  });

  describe("candor restart", () => {
    const restart = (checkpoint: string, reason = "Stage three repaired records that are not duplicates.", withKey = true) => operator("restart", { checkpoint, reason }, withKey);
    const worktree = () => join(dirname(realpathSync(work)), `${basename(work)}.r_m.B`);

    it("forks a new branch with a worktree built from the snapshot, installs the reason as a rule, and leaves the old branch alone", async () => {
      await twoStages();
      expect(readFileSync(join(work, "migration", "later.js"), "utf8")).toContain("later");
      const spentBefore = daemon.state().budget.spent_usd;
      const res = await restart("A1");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ branch: "B", from: "A1", from_branch: "A", conversation: "fork", session: "s1", message_uuid: "11111111-1111-4111-8111-111111111111", charter_version: 2, rule: { id: "restart-1" } });
      expect(String(res.body.instruction)).toContain("Stage three repaired records that are not duplicates.");

      // The worktree holds the files of A1 and none of the later ones. Branch A has what it had.
      expect(res.body.workspace).toBe(worktree());
      expect(existsSync(join(worktree(), "migration", "repair.js"))).toBe(true);
      expect(existsSync(join(worktree(), "migration", "later.js"))).toBe(false);
      expect(existsSync(join(worktree(), "reports"))).toBe(true);
      expect(readFileSync(join(work, "migration", "later.js"), "utf8")).toContain("later");

      // The reason is a drift rule of version 2, in the charter file and in the ledger, and nothing else about the charter changed.
      const file = JSON.parse(readFileSync(join(runDir(home, "r_m"), "charter.v2.json"), "utf8")) as { drift_rules: { id: string; source: string; text: string }[] };
      expect(file.drift_rules.at(-1)).toMatchObject({ id: "restart-1", source: "restart", text: "Restart from A1: Stage three repaired records that are not duplicates." });
      expect(ofType("rule_change")[0]).toMatchObject({ actor: "operator", branch: "B", body: { source: "restart", restart_from: "A1", version: 2 } });
      expect(ofType("restart")[0]).toMatchObject({ actor: "operator", branch: "B", body: { from: "A1", from_branch: "A", to_branch: "B", reason: "Stage three repaired records that are not duplicates.", conversation: "fork", tree_matches_checkpoint: true, workspace: worktree() } });
      // A re-score is not run for a restart rule: the old branch was scored under the rules in force then.
      expect(ofType("rescore")).toHaveLength(0);

      // The first checkpoint of the branch is the fork point. It is not scored, and it names its parent on the other branch.
      const fork = ofType("checkpoint").find((e) => e.body.id === "B1");
      expect(fork).toMatchObject({ branch: "B", body: { parent: "A1", trigger: "restart", safety: "safe_to_restart", restart_of: "A1" } });
      expect(ofType("drift_score").some((e) => e.body.checkpoint === "B1")).toBe(false);
      expect(daemon.state()).toMatchObject({ branch: "B", charter_version: 2, workspace: worktree(), paused: false });
      expect(daemon.state().branches).toMatchObject([{ id: "B", from: "A1", reason: "Stage three repaired records that are not duplicates." }]);
      // Spend is the same run budget. Nothing was reset.
      expect(daemon.state().budget.spent_usd).toBeGreaterThanOrEqual(spentBefore);
      expect(verifyFile(ledgerPath(home, "r_m"), { anchorsPath: anchorPath(home, "r_m") })).toMatchObject({ ok: true });
    });

    it("works on the new branch: its tool calls are checked in the worktree, its checkpoints are B2 and on, and the watcher sees the restart rule", async () => {
      await twoStages();
      await restart("A1");
      cwd = worktree();
      expect((await pre("Write", { file_path: join(worktree(), "migration", "new.js"), content: "x" })).allowed).toBe(true);
      // The old workspace is outside the workspace of the run now.
      expect((await pre("Write", { file_path: join(work, "migration", "new.js"), content: "x" })).allowed).toBe(false);
      await finishStage("map", { "migration/new.js": "// fresh\n" }, worktree());
      const b2 = ofType("checkpoint").find((e) => e.body.id === "B2");
      expect(b2).toMatchObject({ branch: "B", body: { parent: "B1", trigger: "stage_done", charter_version: 2 } });
      // Only what changed on the new branch is in its checkpoint, and the watcher scored it under version 2.
      expect(b2?.body.changed_paths).toEqual(expect.arrayContaining(["migration/new.js"]));
      expect(b2?.body.changed_paths).not.toContain("migration/repair.js");
      const score = ofType("drift_score").find((e) => e.body.checkpoint === "B2");
      expect(score).toMatchObject({ branch: "B", body: { status: "scored", charter_version: 2 } });
      expect(calls.at(-1)?.messages[0]?.content).toContain("restart-1 [goal] Restart from A1: Stage three repaired records that are not duplicates.");
      // The evidence of the new branch does not hold work of the old one that happened after the fork point.
      expect(calls.at(-1)?.messages[0]?.content).not.toContain("later.js");
    });

    it("does not carry approvals over: a held action approved on branch A is held again on branch B", async () => {
      await twoStages();
      const command = 'sqlite3 data/c.db "DROP TABLE customers_v1"';
      expect((await pre("Bash", { command }, "h1")).allowed).toBe(false);
      const held = daemon.state().held[0];
      expect((await operator("approve", { digest: held?.digest, minutes: 30 })).status).toBe(200);
      expect(daemon.state().held[0]?.approved).toBe(true);
      await restart("A1");
      // Nothing of branch A is held on B, and the approval does not apply there.
      expect(daemon.state().held).toHaveLength(0);
      cwd = worktree();
      expect((await pre("Bash", { command }, "h2")).allowed).toBe(false);
      expect(daemon.state().held[0]).toMatchObject({ approved: false });
      const intents = ofType("tool_intent").filter((e) => e.body.action_digest === held?.digest);
      expect(intents.map((e) => [e.branch, e.body.decision])).toEqual([["A", "hold"], ["B", "hold"]]);
      // The old branch stays intact: the approval on A is still a record, and no effect was recorded for it.
      expect(ofType("effect").filter((e) => e.body.irreversible === true)).toHaveLength(0);
    });

    it("refuses a checkpoint that is record only, one that does not exist, an empty reason, and the worker, and records each", async () => {
      await twoStages();
      const command = 'sqlite3 data/c.db "DROP TABLE customers_v1"';
      await pre("Bash", { command }, "h1");
      await operator("approve", { digest: daemon.state().held[0]?.digest });
      expect((await pre("Bash", { command }, "h1")).allowed).toBe(true);
      await post("h1", "Bash", { command });
      await operator("checkpoint");
      const recordOnly = daemon.state().checkpoints.at(-1);
      expect(recordOnly?.safety).toBe("record_only");
      const refused = await restart(recordOnly?.id ?? "");
      expect(refused.status).toBe(409);
      expect(String(refused.body.error)).toMatch(/record_only.*irreversible/);
      expect((await restart("Z9")).status).toBe(404);
      expect((await restart("A1", "   ")).status).toBe(400);
      expect((await restart("A1", "Stage three went wrong.", false)).status).toBe(403);
      expect(ofType("restart")).toHaveLength(0);
      expect(daemon.state().branch).toBe("A");
      expect(existsSync(worktree())).toBe(false);
      expect(ofType("human_action").filter((e) => e.body.action === "restart").map((e) => [e.actor, e.body.accepted])).toEqual([["operator", false], ["operator", false], ["operator", false], ["worker", false]]);
    });

    it("clears a pause, keeps the branch and the worktree across a restart of the daemon, and can fork again from the new branch", async () => {
      await twoStages();
      await operator("pause");
      expect(daemon.state().paused).toBe(true);
      await restart("A1");
      expect(daemon.state().paused).toBe(false);
      await daemon.close();
      daemon = await startDaemon({ home, run: "r_m", workspace: work, now, watcher: config() });
      expect(daemon.state()).toMatchObject({ branch: "B", charter_version: 2, workspace: worktree() });
      cwd = worktree();
      const again = await restart("B1", "The second try also went wrong.");
      expect(again.body).toMatchObject({ branch: "C", from: "B1", from_branch: "B", charter_version: 3 });
      expect(existsSync(join(dirname(realpathSync(work)), `${basename(work)}.r_m.C`, "migration", "repair.js"))).toBe(true);
    });

    it("starts a fresh conversation, and says so, when the checkpoint has no message to fork at", async () => {
      await finishStage("profile", { "migration/repair.js": "// repairs records\n" });
      const res = await restart("A1");
      expect(res.body).toMatchObject({ conversation: "fresh", message_uuid: null });
      expect(ofType("restart")[0]?.body).toMatchObject({ conversation: "fresh" });
    });
  });
});
