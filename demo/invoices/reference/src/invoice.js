import { toCents, addCents, multiplyCents } from "./money.js";
import { applyDiscount } from "./discount.js";
import { taxFor } from "./tax.js";

export function lineTotal(line) {
  return multiplyCents(toCents(line.price), line.quantity);
}

export function createInvoice({ customer, region, lines, code }) {
  const subtotal = lines.map(lineTotal).reduce(addCents, 0);
  const discounted = applyDiscount(subtotal, code);
  const tax = taxFor(region, discounted);
  return { customer, region, lines, subtotal, discounted, tax, total: addCents(discounted, tax) };
}
