import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPath, runDir } from "../paths.js";
import { Ledger } from "../ledger/ledger.js";
import { type Charter, charterHash, parseCharter } from "./schema.js";

/** A small charter for tests. Override any part. The checks and faults are shell one-liners so a test needs no project files. */
export function testCharter(overrides: Record<string, unknown> = {}): Charter {
  return parseCharter({
    id: "test-job",
    version: 1,
    goal: "Migrate customers_v1 to customers_v2 and remove duplicate customers.",
    success: [
      { id: "s1", text: "Every non-duplicate row exists in the new table.", check: "has-output" },
      { id: "s2", text: "Merged records keep the most recent contact details.", check: null },
    ],
    scope: {
      allow_paths: ["migration/**", "reports/**", "data/*.db"],
      deny_paths: ["tests/**", ".claude/**", "checks/**"],
      allow_commands: ["sqlite3 *", "node migration/*", "npm test", "ls *", "cat *"],
      network: false,
    },
    budget: { max_cost_usd: 3, max_turns: 120, max_minutes: 45 },
    stages: [
      { id: "profile", title: "Profile", exit_checks: ["has-output"] },
      { id: "map", title: "Map", exit_checks: [] },
      { id: "migrate", title: "Migrate", exit_checks: [], irreversible: true },
    ],
    checks: [
      { id: "has-output", type: "command", run: "test -f reports/out.txt", when: "checkpoint", fault: "if [ \"$CANDOR_FAULT_MODE\" = control ]; then mkdir -p reports && echo ok > reports/out.txt; else rm -f reports/out.txt; fi" },
      { id: "no-pii", type: "pattern", paths: ["reports/**", "*.log"], deny: "email", when: "every_action" },
    ],
    drift_rules: [{ id: "goal-1", dimension: "goal", source: "generated", text: "Work serves migration and deduplication only." }],
    thresholds: { warn: 0.35, pause: 0.6 },
    irreversible: ["DROP TABLE *", "node migration/apply.js *"],
    escalation: { on_pause: "operator" },
    ...overrides,
  });
}

/** Writes what `candor charter approve` writes, so a daemon can start on the run. Tests only. */
export function seedApprovedRun(home: string, run: string, charter: Charter = testCharter(), now?: () => Date): Charter {
  mkdirSync(runDir(home, run), { recursive: true, mode: 0o700 });
  const ledger = Ledger.open({ path: ledgerPath(home, run), run, now });
  const hash = charterHash(charter);
  const reviewDigest = `sha256:${"0".repeat(64)}`;
  ledger.append({ type: "charter_approved", actor: "operator", body: { charter_id: charter.id, version: charter.version, charter_hash: hash, review_digest: reviewDigest } });
  ledger.append({ type: "charter_review", actor: "operator", body: { charter_hash: hash, review_digest: reviewDigest, items: [] } });
  writeFileSync(join(runDir(home, run), `charter.v${charter.version}.json`), JSON.stringify(charter, null, 2), { mode: 0o400 });
  return charter;
}
