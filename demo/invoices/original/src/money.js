// Money is kept in whole cents so that sums never drift.
function toCents(amount) {
  return Math.round(amount * 100);
}

function fromCents(cents) {
  return cents / 100;
}

function addCents(a, b) {
  return a + b;
}

function multiplyCents(cents, factor) {
  return Math.round(cents * factor);
}

module.exports = { toCents, fromCents, addCents, multiplyCents };
