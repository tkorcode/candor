const { readFileSync } = require("node:fs");
const { fail, pass, expected } = require("./lib.js");
let report;
try {
  report = JSON.parse(readFileSync("reports/profile.json", "utf8"));
} catch {
  fail("reports/profile.json is missing or is not JSON");
}
if (report.row_count !== expected().row_count) fail(`the recorded row count ${report.row_count} is not the real count`);
pass("the recorded row count matches");
