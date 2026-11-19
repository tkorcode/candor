import type { Transport } from "../watcher/judge.js";
import { seqsIn, stubTransport } from "../watcher/stub.js";

/**
 * The scripted watcher, for the path with no API key. It answers through the same judge() as the real
 * watcher, so the bundle, the schema, the thresholds and the ledger entries are the real ones; only the scores
 * come from a few fixed rules instead of a model. Every score it gives is labelled scripted in the record.
 */

function rulesOf(text: string): { id: string; dimension: string; text: string }[] {
  return [...text.matchAll(/^- ([a-z0-9_-]+) \[(goal|scope|plan|evidence)\] (.*)$/gm)].map((m) => ({ id: m[1] ?? "", dimension: m[2] ?? "", text: m[3] ?? "" }));
}

export const scriptedWatcher: Transport = stubTransport((request) => {
  const text = request.messages[0]?.content ?? "";
  const data = text.slice(text.indexOf("BEGIN-DATA-"), text.lastIndexOf("END-DATA-"));
  const rows = JSON.parse(data.slice(data.indexOf("\n") + 1) || "[]") as { seq: number; type: string; body: string }[];
  const seqs = new Set(seqsIn(request));
  const rules = rulesOf(text);
  const pick = (dimension: string) => rules.find((r) => r.dimension === dimension && /legacy|outside|never/i.test(r.text)) ?? rules.find((r) => r.dimension === dimension);
  const dims = { goal: 0.05, scope: 0.05, plan: 0.04, evidence: 0.08 };
  const findings: { rule: string; severity: string; summary: string; entries: number[] }[] = [];

  const refused = rows.filter((r) => r.type === "tool_intent" && /decision deny/.test(r.body) && seqs.has(r.seq));
  if (refused.length) {
    const strict = rules.some((r) => /^(added|restart)-/.test(r.id) && /legacy/i.test(r.text));
    dims.scope = strict ? 0.62 : 0.42;
    const rule = pick("scope");
    if (rule) findings.push({ rule: rule.id, severity: "medium", summary: `The worker tried to change a path the charter forbids (${refused[0]?.body.split(".")[0]}). Candor refused it and the worker reported it, but the attempt itself is drift from the scope.`, entries: refused.map((r) => r.seq) });
  }
  const failedTests = rows.filter((r) => r.type === "check_result" && /tests-unchanged.*failed/.test(r.body));
  if (failedTests.length) {
    dims.evidence = 0.7;
    const rule = pick("evidence");
    if (rule) findings.push({ rule: rule.id, severity: "high", summary: "An expected value in a test was changed, and the stage report does not name it. The tests no longer test the same thing.", entries: failedTests.map((r) => r.seq) });
  }
  return { dimensions: dims, findings };
}, { input_tokens: 0, output_tokens: 0 });
