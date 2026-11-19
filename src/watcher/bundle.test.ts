import { describe, expect, it } from "vitest";
import type { Charter } from "../core/charter/schema.js";
import type { LedgerEntry } from "../core/ledger/types.js";
import { buildBundle, lineageEntries } from "./bundle.js";

const entry = (seq: number, type: string, body: Record<string, unknown>, branch?: string): LedgerEntry =>
  ({ seq, ts: "2026-11-18T12:00:00.000Z", run: "r_t", ...(branch ? { branch } : {}), type, actor: type === "tool_intent" ? "worker" : "candord", body, prev: "sha256:x", hash: "sha256:y" }) as unknown as LedgerEntry;

const charter = {
  goal: "Migrate customers.",
  scope: { allow_paths: ["migration/**"], deny_paths: [], allow_commands: [], network: false },
  stages: [
    { id: "profile", title: "Profile", exit_checks: [] },
    { id: "map", title: "Map", exit_checks: [] },
    { id: "dedup", title: "Dedup", exit_checks: [] },
  ],
  drift_rules: [],
  thresholds: { warn: 0.35, pause: 0.6 },
  version: 1,
} as unknown as Charter;

// Branch A runs three stages. Branch B is restarted from A1, so it must not see A2, A3 or what A did after A1.
const ledger = [
  entry(1, "stage_report", { stage: "profile", accepted: true }),
  entry(2, "checkpoint", { id: "A1", stage: "profile", trigger: "stage_done" }),
  entry(3, "stage_report", { stage: "map", accepted: true }),
  entry(4, "checkpoint", { id: "A2", stage: "map", trigger: "stage_done" }),
  entry(5, "tool_intent", { tool: "Bash" }),
  entry(6, "stage_report", { stage: "dedup", accepted: true }),
  entry(7, "checkpoint", { id: "A3", stage: "dedup", trigger: "stage_done" }),
  entry(8, "checkpoint", { id: "B1", stage: "profile", trigger: "restart", parent: "A1", restart_of: "A1" }, "B"),
  entry(9, "tool_intent", { tool: "Write" }, "B"),
  entry(10, "checkpoint", { id: "B2", stage: "map", trigger: "stage_done", parent: "B1" }, "B"),
];

describe("the evidence bundle after a restart", () => {
  it("shows branch B only its own entries and those of branch A up to the fork point", () => {
    const seqs = lineageEntries(ledger, "B").map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 8, 9, 10]);
  });

  it("does not report branch A's later stages as completed on branch B", () => {
    const b2 = ledger[9] as LedgerEntry;
    const { input } = buildBundle({ entries: ledger, charter, checkpoint: b2, changes: null });
    const text = JSON.stringify(input.evidence);
    expect(text).toContain("Stages completed before this one: profile");
    expect(text).not.toContain("dedup");
    expect(input.evidence.map((r) => r.seq)).not.toContain(6);
    expect(input.evidence.map((r) => r.seq)).not.toContain(5);
  });

  it("leaves branch A with everything it did", () => {
    expect(lineageEntries(ledger, "A").map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps a run with no restart exactly as it is", () => {
    const plain = ledger.slice(0, 7);
    expect(lineageEntries(plain, "A")).toEqual(plain);
  });
});
