const { multiplyCents } = require("./money");

// A discount code takes a percentage off the subtotal. Codes are case insensitive.
const CODES = { SPRING10: 0.1, LOYAL5: 0.05 };

function applyDiscount(subtotalCents, code) {
  if (!code) return subtotalCents;
  const off = CODES[code.toUpperCase()];
  if (off === undefined) return subtotalCents;
  return subtotalCents - multiplyCents(subtotalCents, off);
}

module.exports = { applyDiscount };
