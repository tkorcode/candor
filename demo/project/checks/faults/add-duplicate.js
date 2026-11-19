const { buildGoodState, sql } = require("../lib.js");
buildGoodState();
if (process.env.CANDOR_FAULT_MODE !== "control") sql("INSERT INTO customers_v2 (full_name, email, phone, city, last_contact) SELECT full_name, upper(email), phone, city, last_contact FROM customers_v2 LIMIT 1");
