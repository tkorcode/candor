import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorkerSettings, HOOKS } from "../core/run/settings.js";
import { anchorPath, ledgerPath } from "../core/paths.js";
import { verifyFile } from "../core/ledger/verify.js";
import type { LedgerEntry } from "../core/ledger/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sqliteOk = spawnSync("sqlite3", ["--version"]).status === 0;

describe("candor run, driven end to end with a stand-in for claude", () => {
  let base: string;
  let home: string;
  let work: string;
  let bin: string;

  const candor = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(root, "bin", "candor.js"), ...args], { encoding: "utf8", env: { ...process.env, CANDOR_HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env } });

  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
    base = mkdtempSync(join(tmpdir(), "cr-"));
    home = join(base, "h");
    work = join(base, "w");
    bin = join(base, "bin");
    mkdirSync(bin);
    // `claude` in this folder is the stand-in. It is a copy that runs under node.
    const fake = join(bin, "claude");
    writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${join(root, "src", "cli", "testing", "fake-claude.mjs")}" "$@"\n`);
    chmodSync(fake, 0o755);
    // The demo project needs the sqlite3 program. Without it, only the tests that need no project run.
    if (sqliteOk) execFileSync(process.execPath, [join(root, "demo", "make-project.mjs"), work]);
    else mkdirSync(work);
  }, 120000);
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it.skipIf(!sqliteOk)("approves a charter, tests the checks, runs the worker through the hooks, and writes a receipt", () => {
    const charter = join(root, "demo", "charter.yaml");
    expect(candor(["charter", "review", charter, "--accept", 'unchecked_criterion:s3="No check exists for this yet."', "--accept", 'check_without_fault:no-pii-in-logs="Candor plants an email value itself in the strength test."']).stdout).toMatch(/open item|No open items/);
    const approve = candor(["charter", "approve", charter, "--run", "r_e2e"]);
    expect(approve.status, approve.stderr + approve.stdout).toBe(0);

    const run = candor(["run", "r_e2e", "--workspace", work, "--task", "Do the job.", "--oracle", `${work}-oracle`]);
    expect(run.status, run.stderr + run.stdout).toBe(0);
    expect(run.stdout).toMatch(/proven\s+row-conservation/);
    expect(run.stdout).toMatch(/proven\s+dedup-plan-valid/);
    expect(run.stdout).toMatch(/Worker finished: success/);
    // The original folder with the answer key was removed after the copy. The key is in the run store and in no file of the workspace.
    expect(existsSync(`${work}-oracle`)).toBe(false);
    expect(run.stdout).toMatch(/original folder .* was removed/);
    expect(readFileSync(join(home, "runs", "r_e2e", "oracle", "expected.json"), "utf8")).toContain("distinct_emails");
    expect(spawnSync("find", [work, "-name", "expected.json"], { encoding: "utf8" }).stdout.trim()).toBe("");
    const used = JSON.parse(readFileSync(join(home, "runs", "r_e2e", "worker-settings.json"), "utf8")) as { sandbox: { filesystem: { denyRead: string[] } }; permissions: { deny: string[] } };
    expect(used.sandbox.filesystem.denyRead.some((p) => p.endsWith("/runs/r_e2e/oracle"))).toBe(true);
    expect(used.permissions.deny.some((r) => r.startsWith("Read(//") && r.includes("/runs/r_e2e/oracle/**"))).toBe(true);

    const entries = readFileSync(ledgerPath(home, "r_e2e"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as LedgerEntry);
    const types = entries.map((e) => e.type);
    expect(types[0]).toBe("charter_approved");
    expect(types).toContain("run_start");
    expect(entries.filter((e) => e.type === "check_strength").every((e) => e.body.status === "proven")).toBe(true);
    // The harness read the plugin list from the init message.
    expect(entries.find((e) => e.type === "session_start" && e.body.source === "harness_init")).toMatchObject({ actor: "candord", body: { plugins: [{ name: "fake", source: "test" }] } });
    // An action outside scope was denied by the hook, and the irreversible action was held with a checkpoint taken first.
    expect(entries.find((e) => e.type === "tool_intent" && e.body.decision === "deny")).toMatchObject({ body: { rule: "scope" } });
    expect(entries.find((e) => e.type === "tool_intent" && e.body.decision === "hold")).toBeTruthy();
    const checkpoints = entries.filter((e) => e.type === "checkpoint");
    expect(checkpoints.map((e) => e.body.trigger)).toEqual(expect.arrayContaining(["stage_done", "before_irreversible", "final"]));
    // Spend was reported, and the ledger and anchors verify.
    expect(entries.find((e) => e.type === "check_result" && e.body.event === "usage")).toMatchObject({ body: { cost_usd: 0.1234, turns: 4 } });
    expect(verifyFile(ledgerPath(home, "r_e2e"), { anchorsPath: anchorPath(home, "r_e2e") })).toMatchObject({ ok: true });
    expect(candor(["verify", "r_e2e"]).status).toBe(0);

    const receipt = candor(["receipt", "r_e2e", "--out", join(base, "receipt"), "--label", "scripted"]);
    expect(receipt.status, receipt.stderr).toBe(0);
    const json = JSON.parse(readFileSync(join(base, "receipt", "receipt.json"), "utf8"));
    expect(json.verdicts.result_verified.verdict).not.toBe("yes");
    expect(json.verdicts.stayed_on_course.verdict).not.toBe("yes");
    expect(json.held_and_approved).toHaveLength(1);
    expect(readFileSync(join(base, "receipt", "receipt.html"), "utf8")).toContain("Stayed on course");
  }, 180000);

  it.skipIf(!sqliteOk)("the exit check of every stage of the demo charter can pass at the point where the stage runs", () => {
    const project = join(base, "stages");
    const key = join(base, "stages-oracle");
    execFileSync(process.execPath, [join(root, "demo", "make-project.mjs"), project], { stdio: "ignore" });
    const sh = (command: string) => spawnSync("sh", ["-c", command], { cwd: project, encoding: "utf8", env: { ...process.env, CANDOR_CHECK: "1" } });
    const node = (code: string) => execFileSync(process.execPath, ["-e", `const l=require("./checks/lib.js");${code}`], { cwd: project });
    // profile
    writeFileSync(join(project, "reports", "profile.json"), JSON.stringify({ row_count: Number(execFileSync("sqlite3", [join(project, "data", "customers.db"), "select count(*) from customers_v1"], { encoding: "utf8" })) }));
    expect(sh("node checks/row-count-recorded.js").status).toBe(0);
    // map
    node('require("fs").writeFileSync("migration/mapping.json", JSON.stringify({columns:Object.fromEntries(l.expected().columns.map(c=>[c,c]))}))');
    expect(sh("node checks/mapping-complete.js").status).toBe(0);
    // dedup: the plan can pass here, and the table check cannot, because customers_v2 does not exist yet
    node("l.buildGoodPlan()");
    expect(sh("node checks/dedup-plan-valid.js").status).toBe(0);
    expect(sh("node checks/no-duplicates.js").status).toBe(1);
    // migrate: both table checks pass, with no answer key available during the stage and with it at the end
    node("l.buildGoodState()");
    expect(sh("node checks/row-conservation.js").status).toBe(0);
    expect(sh("node checks/no-duplicates.js").status).toBe(0);
    expect(spawnSync("sh", ["-c", "node checks/row-conservation.js"], { cwd: project, env: { ...process.env, CANDOR_ORACLE_DIR: key } }).status).toBe(0);
  });

  it("refuses to start below the minimum Claude Code version", () => {
    const result = candor(["run", "r_e2e", "--workspace", work, "--task", "x"], { FAKE_CLAUDE_VERSION: "2.1.200 (Claude Code)" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/older than v2\.1\.295/);
  });

  it("gives every worker the settings of D-024 and the same hook events as the plugin", () => {
    const settings = buildWorkerSettings({ home: base, candorBin: "/x/candor.js" }) as {
      sandbox: Record<string, unknown>;
      permissions: { deny: string[] };
      hooks: Record<string, { hooks: { onFailure?: string }[] }[]>;
    };
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(JSON.stringify(settings.sandbox)).toContain("operator.key");
    expect(settings.permissions.deny.some((r) => r.startsWith("Edit(//") && r.endsWith("/**)"))).toBe(true);
    expect(settings.permissions.deny.some((r) => r.startsWith("Read(//") && r.endsWith("operator.key)"))).toBe(true);
    expect(settings.hooks.PreToolUse?.[0]?.hooks[0]?.onFailure).toBe("block");
    const plugin = JSON.parse(readFileSync(join(root, "plugin", "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, unknown> };
    expect(Object.keys(plugin.hooks).sort()).toEqual(HOOKS.map((h) => h.event).sort());
  });
});
