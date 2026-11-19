const { sql, fail, pass, tableExists } = require("./lib.js");
if (!tableExists("customers_v2")) fail("customers_v2 does not exist");
const dupes = Number(sql("SELECT count(*) FROM (SELECT lower(trim(email)) e FROM customers_v2 GROUP BY e HAVING count(*) > 1)"));
if (dupes > 0) fail(`${dupes} customers appear more than once in customers_v2`);
pass("no customer appears twice in customers_v2");
