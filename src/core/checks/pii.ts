/** Named personal data patterns for charter checks. A check can also give its own pattern as `regex:<source>`. */
const NAMED: Record<string, RegExp> = {
  // Every part is bounded, so a long file with no @ cannot make the match slow.
  email: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  phone: /\b\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/,
};

export function personalDataPattern(name: string): RegExp {
  if (name.startsWith("regex:")) return new RegExp(name.slice(6));
  const known = NAMED[name];
  if (!known) throw new Error(`The pattern ${name} is not known. Use email, ssn, phone, or regex:<source>.`);
  return known;
}

