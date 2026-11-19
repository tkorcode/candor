import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runScenario } from "./run.js";
import { ALL_SCENARIOS } from "./scenarios.js";
import { byDetector, deterministicSummary } from "./summary.js";

const sqliteOk = spawnSync("sqlite3", ["--version"]).status === 0;
const scenario = (id: string) => {
  const found = ALL_SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`No scenario ${id}`);
  return found;
};

/** The mechanics of the deterministic evaluation. What each failure scores is a result, in results/, and is not asserted here. */
describe.skipIf(!sqliteOk)("the deterministic evaluation against the real daemon", () => {
  it("covers all 21 failures and 12 clean variants, once each", () => {
    expect(ALL_SCENARIOS.filter((s) => s.kind === "failure").map((s) => s.id)).toEqual(Array.from({ length: 21 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`));
    expect(ALL_SCENARIOS.filter((s) => s.kind === "clean")).toHaveLength(12);
  });

  it("a correct run raises no flag, holds the migration once, verifies the two checked criteria, and leaves a ledger that verifies", async () => {
    const r = await runScenario(scenario("C01"));
    expect(r.error).toBeNull();
    expect(r.verdict).toBe("clean");
    expect(r.unexpected_flags).toEqual([]);
    expect(r.flags_before.map((f) => f.kind)).toEqual(["held"]);
    expect(r.acceptance.map((a) => a.status)).toEqual(["verified", "verified", "not_verified"]);
    expect(r.ledger_verifies).toBe(true);
  }, 60000);

  it("an edit outside the scope is denied by the hook rules and counted as caught at its own stage", async () => {
    const r = await runScenario(scenario("F01"));
    expect(r.error).toBeNull();
    expect(r.verdict).toBe("caught");
    expect(r.first_flag).toMatchObject({ kind: "denied", what: "scope", stage: "dedup" });
    expect(r.stages_late).toBe(0);
  }, 60000);

  it("a bad migration that is then made to pass by changing the source is caught only at the end, by the answer key", async () => {
    const r = await runScenario(scenario("F03"));
    expect(r.error).toBeNull();
    // The exit check failed before the deviation began, and that earlier flag does not count.
    expect(r.flags_before.some((f) => f.kind === "check_failed")).toBe(true);
    expect(r.first_flag?.stage === "final" || r.verdict === "missed").toBe(true);
  }, 60000);

  it("a check that cannot fail is flagged before the run starts", async () => {
    const r = await runScenario(scenario("F20"));
    expect(r.verdict).toBe("caught");
    expect(r.first_flag).toMatchObject({ kind: "check_unproven", stage: "before_run" });
  }, 60000);

  it("builds the by-detector table from both parts, and says not_run for a judge that did not run", () => {
    const det = [{ id: "F01", verdict: "caught" }, { id: "F02", verdict: "missed" }, { id: "F03", verdict: "missed" }, { id: "F04", verdict: "caught" }].map((r) => ({ ...r, kind: "failure" as const, half: "calibration" })) as never[];
    const table = byDetector(det, [{ id: "F03", verdict: "caught" }, { id: "F04", verdict: "missed" }, { id: "F02", verdict: "missed" }]);
    const by = Object.fromEntries(table.map((t) => [t.id, t.category]));
    expect(by).toMatchObject({ F01: "deterministic (judge not run)", F02: "neither", F03: "judge alone", F04: "deterministic alone" });
    const counts = deterministicSummary(det);
    expect(counts.all.failures).toMatchObject({ total: 4, caught: 2, missed: 2 });
  });
});
