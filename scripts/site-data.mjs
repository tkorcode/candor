#!/usr/bin/env node
// Copies recorded runs from results/ into site/runs/<run>/ for the hosted console, unchanged, so the browser
// verifies the same files `candor verify` does. Writes site/runs/index.json, read from those files.
// Usage: node scripts/site-data.mjs
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "site", "runs");

/** The runs the console shows, in order. `receipt` is the folder that holds the signed receipt and its ledger copy. */
const RUNS = [
  { folder: "results/runs/2026-11-18-rule-change-and-restart", receipt: "receipt" },
  { folder: "results/runs/2026-11-18-watched-migration", receipt: "receipt" },
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const index = [];
for (const run of RUNS) {
  const base = join(root, run.folder);
  const from = join(base, run.receipt);
  const receipt = JSON.parse(readFileSync(join(from, "receipt.json"), "utf8"));
  const id = receipt.run;
  const target = join(out, id);
  mkdirSync(target, { recursive: true });
  for (const name of ["ledger.jsonl", "anchors.jsonl", "receipt.json"]) cpSync(join(from, name), join(target, name));
  if (existsSync(join(from, "blobs"))) cpSync(join(from, "blobs"), join(target, "blobs"), { recursive: true });
  const charters = readdirSync(base)
    .filter((name) => /^charter\.v\d+\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(base, name), "utf8")))
    .sort((a, b) => a.version - b.version);
  writeFileSync(join(target, "charters.json"), `${JSON.stringify(charters, null, 1)}\n`);
  const lines = readFileSync(join(from, "ledger.jsonl"), "utf8").split("\n").filter(Boolean);
  const first = JSON.parse(lines[0]);
  const readme = existsSync(join(base, "README.md")) ? readFileSync(join(base, "README.md"), "utf8").split("\n")[0].replace(/^#\s*/, "") : id;
  index.push({ id, title: readme, label: receipt.label, started: first.ts, entries: lines.length, source: run.folder });
}
writeFileSync(join(out, "index.json"), `${JSON.stringify(index, null, 1)}\n`);
console.log(`Copied ${index.length} runs to ${out}`);

// What each stage of the demo is for, from the current demo charter, for runs recorded before stages had descriptions.
const { parse } = await import("yaml");
const demo = parse(readFileSync(join(root, "demo", "charter.yaml"), "utf8"));
writeFileSync(join(out, "stage-guide.json"), `${JSON.stringify(demo.stages.map((st) => ({ id: st.id, title: st.title, description: st.description ?? null })), null, 1)}\n`);
