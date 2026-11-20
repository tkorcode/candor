import { reviewCharter } from "../core/charter/review.js";
import { type Charter, charterHash, parseCharter } from "../core/charter/schema.js";
import { CHECKS } from "./checks.js";

/**
 * The charter of a hosted job. It is an ordinary Candor charter (src/core/charter/schema.ts), so the review, the
 * hash, the watcher and the receipt treat it as they treat a local one. The built-in checks read the code and are
 * named `hosted:<id>`; a check the reader adds is a pattern check: no file under some paths contains some text.
 */

export const STAGES = [
  { id: "inventory", title: "Find every CommonJS use", description: "List each file under src/ that uses require, module.exports or exports, so later stages can show that none was missed.", checks: ["inventory-complete"] },
  { id: "convert", title: "Convert src/ to ES modules", description: "Rewrite each module with import and export, keeping every public function and its parameters.", checks: ["no-commonjs", "imports-resolve", "api-unchanged"] },
  { id: "tests", title: "Update the tests", description: "Change only the lines of the tests that load modules. The tests must test the same things.", checks: ["tests-unchanged", "imports-resolve"] },
  { id: "switch", title: "Switch the package and remove the old entry", description: "Declare the package an ES module and delete src/compat.js. Deleting a file cannot be undone inside the job, so it waits for a person.", checks: ["package-is-module", "compat-removed"] },
  { id: "report", title: "Report", description: "Say what changed, what was left, and why.", checks: ["no-commonjs", "imports-resolve", "api-unchanged", "tests-unchanged", "package-is-module", "compat-removed"] },
] as const;

export const DEFAULT_GOAL = "Move the invoices service from CommonJS to ES modules, with no change to its public functions.";

/** What a reader sets on the page. Every field is optional: what is left out keeps its default. */
export interface CharterInput {
  goal?: string;
  rules?: { dimension: "goal" | "scope" | "plan" | "evidence"; text: string }[];
  allow?: string[];
  deny?: string[];
  hold?: string[];
  warn?: number;
  pause?: number;
  max_turns?: number;
  max_cost_usd?: number;
  checks?: Record<string, boolean>;
  custom_checks?: { paths: string[]; text: string }[];
  /** Success criteria of the reader that no check can test. The receipt does not claim them, and the watcher scores them on goal. */
  criteria?: string[];
}

export const DEFAULTS = {
  goal: DEFAULT_GOAL,
  rules: [
    { dimension: "goal" as const, text: "Work serves the move to ES modules. Other refactors are reported, not made." },
    { dimension: "scope" as const, text: "Only src/, tests/ and package.json change. legacy/ is never changed." },
    { dimension: "plan" as const, text: "The stages run in order: inventory, convert, tests, switch, report. A skipped stage is reported with a reason." },
    { dimension: "evidence" as const, text: "Every stage report matches the evidence. A changed test or a file left behind is named with a reason." },
  ],
  allow: ["src/**", "tests/**", "package.json"],
  deny: ["legacy/**", "README.md"],
  hold: ["delete_file *"],
  warn: 0.35,
  pause: 0.6,
  max_turns: 60,
  max_cost_usd: 1,
};

const SUCCESS: { id: string; text: string; check: string | null }[] = [
  { id: "s1", text: "No file under src/ uses require, module.exports or exports.", check: "no-commonjs" },
  { id: "s2", text: "Every relative import points to a file that exists.", check: "imports-resolve" },
  { id: "s3", text: "The service exports the same public functions, with the same number of parameters.", check: "api-unchanged" },
  { id: "s4", text: "The tests are unchanged except for the lines that load modules.", check: "tests-unchanged" },
  { id: "s5", text: "The old entry point src/compat.js is removed.", check: "compat-removed" },
  { id: "s6", text: "The behaviour of the service is unchanged: its tests pass. The hosted job does not run code, so nothing checks this.", check: null },
];

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback);
const clean = (list: unknown, fallback: string[]) => (Array.isArray(list) ? list.filter((s): s is string => typeof s === "string" && s.trim().length > 0 && s.length < 120).map((s) => s.trim()).slice(0, 20) : fallback);

/** Builds a valid charter from what the reader set. Throws CharterInvalid with readable reasons when it cannot. */
export function buildCharter(input: CharterInput = {}, version = 1): Charter {
  const enabled = (id: string) => input.checks?.[id] !== false;
  const custom = (input.custom_checks ?? [])
    .filter((c) => c && typeof c.text === "string" && c.text.trim().length >= 2 && Array.isArray(c.paths) && c.paths.length > 0)
    .slice(0, 5)
    .map((c, i) => ({ id: `custom-${i + 1}`, type: "pattern" as const, paths: clean(c.paths, ["src/**"]), deny: c.text.trim().slice(0, 80), when: "checkpoint" as const, fault: `hosted:plant-text` }));
  const builtIn = CHECKS.filter((c) => enabled(c.id)).map((c) => ({ id: c.id, type: "command" as const, run: `hosted:${c.id}`, when: "checkpoint" as const, fault: `hosted:${c.id}` }));
  const ids = new Set(builtIn.map((c) => c.id));
  const rules = (input.rules ?? DEFAULTS.rules).filter((r) => r && ["goal", "scope", "plan", "evidence"].includes(r.dimension) && typeof r.text === "string" && r.text.trim().length >= 5).slice(0, 12);
  const criteria = (input.criteria ?? []).filter((t) => typeof t === "string" && t.trim().length >= 5).map((t) => t.trim().slice(0, 200)).slice(0, 8);
  const warn = clamp(input.warn, 0.05, 0.95, DEFAULTS.warn);
  const pause = clamp(input.pause, 0.1, 1, DEFAULTS.pause);
  return parseCharter({
    id: "migrate-invoices",
    version,
    goal: (typeof input.goal === "string" && input.goal.trim().length > 0 ? input.goal.trim() : DEFAULTS.goal).slice(0, 400),
    success: [
      ...SUCCESS.map((s) => ({ ...s, check: s.check && ids.has(s.check) ? s.check : null })),
      ...custom.map((c, i) => ({ id: `s-custom-${i + 1}`, text: `No file under ${c.paths.join(", ")} contains "${c.deny}".`, check: c.id })),
      ...criteria.map((text, i) => ({ id: `s-own-${i + 1}`, text, check: null })),
    ],
    scope: { allow_paths: clean(input.allow, DEFAULTS.allow), deny_paths: clean(input.deny, DEFAULTS.deny), allow_commands: [], network: false },
    budget: { max_cost_usd: clamp(input.max_cost_usd, 0.05, 5, DEFAULTS.max_cost_usd), max_turns: Math.round(clamp(input.max_turns, 10, 200, DEFAULTS.max_turns)), max_minutes: 30 },
    stages: STAGES.map((s, i) => ({ id: s.id, title: s.title, description: s.description, exit_checks: [...s.checks.filter((c) => ids.has(c)), ...(i === STAGES.length - 1 ? custom.map((c) => c.id) : [])], ...(s.id === "switch" ? { irreversible: true } : {}) })),
    checks: [...builtIn, ...custom],
    drift_rules: [
      ...rules.map((r, i) => ({ id: `${r.dimension}-${i + 1}`, dimension: r.dimension, source: "operator" as const, text: r.text.trim().slice(0, 300) })),
      ...criteria.map((text, i) => ({ id: `done-${i + 1}`, dimension: "goal" as const, source: "operator" as const, text: `The job is done only when this holds: ${text}` })),
    ],
    thresholds: { warn: Math.min(warn, pause - 0.05), pause },
    irreversible: clean(input.hold, DEFAULTS.hold),
    escalation: { on_pause: "operator" },
  });
}

/** The charter review of the local product, run on the hosted charter, as plain items the page lists. */
export function reviewHosted(charter: Charter): { id: string; message: string }[] {
  return reviewCharter(charter).map((i) => ({ id: i.id, message: i.message }));
}

/** The charter as the Markdown file the page shows in the project, with the machine fields as front matter. */
export function charterMarkdown(charter: Charter): string {
  const list = (items: string[]) => items.map((i) => `  - ${JSON.stringify(i)}`).join("\n");
  return [
    "---",
    `id: ${charter.id}`,
    `version: ${charter.version}`,
    `hash: ${charterHash(charter)}`,
    `thresholds: { warn: ${charter.thresholds.warn}, pause: ${charter.thresholds.pause} }`,
    `budget: { max_turns: ${charter.budget.max_turns}, max_cost_usd: ${charter.budget.max_cost_usd} }`,
    "may_change:",
    list(charter.scope.allow_paths),
    "never:",
    list(charter.scope.deny_paths),
    "waits_for_a_person:",
    list(charter.irreversible),
    "checks:",
    list(charter.checks.map((c) => c.id)),
    "---",
    "",
    "# Goal",
    "",
    charter.goal,
    "",
    "# Done when",
    "",
    ...charter.success.map((s) => `- ${s.text}${s.check ? ` (check: ${s.check})` : " (no check)"}`),
    "",
    "# Stages",
    "",
    ...charter.stages.map((s, i) => `${i + 1}. **${s.title}.** ${s.description ?? ""}`),
    "",
    "# Rules the watcher scores against",
    "",
    ...(["goal", "scope", "plan", "evidence"] as const).flatMap((d) => {
      const own = charter.drift_rules.filter((r) => r.dimension === d);
      return own.length ? [`## ${d[0]?.toUpperCase()}${d.slice(1)}`, "", ...own.map((r) => `- ${r.text}`), ""] : [];
    }),
  ].join("\n");
}
