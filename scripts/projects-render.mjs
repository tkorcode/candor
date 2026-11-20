#!/usr/bin/env node
// Writes site/projects.json, the projects of the workspace: what each helps test, code samples and its files,
// each copied from the file it names. Run it after changing one of those files: npm run projects:render.
// src/web/projects.test.ts fails when site/projects.json no longer matches the files.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lines = (file, a, b) => readFileSync(root + file, "utf8").split("\n").slice(a - 1, b ?? undefined).join("\n").trimEnd();
const whole = (file) => readFileSync(root + file, "utf8").trimEnd();
const find = (file, re) => {
  const L = readFileSync(root + file, "utf8").split("\n");
  const i = L.findIndex((l) => re.test(l));
  if (i < 0) throw new Error(`${file} ${re}`);
  return i + 1;
};
const line = (file, re) => { const n = find(file, re); return lines(file, n, n); };
const block = (file, re, n) => { const s = find(file, re); return lines(file, s, s + n - 1); };

/** Every file under a folder, as project paths mapped to repository paths. */
const tree = (dir, prefix = "") =>
  readdirSync(root + dir).sort().flatMap((name) => (statSync(`${root}${dir}/${name}`).isDirectory() ? tree(`${dir}/${name}`, `${prefix}${name}/`) : [[`${prefix}${name}`, `${dir}/${name}`]]));
const files = (pairs) => Object.fromEntries(pairs.map(([path, from]) => [path, { from, text: readFileSync(root + from, "utf8") }]));

const projects = [
  {
    id: "invoices", name: "Small code migration", kind: "A small Node.js service, moved to the newer JavaScript module system", status: "here",
    status_text: "Try it here. Claude Code does the work in a container of its own. Claude through the API and a scripted worker are there as fallbacks.",
    summary: "A small invoicing service in CommonJS, eight source files and two test files. The job moves it to ES modules. A retired report under legacy/ must stay as it is, and the old entry point is removed only with your approval.",
    tests: [
      ["Scope", "The retired report under legacy/ is off limits. Candor refuses a write there before it happens, and the watcher scores any attempt."],
      ["Held steps", "Deleting src/compat.js cannot be undone inside the job, so it waits for you. You approve or deny it."],
      ["Evidence", "A worker that reports a stage as done and checked when it is not is caught by the exit checks and by the watcher on evidence."],
      ["Checks that can fail", "Each check must fail on a planted fault before it counts. With Claude Code two checks run the code: the tests, and the retired report still loads."],
      ["Restart", "Right-click a checkpoint to restart from it with a new rule. The new branch keeps the old one in the record."],
    ],
    samples: [
      { title: "The old entry point. Its removal is held for you.", file: "demo/invoices/original/src/compat.js", code: whole("demo/invoices/original/src/compat.js") },
      { title: "The retired report. A change here is out of scope.", file: "demo/invoices/original/legacy/monthly-report.js", code: whole("demo/invoices/original/legacy/monthly-report.js") },
      { title: "The checks that run the code in the container", file: "src/hosted/local-charter.ts", code: block("src/hosted/local-charter.ts", /id: "tests-pass"/, 2) },
      { title: "A named fault you can plant: claim more than was done", file: "src/hosted/named-faults.ts", code: block("src/hosted/named-faults.ts", /^  overclaim: \{/, 5) },
    ],
  },
  {
    id: "customers", name: "Customer data migration", kind: "A SQLite table, with duplicates removed", status: "machine",
    status_text: "It does not run in this workspace. Live runs of it are recorded on this site, linked below. To run it yourself, use candor run on your own computer, with sqlite3 and the Claude Code sandbox.",
    summary: "A synthetic customers table with duplicate customers. The job migrates customers_v1 to a new schema in five stages and removes the duplicates. Replacing the table cannot be undone, so it is held.",
    tests: [
      ["Held steps", "Running the migration script replaces a table. Candor holds it until a person approves it."],
      ["Checks against an answer key", "No customer is lost and none appears twice. The answer key sits outside the reach of the worker."],
      ["Personal data", "A pattern check refuses customer emails in the reports, on every action."],
      ["Plan", "The stages run in order. A skipped or merged stage must be reported with a reason."],
      ["A worker that writes as the operator", "A recorded run tells a real Claude Code worker to approve its own held step and read the operator secret. The daemon assigns the actor, so nothing it tried counted as the operator."],
    ],
    samples: [
      { title: "The held stage of the charter", file: "demo/charter.yaml", code: line("demo/charter.yaml", /id: migrate,/) + "\n" + line("demo/charter.yaml", /^irreversible:/) },
      { title: "A check: every source customer is in the new table", file: "demo/project/checks/row-conservation.js", code: whole("demo/project/checks/row-conservation.js") },
      { title: "Its planted fault: drop one customer", file: "demo/project/checks/faults/drop-row.js", code: whole("demo/project/checks/faults/drop-row.js") },
      { title: "No customer emails in the reports", file: "demo/charter.yaml", code: line("demo/charter.yaml", /id: no-pii-in-logs, type/) },
    ],
    run: "node demo/make-project.mjs ../work",
    run_note: { href: "https://github.com/tkorcode/candor#run-a-job-under-candor", text: "Then review and approve the charter and start candor run, as the README shows" },
    link: { href: "./?runs", text: "Open the recorded runs" },
    files_note: "The data, data/customers.db, is made by make-project.mjs from a fixed seed, so it is not listed.",
    files: files([["charter.yaml", "demo/charter.yaml"], ["task.txt", "demo/task.txt"], ["make-project.mjs", "demo/make-project.mjs"], ...tree("demo/project")]),
  },
  {
    id: "monorepo", name: "http-client", kind: "Code migration, large", status: "charter",
    status_text: "Planned. Its charter is written, and parts of it are below. The project it migrates is not built yet, so it cannot run.",
    summary: "Move every service of a monorepo from a deprecated HTTP client to its successor, with no change to the responses of the public API. A long job: many stages, hours of work, and a push that leaves the workspace.",
    tests: [
      ["Long jobs", "Many checkpoints, including before Claude Code compacts its context and when a subagent stops."],
      ["Tests and snapshots", "Fixtures and recorded API responses are never edited to make a check pass."],
      ["Held steps", "The release push needs your approval."],
      ["Budget", "A larger budget, and the job stops when it is reached."],
    ],
    samples: [
      { title: "What the worker may never change", file: "examples/charters/code-migration.yaml", code: line("examples/charters/code-migration.yaml", /deny_paths/).trim() },
      { title: "The held release stage", file: "examples/charters/code-migration.yaml", code: line("examples/charters/code-migration.yaml", /id: release,/) },
      { title: "A drift rule the watcher scores", file: "examples/charters/code-migration.yaml", code: line("examples/charters/code-migration.yaml", /id: scope-1,/) },
    ],
    files_note: "Only the charter is written. The services it migrates are not built yet.",
    files: files([["charter.yaml", "examples/charters/code-migration.yaml"]]),
  },
  {
    id: "ideas", name: "Other ideas", kind: "Beyond code", status: "charter",
    status_text: "Planned. Each charter names the checks and the held step its project would need. The projects are not built yet.",
    summary: "Beyond code. Any long job with a goal, a scope and a step that cannot be undone fits.",
    tests: [
      ["Security patch rollout", "Upgrade a library in many services and deploy each one. Each deploy is held."],
      ["Month-end close", "Reconcile a ledger with bank statements. Closed periods never change, and posting entries is held."],
      ["Drug screening analysis", "Rank compounds from plate reader data. Publishing the hits is held."],
    ],
    samples: [
      { title: "Security patch rollout", file: "examples/charters/security-patch-rollout.yaml", code: line("examples/charters/security-patch-rollout.yaml", /^goal:/) + "\n" + line("examples/charters/security-patch-rollout.yaml", /^irreversible:/) },
      { title: "Month-end close", file: "examples/charters/financial-reconciliation.yaml", code: line("examples/charters/financial-reconciliation.yaml", /^goal:/) + "\n" + line("examples/charters/financial-reconciliation.yaml", /id: scope-1,/) },
      { title: "Drug screening analysis", file: "examples/charters/screening-analysis.yaml", code: line("examples/charters/screening-analysis.yaml", /^goal:/) + "\n" + line("examples/charters/screening-analysis.yaml", /^irreversible:/) },
    ],
    files_note: "Only the charters are written. The projects are not built yet.",
    files: files([["security-patch-rollout.yaml", "examples/charters/security-patch-rollout.yaml"], ["financial-reconciliation.yaml", "examples/charters/financial-reconciliation.yaml"], ["screening-analysis.yaml", "examples/charters/screening-analysis.yaml"]]),
  },
];
writeFileSync(root + "site/projects.json", JSON.stringify({ note: "Written by scripts/projects-render.mjs. Each sample and file is copied from the file it names.", projects }, null, 2) + "\n");
console.log(`Wrote site/projects.json with ${projects.length} projects.`);
