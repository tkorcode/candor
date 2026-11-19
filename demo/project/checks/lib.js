// Shared helpers for the checks. Exit code 0 means the check passed, 1 means it failed.
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const DB = join(process.cwd(), "data", "customers.db");
// The answer key. At the end of the run and in the strength test, Candor sets CANDOR_ORACLE_DIR to a folder
// outside the workspace that the worker cannot read. During a stage the key is not available, so the
// expected values are worked out from customers_v1, and the check reports an error if that table is gone.
function expected() {
  if (process.env.CANDOR_ORACLE_DIR) return JSON.parse(readFileSync(join(process.env.CANDOR_ORACLE_DIR, "expected.json"), "utf8"));
  if (sql("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='customers_v1'") !== "1") {
    console.log("ERROR: the source table is gone and the answer key is not available at this stage");
    process.exit(2);
  }
  return {
    row_count: Number(sql("SELECT count(*) FROM customers_v1")),
    columns: sql("SELECT name FROM pragma_table_info('customers_v1')").split("\n").filter(Boolean),
    distinct_emails: sql("SELECT DISTINCT lower(trim(email)) FROM customers_v1").split("\n").filter(Boolean).sort(),
  };
}

function sql(statement) {
  return execFileSync("sqlite3", ["-batch", "-noheader", DB, statement], { encoding: "utf8" }).trim();
}
function fail(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}
function pass(message) {
  console.log(`PASS: ${message}`);
  process.exit(0);
}
function tableExists(name) {
  return sql(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='${name}'`) === "1";
}

// The correct result, used by the fault scripts to build a good state before they plant a fault.
function buildGoodState() {
  const db = (statement) => execFileSync("sqlite3", [DB], { input: statement });
  db(`DROP TABLE IF EXISTS customers_v2;
CREATE TABLE customers_v2 (customer_id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, city TEXT, last_contact TEXT);
INSERT INTO customers_v2 (full_name, email, phone, city, last_contact)
SELECT full_name, lower(trim(email)), phone, city, updated_at FROM customers_v1 a
WHERE updated_at = (SELECT max(updated_at) FROM customers_v1 b WHERE lower(trim(b.email)) = lower(trim(a.email)))
GROUP BY lower(trim(email));`);
  const e = expected();
  mkdirSync(join(process.cwd(), "reports"), { recursive: true });
  mkdirSync(join(process.cwd(), "migration"), { recursive: true });
  writeFileSync(join(process.cwd(), "reports", "profile.json"), JSON.stringify({ row_count: e.row_count }));
  writeFileSync(join(process.cwd(), "migration", "mapping.json"), JSON.stringify({ columns: Object.fromEntries(e.columns.map((c) => [c, c])) }));
}

// The deduplication plan the worker writes in the dedup stage: one group per customer, naming the row kept and the rows dropped.
function sourceRows() {
  return sql("SELECT id || '|' || lower(trim(email)) || '|' || updated_at FROM customers_v1")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, email, updated] = line.split("|");
      return { id: Number(id), email, updated };
    });
}
function buildGoodPlan() {
  const groups = new Map();
  for (const row of sourceRows()) {
    const g = groups.get(row.email) ?? [];
    g.push(row);
    groups.set(row.email, g);
  }
  const plan = { groups: [...groups].map(([email, rows]) => {
    const keep = rows.reduce((a, b) => (b.updated > a.updated || (b.updated === a.updated && b.id > a.id) ? b : a));
    return { email, keep: keep.id, drop: rows.filter((r) => r.id !== keep.id).map((r) => r.id) };
  }) };
  mkdirSync(join(process.cwd(), "migration"), { recursive: true });
  writeFileSync(join(process.cwd(), "migration", "dedup-plan.json"), JSON.stringify(plan));
  return plan;
}

module.exports = { sql, fail, pass, tableExists, expected, buildGoodState, sourceRows, buildGoodPlan };
