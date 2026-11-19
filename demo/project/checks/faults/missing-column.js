const { writeFileSync } = require("node:fs");
const { buildGoodState, expected } = require("../lib.js");
buildGoodState();
if (process.env.CANDOR_FAULT_MODE !== "control") {
  const columns = Object.fromEntries(expected().columns.slice(1).map((c) => [c, c]));
  writeFileSync("migration/mapping.json", JSON.stringify({ columns }));
}
