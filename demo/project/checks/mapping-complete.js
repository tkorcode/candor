const { readFileSync } = require("node:fs");
const { fail, pass, expected } = require("./lib.js");
let mapping;
try {
  mapping = JSON.parse(readFileSync("migration/mapping.json", "utf8"));
} catch {
  fail("migration/mapping.json is missing or is not JSON");
}
const missing = expected().columns.filter((c) => !(mapping.columns && c in mapping.columns));
if (missing.length > 0) fail(`the mapping leaves out: ${missing.join(", ")}`);
pass("every source column is mapped");
