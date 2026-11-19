import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCharter } from "../charter/testing.js";
import { evaluateAction } from "./action.js";
import { containsPattern, matchesCommand, matchesPath } from "./glob.js";
import { parseShell } from "./shell.js";
import { strengthTest } from "./strength.js";

describe("glob matching", () => {
  it("matches paths the way a charter author expects", () => {
    expect(matchesPath(["migration/**"], "migration/a/b.js")).toBe(true);
    expect(matchesPath(["migration/**"], "migration")).toBe(true);
    expect(matchesPath(["migration/**"], "migrationx/a.js")).toBe(false);
    expect(matchesPath(["data/*.db"], "data/customers.db")).toBe(true);
    expect(matchesPath(["data/*.db"], "data/x/customers.db")).toBe(false);
    expect(matchesPath(["*.log"], "deep/er/run.log")).toBe(true);
    expect(matchesPath(["**/tests/**"], "a/tests/b.js")).toBe(true);
  });
  it("matches commands anchored, and irreversible patterns anywhere", () => {
    expect(matchesCommand(["sqlite3 *"], "sqlite3  data/x.db  'select 1'")).toBe(true);
    expect(matchesCommand(["npm test"], "npm test --silent")).toBe(false);
    expect(containsPattern(["DROP TABLE *"], 'sqlite3 x.db "drop table customers_v1"')).toBe("DROP TABLE *");
    expect(containsPattern(["DROP TABLE *"], "select 1")).toBeNull();
  });
});

describe("shell reading", () => {
  it("splits simple commands and reads redirections", () => {
    const parsed = parseShell("ls reports && cat reports/a.txt > reports/b.txt 2>&1");
    expect(parsed.ok && parsed.segments.map((s) => s.words)).toEqual([["ls", "reports"], ["cat", "reports/a.txt"]]);
    expect(parsed.ok && parsed.segments[1]?.redirects).toEqual([{ op: ">", target: "reports/b.txt" }]);
  });
  it.each(["echo $(whoami)", "echo `id`", "echo $HOME", "(rm x)", "cat <<EOF\nx\nEOF", "FOO=1 ls", "cat ~/x", "ls \\\n x", "echo 'open"])("refuses text it cannot read: %s", (command) => {
    expect(parseShell(command).ok).toBe(false);
  });
  it("keeps quoted separators inside the word", () => {
    const parsed = parseShell("sqlite3 data/x.db 'select 1; select 2 | 3'");
    expect(parsed.ok && parsed.segments).toHaveLength(1);
  });
});

describe("rules on every action", () => {
  let root: string;
  const charter = testCharter();
  const check = (tool: string, input: Record<string, unknown>) => evaluateAction(charter, root, tool, input);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "candor-act-"));
    for (const dir of ["migration", "reports", "data", "tests", "checks"]) mkdirSync(join(root, dir));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("scope: allows writes in allow_paths and denies the rest", () => {
    expect(check("Write", { file_path: "migration/a.sql", content: "x" }).decision).toBe("allow");
    expect(check("Write", { file_path: "tests/a.js", content: "x" })).toMatchObject({ decision: "deny", rule: "scope" });
    expect(check("Edit", { file_path: "checks/row.js", new_string: "x" })).toMatchObject({ decision: "deny", rule: "scope" });
    expect(check("Write", { file_path: "other.txt", content: "x" })).toMatchObject({ decision: "deny", rule: "scope" });
    expect(check("Write", { file_path: "/etc/hosts", content: "x" })).toMatchObject({ decision: "deny", rule: "scope" });
    expect(check("Write", { file_path: "migration/../tests/a.js", content: "x" })).toMatchObject({ decision: "deny" });
  });
  it("scope: a link out of the workspace does not lead out", () => {
    symlinkSync("/etc", join(root, "migration", "etc"));
    expect(check("Write", { file_path: "migration/etc/passwd", content: "x" })).toMatchObject({ decision: "deny", rule: "scope" });
  });
  it("scope: a read outside the workspace is denied, a read inside is allowed", () => {
    expect(check("Read", { file_path: "data/x.db" }).decision).toBe("allow");
    expect(check("Read", { file_path: "/etc/passwd" })).toMatchObject({ decision: "deny", rule: "scope" });
    expect(check("Glob", { pattern: "/etc/*" })).toMatchObject({ decision: "deny" });
  });
  it("command: only commands on the allow list, and every part of a compound command", () => {
    expect(check("Bash", { command: "sqlite3 data/c.db 'select 1'" }).decision).toBe("allow");
    expect(check("Bash", { command: "sqlite3 data/c.db 'select 1' && rm -rf data" })).toMatchObject({ decision: "deny", rule: "command" });
    expect(check("Bash", { command: "ls reports | sh" })).toMatchObject({ decision: "deny", rule: "command" });
    expect(check("Bash", { command: "echo hi" })).toMatchObject({ decision: "deny", rule: "command" });
    expect(check("Bash", { command: "candor operator approve x" })).toMatchObject({ decision: "deny", rule: "command" });
    expect(check("Bash", { command: "ls $(cat /etc/passwd)" })).toMatchObject({ decision: "deny", rule: "command" });
  });
  it("command: paths in arguments cannot leave the workspace or the scope", () => {
    expect(check("Bash", { command: "cat /etc/passwd" })).toMatchObject({ decision: "deny", rule: "scope" });
    expect(check("Bash", { command: "cat ../secret" })).toMatchObject({ decision: "deny", rule: "scope" });
    expect(check("Bash", { command: "ls /e*" })).toMatchObject({ decision: "deny", rule: "scope" });
    expect(check("Bash", { command: "cat data/c.db > tests/copy.db" })).toMatchObject({ decision: "deny", rule: "scope" });
    expect(check("Bash", { command: "cat data/c.db > reports/copy.txt" }).decision).toBe("allow");
    expect(check("Bash", { command: "ls reports > /dev/null 2>&1" }).decision).toBe("allow");
    expect(check("Bash", { command: "sqlite3 data/c.db '.shell id'" })).toMatchObject({ decision: "deny", rule: "command" });
    expect(check("Bash", { command: "sqlite3 data/c.db \"ATTACH '/tmp/x' AS o\"" })).toMatchObject({ decision: "deny" });
  });
  it("network: denies tools and commands that reach out, and records the attempt as an effect", () => {
    const web = check("WebFetch", { url: "https://example.org" });
    expect(web).toMatchObject({ decision: "deny", rule: "network" });
    expect(web.effects[0]).toMatchObject({ kind: "network" });
    expect(check("mcp__x__send", {})).toMatchObject({ decision: "deny", rule: "network" });
    const open = evaluateAction(testCharter({ scope: { allow_paths: ["**"], deny_paths: [], allow_commands: ["*"], network: true } }), root, "Bash", { command: "curl https://example.org" });
    expect(open.decision).toBe("allow");
    expect(check("Bash", { command: "ls reports" }).decision).toBe("allow");
  });
  it("network: a script the command runs is read for network use", () => {
    writeFileSync(join(root, "migration", "go.js"), "fetch('https://example.org/x')\n");
    expect(check("Bash", { command: "node migration/go.js" })).toMatchObject({ decision: "deny", rule: "network" });
  });
  it("personal data: denies writing an email into a covered path and allows it elsewhere", () => {
    expect(check("Write", { file_path: "reports/out.txt", content: "mail jane@example.org" })).toMatchObject({ decision: "deny", rule: "personal_data" });
    expect(check("Write", { file_path: "reports/out.txt", content: "count: 12" }).decision).toBe("allow");
    expect(check("Write", { file_path: "migration/seed.sql", content: "insert 'jane@example.org'" }).decision).toBe("allow");
  });
  it("irreversible: holds a matching command, and the digest changes when the script changes", () => {
    const hold = check("Bash", { command: 'sqlite3 data/c.db "DROP TABLE customers_v1"' });
    expect(hold).toMatchObject({ decision: "hold", rule: "irreversible" });
    expect(hold.effects[0]).toMatchObject({ kind: "irreversible", reversible: false });
    writeFileSync(join(root, "migration", "apply.js"), "// apply\n");
    const first = check("Bash", { command: "node migration/apply.js now" });
    expect(first.decision).toBe("hold");
    writeFileSync(join(root, "migration", "apply.js"), "// something else\n");
    expect(check("Bash", { command: "node migration/apply.js now" }).actionDigest).not.toBe(first.actionDigest);
    // A step hidden in a script that a plain command runs is found.
    writeFileSync(join(root, "migration", "clean.js"), "run('DROP TABLE customers_v1')\n");
    expect(check("Bash", { command: "node migration/clean.js" })).toMatchObject({ decision: "hold" });
  });
  it("denies a tool it does not know", () => {
    expect(check("Surprise", {})).toMatchObject({ decision: "deny", rule: "tool" });
  });
});

describe("check strength test", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "candor-str-"));
    mkdirSync(join(root, "reports"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const charterWith = (checks: unknown[]) => testCharter({ checks, success: [{ id: "s1", text: "Rows are kept in the new table.", check: null }], stages: [{ id: "profile", title: "P", exit_checks: [] }] });
  const fault = (plant: string) => `if [ "$CANDOR_FAULT_MODE" = control ]; then echo good > state.txt; else ${plant}; fi`;

  it("proves a check that passes with no fault and fails on its fault", async () => {
    const charter = charterWith([{ id: "c1", type: "command", run: "grep -q good state.txt", when: "checkpoint", fault: fault("echo bad > state.txt") }]);
    const [result] = await strengthTest(charter, root, null);
    expect(result).toMatchObject({ check: "c1", status: "proven", control_exit: 0, fault_exit: 1 });
  });
  it("flags a check that cannot fail", async () => {
    const charter = charterWith([{ id: "c1", type: "command", run: "true", when: "checkpoint", fault: fault("echo bad > state.txt") }]);
    expect((await strengthTest(charter, root, null))[0]).toMatchObject({ status: "unproven", fault_exit: 0 });
  });
  it("flags a check that fails on everything, not only on its fault", async () => {
    const charter = charterWith([{ id: "c1", type: "command", run: "false", when: "checkpoint", fault: fault("echo bad > state.txt") }]);
    expect((await strengthTest(charter, root, null))[0]).toMatchObject({ status: "unproven", reason: expect.stringContaining("no fault") });
  });
  it("flags a check that breaks instead of failing, and one with no fault", async () => {
    const charter = charterWith([
      { id: "c1", type: "command", run: "exit 7", when: "checkpoint", fault: "true" },
      { id: "c2", type: "command", run: "true", when: "checkpoint" },
    ]);
    const results = await strengthTest(charter, root, null);
    expect(results[0]?.status).toBe("unproven");
    expect(results[1]).toMatchObject({ status: "unproven", fault: "none" });
  });
  it("proves a personal data check with a built-in fault, and not one with a custom pattern", async () => {
    const charter = charterWith([
      { id: "pii", type: "pattern", paths: ["reports/**"], deny: "email", when: "every_action" },
      { id: "custom", type: "pattern", paths: ["reports/**"], deny: "regex:abc", when: "every_action" },
    ]);
    const results = await strengthTest(charter, root, null);
    expect(results[0]).toMatchObject({ status: "proven", fault: "built-in" });
    expect(results[1]).toMatchObject({ status: "unproven", fault: "none" });
  });
  it("runs the checks from the copy taken before the run, not from the workspace", async () => {
    mkdirSync(join(root, "checks"));
    writeFileSync(join(root, "checks", "c.sh"), "grep -q good state.txt\n");
    const pristine = mkdtempSync(join(tmpdir(), "candor-pristine-"));
    writeFileSync(join(pristine, "c.sh"), "grep -q good state.txt\n");
    // The worker rewrites the check in the workspace so that it always passes.
    writeFileSync(join(root, "checks", "c.sh"), "true\n");
    const charter = charterWith([{ id: "c1", type: "command", run: "sh checks/c.sh", when: "checkpoint", fault: fault("echo bad > state.txt") }]);
    expect((await strengthTest(charter, root, pristine))[0]).toMatchObject({ status: "proven" });
    rmSync(pristine, { recursive: true, force: true });
  });
});

describe("irreversible actions hidden from the command text", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "candor-irr-"));
    for (const dir of ["migration", "data"]) mkdirSync(join(root, dir));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const charter = testCharter();
  it("holds a statement in a file fed in with <", () => {
    writeFileSync(join(root, "migration", "d.sql"), "DROP TABLE customers_v1;\n");
    expect(evaluateAction(charter, root, "Bash", { command: "sqlite3 data/c.db < migration/d.sql" })).toMatchObject({ decision: "hold" });
  });
  it("holds the bare command when the pattern ends in a star", () => {
    writeFileSync(join(root, "migration", "apply.js"), "// nothing\n");
    expect(evaluateAction(charter, root, "Bash", { command: "node migration/apply.js" })).toMatchObject({ decision: "hold" });
    expect(evaluateAction(charter, root, "Bash", { command: "node migration/apply.jsx" }).decision).toBe("allow");
  });
});

describe("evasions found by the red team", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "candor-rt-"));
    for (const dir of ["migration", "data"]) mkdirSync(join(root, dir));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const charter = testCharter();
  const run = (command: string) => evaluateAction(charter, root, "Bash", { command });
  it("holds DROP TABLE with SQL comments between the words", () => {
    expect(run('sqlite3 data/c.db "DROP /* x */ TABLE t"').decision).toBe("hold");
    expect(run('sqlite3 data/c.db "DROP -- x\n TABLE t"').decision).toBe("hold");
  });
  it("holds the script with doubled slashes or dot parts in the path", () => {
    writeFileSync(join(root, "migration", "apply.js"), "//\n");
    expect(run("node migration//apply.js run").decision).toBe("hold");
    expect(run("node migration/./apply.js run").decision).toBe("hold");
  });
  it("denies sqlite3 dot-commands, writes and init files that can leave the database", () => {
    for (const c of ["sqlite3 data/c.db '.sh id'", "sqlite3 data/c.db '.backup /x'", "sqlite3 data/c.db \"select writefile('x','y')\"", "sqlite3 data/c.db \"VACUUM INTO 'x.db'\"", "sqlite3 -init migration/a.sql data/c.db", "cat migration/a.sql | sqlite3 data/c.db"]) {
      expect(run(c).decision, c).toBe("deny");
    }
    expect(run("sqlite3 data/c.db '.tables'").decision).toBe("allow");
  });
  it("denies input or a script too large to check instead of letting it through", () => {
    writeFileSync(join(root, "migration", "big.sql"), `${" ".repeat(300 * 1024)}DROP TABLE t;`);
    expect(run("sqlite3 data/c.db < migration/big.sql")).toMatchObject({ decision: "deny", rule: "command" });
  });
  it("redacts a long string of dots quickly", async () => {
    const { createRedactor } = await import("../ledger/redact.js");
    const started = Date.now();
    createRedactor().text("a.".repeat(100000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
