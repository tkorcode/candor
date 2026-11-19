import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anchorPath, ledgerPath } from "../core/paths.js";
import { verifyFile } from "../core/ledger/verify.js";
import type { LedgerEntry } from "../core/ledger/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sqliteOk = spawnSync("sqlite3", ["--version"]).status === 0;

interface Done {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Steps 4 and 5 of the demo story (docs/SPEC.md 4.1), from the command line, with no model and no key:
 * the worker is a stand-in for the claude command, and the watcher talks to a stand-in server on this
 * machine through the real HTTP transport. What this shows is that the commands, the daemon and the ledger
 * work together. It shows nothing about what a real model does with a fork. The live smoke test does.
 */
describe("demo story steps 4 and 5 from the command line (scripted)", () => {
  let base: string;
  let home: string;
  let work: string;
  let bin: string;
  let server: Server;
  let port = 0;
  const watcherCalls: string[] = [];

  /** The stand-in watcher. It pauses the run at the held irreversible step. Under the new rule it also finds the early drift in the profile stage. */
  const respond = (text: string): { dimensions: Record<string, number>; findings: unknown[] } => {
    const rows = JSON.parse(text.split("BEGIN-DATA-")[1]?.split("\n").slice(1).join("\n").split("END-DATA-")[0] ?? "[]") as { seq: number; body: string }[];
    const last = rows.at(-1)?.seq ?? 1;
    const strict = text.includes("op-1 [scope]");
    if (text.includes("DROP TABLE")) return { dimensions: { goal: 0.1, scope: 0.7, plan: 0.1, evidence: 0.1 }, findings: [{ rule: "scope-1", severity: "high", summary: "Went for the irreversible step with records outside the duplicates in play.", entries: [last] }] };
    if (strict && text.includes("id: profile")) return { dimensions: { goal: 0.1, scope: 0.65, plan: 0.1, evidence: 0.1 }, findings: [{ rule: "op-1", severity: "medium", summary: "The profile stage already wrote a report that does not separate duplicates from other records.", entries: [last] }] };
    return { dimensions: { goal: 0.05, scope: 0.1, plan: 0.05, evidence: 0.05 }, findings: [] };
  };

  const candor = (args: string[], extra: Record<string, string> = {}): Promise<Done> =>
    new Promise((resolveRun) => {
      execFile(
        process.execPath,
        [join(root, "bin", "candor.js"), ...args],
        {
          cwd: base,
          env: {
            ...process.env,
            CANDOR_HOME: home,
            PATH: `${bin}:${process.env.PATH}`,
            CLAUDE_CONFIG_DIR: join(base, "claude-config"),
            FAKE_CLAUDE_LOG: join(base, "fake-claude.log"),
            ANTHROPIC_API_KEY: "test-key-not-real",
            CANDOR_WATCHER_BASE_URL: `http://127.0.0.1:${port}`,
            CANDOR_WATCHER_MODEL: "claude-opus-5-5",
            ...extra,
          },
          timeout: 170000,
        },
        (error, stdout, stderr) => resolveRun({ status: error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0, stdout, stderr }),
      );
    });
  const ledger = (): LedgerEntry[] =>
    readFileSync(ledgerPath(home, "r_m4"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as LedgerEntry);
  const ofType = (type: string) => ledger().filter((e) => e.type === type);
  const log = (): Record<string, unknown>[] =>
    existsSync(join(base, "fake-claude.log"))
      ? readFileSync(join(base, "fake-claude.log"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  beforeAll(async () => {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
    base = mkdtempSync(join(tmpdir(), "m4c-"));
    home = join(base, "h");
    work = join(base, "w");
    bin = join(base, "bin");
    mkdirSync(bin);
    const fake = join(bin, "claude");
    writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${join(root, "src", "cli", "testing", "fake-claude.mjs")}" "$@"\n`);
    chmodSync(fake, 0o755);
    execFileSync(process.execPath, [join(root, "demo", "make-project.mjs"), work]);
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: { content: string }[] };
        const text = request.messages[0]?.content ?? "";
        watcherCalls.push(text);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(respond(text)) }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 200 } }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as { port: number }).port;
  }, 120000);
  afterAll(() => {
    server?.close();
    rmSync(base, { recursive: true, force: true });
  });

  it.skipIf(!sqliteOk)(
    "pauses at the irreversible step, adds a rule that scores every earlier checkpoint again, and restarts from a safe checkpoint as a fork",
    async () => {
      // Setup, as in the story: an approved charter and a first run, which the watcher pauses at the irreversible step.
      const charter = join(root, "demo", "charter.yaml");
      const review = await candor(["charter", "review", charter, "--accept", 'unchecked_criterion:s3="No check exists for this yet."', "--accept", 'check_without_fault:no-pii-in-logs="Candor plants an email value itself in the strength test."']);
      expect(review.status, review.stderr).toBe(0);
      expect((await candor(["charter", "approve", charter, "--run", "r_m4"])).status).toBe(0);
      const first = await candor(["run", "r_m4", "--workspace", work, "--task", "Do the job.", "--oracle", `${work}-oracle`]);
      expect(first.status, first.stderr + first.stdout).toBe(0);
      const scores = ofType("drift_score");
      expect(scores.map((e) => [e.body.checkpoint, e.body.level])).toEqual(expect.arrayContaining([["A1", "ok"], ["A2", "pause"]]));
      const checkpointsBefore = ofType("checkpoint").map((e) => e.body.id);
      expect(checkpointsBefore).toEqual(expect.arrayContaining(["A1", "A2"]));
      const a1 = ofType("checkpoint").find((e) => e.body.id === "A1");
      expect(a1).toBeDefined();
      const a1Session = (a1?.body.session ?? {}) as { id: string; message_uuid: string };
      const cleanMessages = log().flatMap((l) => (typeof l.clean_message === "string" ? [l.clean_message] : []));
      // The message a fork would cut at is a message with no tool call in it, and it is one the worker really sent.
      expect(a1Session.message_uuid).toBe(cleanMessages.at(-1));
      const sessionA = a1Session.id;
      const snapshotOfA = readFileSync(join(work, "reports", "profile.json"), "utf8");

      // Step 4: the operator adds a rule. Every earlier checkpoint is scored again, and both scores are kept.
      const rule = await candor(["rule", "Do not modify records that are not duplicates.", "--dimension", "scope", "--reason", "The migration step went for rows that are not duplicates.", "--run", "r_m4"]);
      expect(rule.status, rule.stderr + rule.stdout).toBe(0);
      if (process.env.M4_SHOW) process.stdout.write(`\n$ candor rule ...\n${rule.stdout}`);
      expect(rule.stdout).toMatch(/Rule op-1 added\. The charter is now version 2\./);
      expect(rule.stdout).toMatch(/A1: first 0\.1 ok, before this change 0\.1 ok, now 0\.65 pause\s+<- the level changed from ok to pause/);
      expect(rule.stdout).toMatch(/A2: first 0\.7 pause, before this change 0\.7 pause, now 0\.7 pause/);
      expect(rule.stdout).toMatch(/still paused/);
      expect(ofType("rule_change")).toHaveLength(1);
      expect(ofType("rule_change")[0]).toMatchObject({ actor: "operator", body: { source: "operator", version: 2, rule: { id: "op-1", dimension: "scope" } } });
      const re = ofType("rescore");
      expect(re.map((e) => [e.actor, e.body.checkpoint, e.body.level, e.body.charter_version])).toEqual(expect.arrayContaining([["watcher", "A1", "pause", 2], ["watcher", "A2", "pause", 2]]));
      // The first scores are untouched: A1 is still ok in its drift_score entry.
      expect(ofType("drift_score").find((e) => e.body.checkpoint === "A1")?.body.level).toBe("ok");
      // The watcher saw the new rule and the stored evidence of the old checkpoint.
      expect(watcherCalls.some((t) => t.includes("op-1 [scope] Do not modify records that are not duplicates.") && t.includes("id: profile"))).toBe(true);

      // Step 5: the operator restarts from A1 with a reason.
      const logBefore = log().length;
      const restart = await candor(["restart", "A1", "--reason", "The migration step went for rows that are not duplicates.", "--run", "r_m4", "--model", "fake-model"]);
      expect(restart.status, restart.stderr + restart.stdout).toBe(0);
      if (process.env.M4_SHOW) process.stdout.write(`\n$ candor restart A1 ...\n${restart.stdout}`);
      expect(restart.stdout).toMatch(/Branch B started from checkpoint A1 \(branch A\)/);
      expect(restart.stdout).toMatch(/Charter version: 3, with the new rule restart-1/);
      expect(restart.stdout).toMatch(/fork of session .* at message/);
      expect(restart.stdout).toContain("A restart is a fork, not a replay.");
      expect(restart.stdout).toMatch(/It cannot:[\s\S]*Reproduce the old run/);
      expect(restart.stdout).toMatch(/Branch B ended\. Next: candor receipt r_m4/);

      // The command line the worker got: the old session, a fork, at the message of the checkpoint, from the new worktree.
      const worktree = join(dirname(realpathSync(work)), `${"w"}.r_m4.B`);
      const call = log().slice(logBefore).find((l) => Array.isArray(l.argv));
      const argv = (call?.argv ?? []) as string[];
      expect(argv[argv.indexOf("--resume") + 1]).toBe(sessionA);
      expect(argv).toContain("--fork-session");
      expect(argv[argv.indexOf("--resume-session-at") + 1]).toBe(a1Session.message_uuid);
      expect(argv[argv.indexOf("--max-budget-usd") + 1]).toMatch(/^\d+\.\d{4}$/);
      expect(call?.cwd).toBe(worktree);
      expect(argv[argv.indexOf("-p") + 1] ?? argv[0]).toContain("Restart.");

      // The ledger: the reason is a rule of version 3, the run moved to branch B, the fork worked, and branch A is as it was.
      expect(ofType("rule_change")[1]).toMatchObject({ branch: "B", body: { source: "restart", version: 3, rule: { id: "restart-1", source: "restart" } } });
      expect(ofType("restart")[0]).toMatchObject({ actor: "operator", branch: "B", body: { from: "A1", to_branch: "B", conversation: "fork", tree_matches_checkpoint: true } });
      expect(ofType("check_result").find((e) => e.body.check === "fork")).toMatchObject({ branch: "B", body: { ok: true, conversation: "fork", from_session: sessionA } });
      const entriesB = ledger().filter((e) => e.branch === "B");
      expect(entriesB.length).toBeGreaterThan(5);
      expect(ofType("checkpoint").filter((e) => e.branch === "B").map((e) => e.body.id)).toEqual(expect.arrayContaining(["B1", "B2"]));
      expect(ofType("checkpoint").find((e) => e.body.id === "B1")).toMatchObject({ body: { parent: "A1", trigger: "restart" } });
      // Both branches spent from one budget: two worker stretches, and the watcher calls, all in one ledger.
      expect(ofType("check_result").filter((e) => e.body.check === "budget" && e.body.event === "usage")).toHaveLength(2);
      // The old branch and its workspace are intact, and the new worktree holds the files of A1.
      expect(readFileSync(join(work, "reports", "profile.json"), "utf8")).toBe(snapshotOfA);
      expect(existsSync(join(worktree, "data", "customers.db"))).toBe(true);
      expect(ofType("checkpoint").filter((e) => e.branch === "A").map((e) => e.body.id)).toEqual(checkpointsBefore);
      expect(verifyFile(ledgerPath(home, "r_m4"), { anchorsPath: anchorPath(home, "r_m4") })).toMatchObject({ ok: true });

      // The receipt shows the rule, the scores side by side and the correction, and verify accepts it.
      const out = join(base, "receipt");
      const receipt = await candor(["receipt", "r_m4", "--out", out, "--label", "scripted"]);
      expect(receipt.status, receipt.stderr).toBe(0);
      const json = JSON.parse(readFileSync(join(out, "receipt.json"), "utf8")) as { rescores: { checkpoint: string; scores: { kind: string; level: string }[] }[]; corrections: { detail: string }[]; restart_note: string; rules_added: { rule: string }[]; integrity: { key_id: string } };
      expect(json.rules_added.map((r) => r.rule)).toEqual(["op-1", "restart-1"]);
      expect(json.rescores.find((r) => r.checkpoint === "A1")?.scores.map((s) => [s.kind, s.level])).toEqual([["first", "ok"], ["re-score", "pause"]]);
      expect(json.corrections[0]?.detail).toMatch(/From checkpoint A1 on branch A to branch B\./);
      expect(json.restart_note).toMatch(/not a replay/);
      const verify = await candor(["verify", join(out, "receipt.json"), "--key-id", json.integrity.key_id]);
      expect(verify.status, verify.stdout + verify.stderr).toBe(0);
    },
    300000,
  );
});
