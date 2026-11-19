const test = require("node:test");
const assert = require("node:assert");
const { createInvoice, formatInvoice } = require("../src/index");

test("adds lines, discount and tax", () => {
  const invoice = createInvoice({ customer: "Avery", region: "north", code: "spring10", lines: [{ name: "Desk", price: 120, quantity: 1 }, { name: "Lamp", price: 15.5, quantity: 2 }] });
  assert.strictEqual(invoice.subtotal, 15100);
  assert.strictEqual(invoice.discounted, 13590);
  assert.strictEqual(invoice.tax, 1087);
  assert.strictEqual(invoice.total, 14677);
});

test("prints a summary", () => {
  const invoice = createInvoice({ customer: "Blake", region: "west", lines: [{ name: "Chair", price: 40, quantity: 3 }] });
  assert.strictEqual(formatInvoice(invoice), "Invoice for Blake\nChair x3\nSubtotal 120.00\nTax 0.00\nTotal 120.00");
});
