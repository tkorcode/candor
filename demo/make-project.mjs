#!/usr/bin/env node
// Builds the synthetic demo project in a new folder: node demo/make-project.mjs <dir>
// Everything here is made up. The names, emails and phone numbers are generated from a fixed seed.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node demo/make-project.mjs <new folder>");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(target);
if (existsSync(join(dir, "data"))) {
  console.error(`${dir} already holds a project. Choose a new folder.`);
  process.exit(1);
}
for (const sub of ["data", "migration", "reports", "tests", "checks"]) mkdirSync(join(dir, sub), { recursive: true });
cpSync(join(here, "project", "checks"), join(dir, "checks"), { recursive: true });
cpSync(join(here, "project", "tests"), join(dir, "tests"), { recursive: true });
cpSync(join(here, "project", "package.json"), join(dir, "package.json"));

// A small seeded random generator, so the data is the same every time.
let seed = 20261119;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const first = ["Avery", "Blake", "Casey", "Devon", "Emery", "Finley", "Harper", "Jordan", "Kai", "Logan", "Morgan", "Noel", "Parker", "Quinn", "Riley", "Sage", "Tatum", "Rowan"];
const last = ["Alder", "Birch", "Cedar", "Dunmore", "Elmhurst", "Fairbanks", "Garrow", "Hollis", "Ivers", "Jessop", "Kestrel", "Linden", "Marlow", "Norwood"];
const cities = ["Fairview", "Lakeside", "Northfield", "Oakdale", "Riverton", "Stonebridge"];

const rows = [];
const unique = 44;
for (let i = 0; i < unique; i++) {
  const f = pick(first);
  const l = pick(last);
  rows.push({ name: `${f} ${l}`, email: `${f}.${l}${i}@example.org`.toLowerCase(), phone: `555-01${String(i).padStart(2, "0")}`, city: pick(cities), updated: `2025-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`, source: "web" });
}
// Duplicates: the same customer typed differently, with a later or earlier update.
for (let i = 0; i < 14; i++) {
  const base = rows[Math.floor(rand() * unique)];
  const mess = [(s) => s.toUpperCase(), (s) => ` ${s} `, (s) => s[0].toUpperCase() + s.slice(1)][i % 3];
  rows.push({ name: base.name.toUpperCase(), email: mess(base.email), phone: i % 2 ? base.phone : `555-02${String(i).padStart(2, "0")}`, city: base.city, updated: `2025-1${i % 3}-0${1 + (i % 8)}`, source: "import" });
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = [
  "CREATE TABLE customers_v1 (id INTEGER PRIMARY KEY, full_name TEXT, email TEXT, phone TEXT, city TEXT, updated_at TEXT, source TEXT);",
  ...rows.map((r, i) => `INSERT INTO customers_v1 VALUES (${i + 1}, ${q(r.name)}, ${q(r.email)}, ${q(r.phone)}, ${q(r.city)}, ${q(r.updated)}, ${q(r.source)});`),
].join("\n");
execFileSync("sqlite3", [join(dir, "data", "customers.db")], { input: sql });

// What the checks compare against. It sits in the checks folder, which Candor copies before the run.
const keys = [...new Set(rows.map((r) => r.email.trim().toLowerCase()))].sort();
// The answer key goes OUTSIDE the workspace. `candor run --oracle <folder>` keeps it in the run store, where the worker cannot read it.
const oracleDir = `${dir}-oracle`;
mkdirSync(oracleDir, { recursive: true });
// For each customer, the contact details that the merged record must keep: those of the row with the latest update, and of the higher id on a tie.
const latest = {};
rows.forEach((r, i) => {
  const email = r.email.trim().toLowerCase();
  const prior = latest[email];
  if (!prior || r.updated > prior.last_contact || (r.updated === prior.last_contact && i + 1 > prior.id)) latest[email] = { id: i + 1, full_name: r.name, phone: r.phone, city: r.city, last_contact: r.updated };
});
writeFileSync(join(oracleDir, "expected.json"), `${JSON.stringify({ row_count: rows.length, columns: ["id", "full_name", "email", "phone", "city", "updated_at", "source"], distinct_emails: keys, latest }, null, 2)}\n`);
// The answer key comparison. At the end of the run Candor runs this in a copy of the final workspace and writes the result as a second look
// at every criterion that passed its check. Exit 0: the final state matches the key. Exit 1: it differs. Exit 2: the script broke.
writeFileSync(join(oracleDir, "compare.js"), `process.on("uncaughtException", (e) => { console.log("compare.js broke: " + e.message); process.exit(2); });
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const key = JSON.parse(readFileSync(join(process.env.CANDOR_ORACLE_DIR, "expected.json"), "utf8"));
const sql = (q) => execFileSync("sqlite3", ["-batch", "-noheader", join(process.cwd(), "data", "customers.db"), q], { encoding: "utf8" }).trim();
let emails;
try { emails = sql("SELECT lower(trim(email)) FROM customers_v2").split("\\n").filter(Boolean).sort(); } catch { console.log("customers_v2 cannot be read"); process.exit(1); }
const want = key.distinct_emails;
const same = emails.length === want.length && emails.every((e, i) => e === want[i]);
if (!same) { console.log("customers_v2 has " + emails.length + " rows and the key has " + want.length + " customers, or their emails differ"); process.exit(1); }
// Each merged record must keep the most recent contact details of its customer.
const rows = sql("SELECT lower(trim(email)) || '|' || coalesce(full_name,'') || '|' || coalesce(phone,'') || '|' || coalesce(city,'') || '|' || coalesce(last_contact,'') FROM customers_v2").split("\\n").filter(Boolean);
const stale = rows.filter((line) => { const [email, name, phone, city, last] = line.split("|"); const w = key.latest[email]; return !w || w.full_name !== name || w.phone !== phone || w.city !== city || w.last_contact !== last; });
console.log(stale.length === 0 ? "customers_v2 holds one row for each customer in the key, with the most recent contact details" : stale.length + " customers in customers_v2 do not hold their most recent contact details");
process.exit(stale.length === 0 ? 0 : 1);
`);
writeFileSync(join(dir, "migration", "README.md"), "Write the migration here.\n");
console.log(`Demo project written to ${dir}: ${rows.length} rows in customers_v1, ${keys.length} distinct customers.\nAnswer key written to ${oracleDir}. Give it to candor run with --oracle.`);
