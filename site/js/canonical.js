// Canonical JSON and SHA-256, exactly as src/core/canonical.ts computes them, so the browser
// re-derives the same hashes as `candor verify`. Keys are sorted, undefined values are left out,
// and there is no insignificant whitespace.

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

/** `sha256:<hex>` of the canonical JSON of a value, the digest used for ledger entries. */
export async function digest(value) {
  return `sha256:${await sha256Hex(canonicalJson(value))}`;
}
