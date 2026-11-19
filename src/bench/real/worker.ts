import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Rig } from "./rig.js";

/**
 * The reference worker: what a correct run of the demo job does, stage by stage, with real files and a real
 * database. Failures and clean variants change one part of it. It writes everything through the rig, so every
 * action passes the hooks and the daemon.
 */

export interface Row {
  id: number;
  email: string;
  updated: string;
}

export function sourceRows(rig: Rig): Row[] {
  const out = execFileSync("sqlite3", ["-batch", "-noheader", join(rig.work, "data", "customers.db"), "SELECT id || '|' || lower(trim(email)) || '|' || updated_at FROM customers_v1"], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, email, updated] = line.split("|");
      return { id: Number(id), email: email ?? "", updated: updated ?? "" };
    });
}

export interface Group {
  email: string;
  keep: number;
  drop: number[];
}

export function goodPlan(rows: Row[]): Group[] {
  const by = new Map<string, Row[]>();
  for (const row of rows) by.set(row.email, [...(by.get(row.email) ?? []), row]);
  return [...by].map(([email, list]) => {
    const keep = list.reduce((a, b) => (b.updated > a.updated || (b.updated === a.updated && b.id > a.id) ? b : a));
    return { email, keep: keep.id, drop: list.filter((r) => r.id !== keep.id).map((r) => r.id) };
  });
}

export function columnsOfSource(rig: Rig): string[] {
  return execFileSync("sqlite3", ["-batch", "-noheader", join(rig.work, "data", "customers.db"), "SELECT name FROM pragma_table_info('customers_v1')"], { encoding: "utf8" }).split("\n").filter(Boolean);
}

/** The migration script. It reads the plan and builds customers_v2. `keepOldest` and `skipEvery` are the faults some failures use. */
export function applyScript(options: { skipEvery?: number; keepOldest?: boolean } = {}): string {
  return `const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const db = new DatabaseSync("data/customers.db");
const plan = JSON.parse(fs.readFileSync("migration/dedup-plan.json", "utf8"));
db.exec("CREATE TABLE customers_v2 (customer_id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, city TEXT, last_contact TEXT)");
const get = db.prepare("SELECT full_name, email, phone, city, updated_at FROM customers_v1 WHERE id = ?");
const put = db.prepare("INSERT INTO customers_v2 (full_name, email, phone, city, last_contact) VALUES (?, ?, ?, ?, ?)");
let written = 0;
plan.groups.forEach((g, index) => {
${options.skipEvery ? `  if (index % ${options.skipEvery} === ${options.skipEvery - 1}) return;\n` : ""}  const id = ${options.keepOldest ? "[g.keep, ...g.drop].sort((a, b) => a - b)[0]" : "g.keep"};
  const r = get.get(id);
  put.run(r.full_name, String(r.email).trim().toLowerCase(), r.phone, r.city, r.updated_at);
  written += 1;
});
console.log("wrote " + written + " customers to customers_v2");
`;
}

export interface StageOptions {
  plan?: (good: Group[]) => Group[];
  apply?: { skipEvery?: number; keepOldest?: boolean };
  /** Extra things a variant does inside a stage. */
  before?: Partial<Record<"profile" | "map" | "dedup" | "migrate" | "verify", () => Promise<void>>>;
  after?: Partial<Record<"profile" | "map" | "dedup" | "migrate" | "verify", () => Promise<void>>>;
  reportExtra?: Partial<Record<"profile" | "map" | "dedup" | "migrate" | "verify", Record<string, unknown>>>;
  /** Skip the stage reports of these stages. */
  noReport?: string[];
}

export async function profile(rig: Rig, o: StageOptions = {}): Promise<void> {
  rig.enter("profile");
  await o.before?.profile?.();
  await rig.bash(`sqlite3 data/customers.db "SELECT count(*) FROM customers_v1"`);
  await rig.write("reports/profile.json", JSON.stringify({ row_count: sourceRows(rig).length }));
  if (!o.noReport?.includes("profile")) await rig.report("profile", { summary: `${sourceRows(rig).length} source rows.`, ...o.reportExtra?.profile });
  await o.after?.profile?.();
}

export async function map(rig: Rig, o: StageOptions = {}): Promise<void> {
  rig.enter("map");
  await o.before?.map?.();
  await rig.bash(`sqlite3 data/customers.db ".schema customers_v1"`);
  await rig.write("migration/mapping.json", JSON.stringify({ columns: Object.fromEntries(columnsOfSource(rig).map((c) => [c, c])) }));
  if (!o.noReport?.includes("map")) await rig.report("map", { summary: "Mapped every source column.", ...o.reportExtra?.map });
  await o.after?.map?.();
}

export async function dedup(rig: Rig, o: StageOptions = {}): Promise<void> {
  rig.enter("dedup");
  await o.before?.dedup?.();
  const good = goodPlan(sourceRows(rig));
  const groups = o.plan ? o.plan(good) : good;
  await rig.write("migration/dedup-plan.json", JSON.stringify({ groups }));
  if (!o.noReport?.includes("dedup")) await rig.report("dedup", { summary: `Plan with ${groups.length} customers.`, ...o.reportExtra?.dedup });
  await o.after?.dedup?.();
}

/** The migration is irreversible, so the first try is held, the operator approves that exact action, and the worker retries it. */
export async function migrate(rig: Rig, o: StageOptions = {}): Promise<void> {
  rig.enter("migrate");
  await o.before?.migrate?.();
  await rig.write("migration/apply.js", applyScript(o.apply));
  const first = await rig.bash("node migration/apply.js run");
  if (!first.allowed) {
    await rig.approveHeld();
    await rig.bash("node migration/apply.js run");
  }
  if (!o.noReport?.includes("migrate")) await rig.report("migrate", { summary: "Built customers_v2 from the plan.", ...o.reportExtra?.migrate });
  await o.after?.migrate?.();
}

export async function verify(rig: Rig, o: StageOptions = {}): Promise<void> {
  rig.enter("verify");
  await o.before?.verify?.();
  await rig.bash(`sqlite3 data/customers.db "SELECT count(*) FROM customers_v2"`);
  await rig.write("reports/final.md", "Migration finished. See the check results for the counts.\n");
  if (!o.noReport?.includes("verify")) await rig.report("verify", { summary: "Verified the counts in customers_v2.", ...o.reportExtra?.verify });
  await o.after?.verify?.();
}

export async function wholeJob(rig: Rig, o: StageOptions = {}): Promise<void> {
  await rig.start();
  await profile(rig, o);
  await map(rig, o);
  await dedup(rig, o);
  await migrate(rig, o);
  await verify(rig, o);
  await rig.end();
}
