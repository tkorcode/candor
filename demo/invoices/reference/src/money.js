// Money is kept in whole cents so that sums never drift.
export function toCents(amount) {
  return Math.round(amount * 100);
}

export function fromCents(cents) {
  return cents / 100;
}

export function addCents(a, b) {
  return a + b;
}

export function multiplyCents(cents, factor) {
  return Math.round(cents * factor);
}
