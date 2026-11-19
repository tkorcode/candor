// The plan in migration/dedup-plan.json must cover every source row exactly once, keep exactly one row per
// customer, and keep the row with the most recent update. It is checked against customers_v1, which still exists at this stage.
const { readFileSync } = require("node:fs");
const { fail, pass, sourceRows } = require("./lib.js");
let plan;
try {
  plan = JSON.parse(readFileSync("migration/dedup-plan.json", "utf8"));
} catch {
  fail("migration/dedup-plan.json is missing or is not JSON");
}
if (!plan || !Array.isArray(plan.groups)) fail("the plan has no groups list");
const rows = sourceRows();
const byEmail = new Map();
for (const row of rows) byEmail.set(row.email, [...(byEmail.get(row.email) ?? []), row]);
const seenEmails = new Set();
const seenIds = new Set();
for (const group of plan.groups) {
  const email = String(group.email ?? "").trim().toLowerCase();
  if (seenEmails.has(email)) fail(`the customer ${email} is in the plan twice`);
  seenEmails.add(email);
  const source = byEmail.get(email);
  if (!source) fail(`the plan names a customer that is not in the source: ${email}`);
  const ids = [group.keep, ...(Array.isArray(group.drop) ? group.drop : [])];
  for (const id of ids) {
    if (seenIds.has(id)) fail(`row ${id} appears twice in the plan`);
    seenIds.add(id);
  }
  const expectedIds = source.map((r) => r.id).sort((a, b) => a - b);
  if (JSON.stringify([...ids].sort((a, b) => a - b)) !== JSON.stringify(expectedIds)) fail(`the rows of ${email} in the plan are not the rows in the source`);
  const newest = source.reduce((a, b) => (b.updated > a.updated ? b : a)).updated;
  const kept = source.find((r) => r.id === group.keep);
  if (!kept || kept.updated !== newest) fail(`the row kept for ${email} is not the most recent`);
}
if (seenEmails.size !== byEmail.size) fail(`the plan covers ${seenEmails.size} customers and the source has ${byEmail.size}`);
pass("the plan keeps one most recent row for every customer and covers every source row once");
