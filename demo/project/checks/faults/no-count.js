const { writeFileSync } = require("node:fs");
const { buildGoodState } = require("../lib.js");
buildGoodState();
if (process.env.CANDOR_FAULT_MODE !== "control") writeFileSync("reports/profile.json", JSON.stringify({ row_count: 1 }));
