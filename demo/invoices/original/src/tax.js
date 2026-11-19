const RATES = require("./rates");
const { multiplyCents } = require("./money");

function taxFor(region, subtotalCents) {
  const rate = RATES[region];
  if (rate === undefined) throw new Error(`Unknown region: ${region}`);
  return multiplyCents(subtotalCents, rate);
}

module.exports = { taxFor };
