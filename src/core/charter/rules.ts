import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoSecrets } from "./approve.js";
import { type Charter, charterHash, parseCharter } from "./schema.js";

/**
 * A rule change makes a new version of the charter (R1, D-070). The old version stays on disk and in the
 * ledger, so every score can be read against the rules it was made under.
 */

export type RuleSource = "operator" | "restart";
export type RuleDimension = "goal" | "scope" | "plan" | "evidence";

export interface NewRule {
  text: string;
  dimension: RuleDimension;
  source: RuleSource;
}

const MAX_RULE_CHARS = 600;

/** The next rule id: `op-1`, `op-2` for an operator rule and `restart-1` for the reason of a restart. */
export function nextRuleId(charter: Charter, source: RuleSource): string {
  const prefix = source === "operator" ? "op" : "restart";
  const used = new Set(charter.drift_rules.map((r) => r.id));
  for (let n = 1; ; n++) if (!used.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

export interface RuleChange {
  charter: Charter;
  rule: { id: string; dimension: RuleDimension; source: RuleSource; text: string };
  hash: string;
  previousHash: string;
}

/** Builds version n+1 with one more drift rule. It does not write anything. Throws on empty, long or secret text. */
export function withRule(charter: Charter, rule: NewRule): RuleChange {
  const text = rule.text.trim().replace(/\s+/g, " ");
  if (text.length === 0) throw new Error("A rule needs text. Say what the worker must not do, or must do.");
  if (text.length > MAX_RULE_CHARS) throw new Error(`A rule can be at most ${MAX_RULE_CHARS} characters. This one has ${text.length}. Make it shorter.`);
  const added = { id: nextRuleId(charter, rule.source), dimension: rule.dimension, source: rule.source, text };
  const next = parseCharter({ ...charter, version: charter.version + 1, drift_rules: [...charter.drift_rules, added] });
  // The charter is stored as written, so it must not hold a secret or personal data.
  assertNoSecrets(next);
  return { charter: next, rule: added, hash: charterHash(next), previousHash: charterHash(charter) };
}

/** Writes `charter.v<n>.json` read only. It refuses to replace a version that exists. */
export function writeCharterVersion(runFolder: string, charter: Charter): string {
  const file = join(runFolder, `charter.v${charter.version}.json`);
  if (existsSync(file)) throw new Error(`The charter version ${charter.version} already exists at ${file}. A version is never replaced.`);
  writeFileSync(file, JSON.stringify(charter, null, 2), { mode: 0o400, flag: "wx" });
  return file;
}
