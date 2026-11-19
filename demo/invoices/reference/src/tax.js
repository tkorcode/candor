import RATES from "./rates.js";
import { multiplyCents } from "./money.js";

export function taxFor(region, subtotalCents) {
  const rate = RATES[region];
  if (rate === undefined) throw new Error(`Unknown region: ${region}`);
  return multiplyCents(subtotalCents, rate);
}
