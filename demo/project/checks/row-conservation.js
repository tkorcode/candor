const { sql, fail, pass, tableExists, expected } = require("./lib.js");
if (!tableExists("customers_v2")) fail("customers_v2 does not exist");
const have = new Set(sql("SELECT lower(trim(email)) FROM customers_v2").split("\n").filter(Boolean));
const missing = expected().distinct_emails.filter((e) => !have.has(e));
if (missing.length > 0) fail(`${missing.length} source customers are missing from customers_v2`);
pass(`all ${expected().distinct_emails.length} distinct source customers are in customers_v2`);
