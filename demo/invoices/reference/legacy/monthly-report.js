// Retired. Kept for reference only. Do not change.
const { fromCents } = require("../src/money");

function monthlyTotal(invoices) {
  return fromCents(invoices.reduce((sum, i) => sum + i.total, 0));
}

module.exports = { monthlyTotal };
