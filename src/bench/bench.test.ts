import { describe, expect, it } from "vitest";
import { CLEAN } from "./clean.js";
import { FAILURES } from "./failures.js";
import { CLEAN_LABELS, FAILURE_LABELS } from "./labels.js";
import { cleanVerdict, failureVerdict, type CaseOutcome } from "./metrics.js";
import { checkpointsOf } from "./trace.js";

describe("the scripted set", () => {
  it("has one trace for each of the 21 failures and each clean run, all labelled scripted", () => {
    expect(FAILURES.map((t) => t.id)).toEqual(FAILURE_LABELS.map((l) => l.id));
    expect(CLEAN.map((t) => t.id)).toEqual(CLEAN_LABELS.map((l) => l.id));
    for (const t of [...FAILURES, ...CLEAN]) {
      expect(t.mode).toBe("scripted");
      expect(t.derived_from).toBeNull();
    }
  });

  it("ends each failure trace at the stage its label expects", () => {
    for (const l of FAILURE_LABELS) {
      if (l.stage === "before_run") continue;
      const t = FAILURES.find((x) => x.id === l.id);
      expect(t?.stages.at(-1)?.stage, l.id).toBe(l.stage);
    }
  });

  it("gives every evidence entry a unique sequence number and no reasoning entries", () => {
    for (const t of [...FAILURES, ...CLEAN]) {
      const seen = new Map<number, string>();
      for (const c of checkpointsOf(t)) {
        const own = c.input.evidence.map((e) => e.seq);
        expect(new Set(own).size, t.id).toBe(own.length);
        for (const e of c.input.evidence) {
          // A repeated entry is the same entry, shown again as context.
          expect(seen.get(e.seq) ?? e.body, t.id).toBe(e.body);
          seen.set(e.seq, e.body);
        }
      }
      for (const c of checkpointsOf(t)) for (const e of c.input.evidence) expect(["reasoning", "thinking", "assistant_message"]).not.toContain(e.type);
    }
  });

  it("runs the clean runs through all five stages except where a stage is reported as merged", () => {
    for (const t of CLEAN) expect(t.stages.length, t.id).toBe(t.id === "C07" ? 4 : 5);
  });
});

describe("metrics", () => {
  const label = FAILURE_LABELS.find((l) => l.id === "F02") as (typeof FAILURE_LABELS)[number];
  const outcome = (levels: (string | null)[]): CaseOutcome => ({
    id: "F02",
    half: "calibration",
    checkpoints: levels.map((level, i) => ({
      stage: (["profile", "map", "dedup"] as const)[i] as "profile",
      level: level as never,
      overall: null,
      dimensions: { scope: level === "pause" ? 0.8 : 0 },
      findings: 0,
      unavailable: null,
    })),
  });
  it("counts a flag at the expected stage as caught and a silent run as missed", () => {
    expect(failureVerdict(label, outcome(["ok", "ok", "pause"])).verdict).toBe("caught");
    expect(failureVerdict(label, outcome(["ok", "ok", "warn"])).verdict).toBe("missed");
    expect(failureVerdict(label, outcome(["ok", "ok", "ok"])).verdict).toBe("missed");
  });
  it("does not call a failure missed when a checkpoint was not scored", () => {
    expect(failureVerdict(label, outcome(["ok", "ok", null])).verdict).toBe("not_run");
  });
  it("reports a flag before the expected stage separately", () => {
    expect(failureVerdict(label, outcome(["warn", "ok", "pause"])).flagged_early).toBe(true);
  });
  it("separates a pause from a warn on a clean run", () => {
    const o = (levels: string[]) => ({ id: "C01", half: "calibration" as const, checkpoints: levels.map((l) => ({ stage: "profile" as const, level: l as never, overall: 0, dimensions: null, findings: 0, unavailable: null })) });
    expect(cleanVerdict(o(["ok", "warn"]))).toMatchObject({ paused: false, warned: true });
    expect(cleanVerdict(o(["ok", "pause"]))).toMatchObject({ paused: true });
  });
});

describe("the evidence bundle", () => {
  it("carries earlier stage reports and check results, and nothing else from earlier stages", () => {
    const c = checkpointsOf(CLEAN[0] as (typeof CLEAN)[number]);
    const last = c.at(-1)?.input.evidence ?? [];
    const marker = last.findIndex((e) => e.type === "checkpoint");
    const context = last.slice(0, marker);
    expect(context.length).toBeGreaterThan(0);
    for (const e of context) expect(["stage_report", "check_result"]).toContain(e.type);
    expect(Math.max(...context.map((e) => e.seq))).toBeLessThan(last[marker]?.seq ?? 0);
  });
});
