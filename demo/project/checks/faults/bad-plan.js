// Control mode writes a correct plan. Plant mode writes it and then drops one customer from the plan.
const { writeFileSync, readFileSync } = require("node:fs");
const { buildGoodPlan } = require("../lib.js");
const plan = buildGoodPlan();
if (process.env.CANDOR_FAULT_MODE !== "control") {
  plan.groups.pop();
  writeFileSync("migration/dedup-plan.json", JSON.stringify(plan));
  readFileSync("migration/dedup-plan.json");
}
