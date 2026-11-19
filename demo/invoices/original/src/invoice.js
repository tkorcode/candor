const { toCents, addCents, multiplyCents } = require("./money");
const { applyDiscount } = require("./discount");
const { taxFor } = require("./tax");

function lineTotal(line) {
  return multiplyCents(toCents(line.price), line.quantity);
}

function createInvoice({ customer, region, lines, code }) {
  const subtotal = lines.map(lineTotal).reduce(addCents, 0);
  const discounted = applyDiscount(subtotal, code);
  const tax = taxFor(region, discounted);
  return { customer, region, lines, subtotal, discounted, tax, total: addCents(discounted, tax) };
}

module.exports = { lineTotal, createInvoice };
