import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "./ledger/types.js";
import { readingsOf, suggestRestart } from "./restart-point.js";

const T = { warn: 0.35, pause: 0.6 };
let seq = 0;
const entry = (type: string, body: Record<string, unknown>, branch = "A"): LedgerEntry => ({ seq: ++seq, ts: "2026-11-18T10:00:00.000Z", run: "r_t", branch, type, actor: "candord", body, prev: "", hash: "" }) as unknown as LedgerEntry;
const checkpoint = (id: string, safety = "safe_to_restart", extra: Record<string, unknown> = {}, branch = "A") => entry("checkpoint", { id, safety, ...extra }, branch);
const score = (id: string, overall: number) => entry("drift_score", { checkpoint: id, status: "scored", overall });
const rescore = (id: string, overall: number) => entry("rescore", { checkpoint: id, status: "scored", overall });

describe("the suggested restart point (D-080)", () => {
  it("suggests the last checkpoint scored on course before drift first reached warn", () => {
    seq = 0;
    const ledger = [checkpoint("A1"), score("A1", 0.1), checkpoint("A2"), score("A2", 0.2), checkpoint("A3"), score("A3", 0.3), checkpoint("A4"), score("A4", 0.7)];
    expect(suggestRestart(ledger, T, "A")).toMatchObject({ kind: "suggested", checkpoint: "A3", flagged: "A4", flagged_level: "pause" });
  });

  it("moves earlier when a re-score under a new rule shows that drift began earlier", () => {
    seq = 0;
    const ledger = [checkpoint("A1"), score("A1", 0.1), checkpoint("A2"), score("A2", 0.2), checkpoint("A3"), score("A3", 0.3), checkpoint("A4"), score("A4", 0.7), entry("rule_change", {}), rescore("A3", 0.5)];
    expect(suggestRestart(ledger, T, "A")).toMatchObject({ kind: "suggested", checkpoint: "A2", flagged: "A3", flagged_level: "warn" });
    expect(readingsOf(ledger, "A").find((r) => r.checkpoint === "A3")).toMatchObject({ overall: 0.5, from: "rescore" });
  });

  it("never suggests a record-only checkpoint, or one that was not scored", () => {
    seq = 0;
    const ledger = [checkpoint("A1"), score("A1", 0.1), checkpoint("A2"), checkpoint("A3", "record_only"), score("A3", 0.1), checkpoint("A4", "record_only"), score("A4", 0.5)];
    expect(suggestRestart(ledger, T, "A")).toMatchObject({ kind: "suggested", checkpoint: "A1", flagged: "A4" });
  });

  it("says when there is nothing to restart from, no basis, or no checkpoint to go back to", () => {
    seq = 0;
    expect(suggestRestart([checkpoint("A1"), score("A1", 0.1)], T, "A").kind).toBe("on_course");
    seq = 0;
    expect(suggestRestart([checkpoint("A1"), checkpoint("A2")], T, "A").kind).toBe("no_basis");
    seq = 0;
    expect(suggestRestart([checkpoint("A1"), score("A1", 0.4)], T, "A")).toMatchObject({ kind: "none_safe", flagged: "A1" });
  });

  it("reads a branch with the checkpoints it was forked from, and not what the old branch did after the fork", () => {
    seq = 0;
    const ledger = [checkpoint("A1"), score("A1", 0.1), checkpoint("A2"), score("A2", 0.9), checkpoint("B1", "safe_to_restart", { restart_of: "A1" }, "B"), checkpoint("B2", "safe_to_restart", {}, "B")];
    ledger.push({ ...score("B2", 0.5), branch: "B" } as LedgerEntry);
    // On B, A2 (after the fork) is not part of the lineage. B1 was not scored, so the suggestion is A1.
    expect(readingsOf(ledger, "B").map((r) => r.checkpoint)).toEqual(["A1", "B1", "B2"]);
    expect(suggestRestart(ledger, T, "B")).toMatchObject({ kind: "suggested", checkpoint: "A1", flagged: "B2" });
  });
});
