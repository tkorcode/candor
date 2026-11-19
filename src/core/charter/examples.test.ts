import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateAction } from "../checks/action.js";
import { loadCharterFile } from "./file.js";
import { reviewCharter } from "./review.js";

/**
 * Candor is one engine for any long job. Everything specific to a job is in its charter. These tests load the example
 * charters in examples/charters, which are written for very different work, and show that each passes the charter
 * review and that the same rule engine, unchanged, applies each charter's own scope and irreversible actions.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const folder = join(root, "examples", "charters");
const files = readdirSync(folder).filter((f) => f.endsWith(".yaml"));

describe("the example charters for other kinds of long job", () => {
  it("covers several kinds of work", () => {
    expect(files.sort()).toEqual(["code-migration.yaml", "financial-reconciliation.yaml", "screening-analysis.yaml", "security-patch-rollout.yaml"]);
  });

  it.each(files)("%s loads, passes the review with nothing open, and says what every stage is for", (file) => {
    const charter = loadCharterFile(join(folder, file));
    expect(reviewCharter(charter)).toEqual([]);
    expect(charter.stages.every((s) => (s.description ?? "").length > 20)).toBe(true);
    expect(charter.stages.some((s) => s.irreversible)).toBe(true);
    expect(charter.irreversible.length).toBeGreaterThan(0);
    // Every success criterion is tied to a check, and every check can be shown to fail.
    expect(charter.success.every((c) => c.check !== null)).toBe(true);
    expect(charter.checks.every((c) => typeof c.fault === "string" && c.fault.length > 0)).toBe(true);
  });
});

describe("the same rule engine applies the rules of each charter", () => {
  let base: string;
  const workspace = (name: string, dirs: string[]): string => {
    const dir = join(base, name);
    for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
    return dir;
  };
  const decide = (file: string, dir: string, tool: string, input: Record<string, unknown>) => evaluateAction(loadCharterFile(join(folder, file)), dir, tool, input);
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "examples-"));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("code migration: edits services, holds the push, refuses to edit API snapshots", () => {
    const dir = workspace("code", ["services/billing", "snapshots", "reports"]);
    expect(decide("code-migration.yaml", dir, "Write", { file_path: "services/billing/client.ts", content: "x" }).decision).toBe("allow");
    expect(decide("code-migration.yaml", dir, "Bash", { command: "git push origin release" }).decision).toBe("hold");
    expect(decide("code-migration.yaml", dir, "Write", { file_path: "snapshots/orders.json", content: "{}" })).toMatchObject({ decision: "deny", rule: "scope" });
  });

  it("security patch: changes dependency files, holds the deploy, refuses to edit application code", () => {
    const dir = workspace("patch", ["services/api/src", "reports"]);
    writeFileSync(join(dir, "services/api/package.json"), "{}");
    expect(decide("security-patch-rollout.yaml", dir, "Edit", { file_path: "services/api/package.json", old_string: "{}", new_string: '{"a":1}' }).decision).toBe("allow");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts/deploy.js"), "console.log('deploy')\n");
    expect(decide("security-patch-rollout.yaml", dir, "Bash", { command: "node scripts/deploy.js api" }).decision).toBe("hold");
    expect(decide("security-patch-rollout.yaml", dir, "Write", { file_path: "services/api/src/server.ts", content: "x" })).toMatchObject({ decision: "deny", rule: "scope" });
  });

  it("screening analysis: writes the analysis, holds publishing, refuses to change raw plate data", () => {
    const dir = workspace("screen", ["analysis", "data/plates", "reports", "scripts"]);
    expect(decide("screening-analysis.yaml", dir, "Write", { file_path: "analysis/fit.py", content: "x" }).decision).toBe("allow");
    writeFileSync(join(dir, "scripts/publish.js"), "console.log('publish')\n");
    expect(decide("screening-analysis.yaml", dir, "Bash", { command: "node scripts/publish.js hits.csv" }).decision).toBe("hold");
    expect(decide("screening-analysis.yaml", dir, "Write", { file_path: "data/plates/plate-07.csv", content: "x" })).toMatchObject({ decision: "deny", rule: "scope" });
  });

  it("financial reconciliation: drafts in work/, holds posting, refuses to touch closed periods or the network", () => {
    const dir = workspace("close", ["work", "ledger/closed", "reports", "scripts"]);
    expect(decide("financial-reconciliation.yaml", dir, "Write", { file_path: "work/adjustments.csv", content: "x" }).decision).toBe("allow");
    writeFileSync(join(dir, "scripts/post-entries.js"), "console.log('post')\n");
    expect(decide("financial-reconciliation.yaml", dir, "Bash", { command: "node scripts/post-entries.js work/adjustments.csv" }).decision).toBe("hold");
    expect(decide("financial-reconciliation.yaml", dir, "Write", { file_path: "ledger/closed/october.csv", content: "x" })).toMatchObject({ decision: "deny", rule: "scope" });
    expect(decide("financial-reconciliation.yaml", dir, "WebFetch", { url: "https://example.com" })).toMatchObject({ decision: "deny", rule: "network" });
  });
});
