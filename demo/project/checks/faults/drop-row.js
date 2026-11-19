// Control mode builds a correct customers_v2. Plant mode builds it and drops one customer.
const { buildGoodState, sql } = require("../lib.js");
buildGoodState();
if (process.env.CANDOR_FAULT_MODE !== "control") sql("DELETE FROM customers_v2 WHERE customer_id = (SELECT min(customer_id) FROM customers_v2)");
