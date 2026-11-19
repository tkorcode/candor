/**
 * Redaction runs before an entry is hashed or written, so a secret never
 * reaches disk. It is pattern based: it catches common key shapes, bearer
 * tokens, private keys and email addresses, and it cannot catch every secret.
 * The receipt coverage statement says so.
 */
const PATTERNS: Array<[kind: string, pattern: RegExp]> = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["api_key", /\bsk-[A-Za-z0-9_-]{8,}/g],
  ["url_credentials", /(:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/g],
  ["aws_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["bearer_token", /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi],
  ["secret_assignment", /\b([A-Za-z0-9_.-]{0,40}(?:api[_-]?key|secret|token|passw(?:or)?d|operator[_-]?key)[A-Za-z0-9_.-]{0,40}["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi],
  ["email", /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g],
  ["us_ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
];

const SECRET_KEY = /(passw(or)?d|secret|token|api[_-]?key|authorization|private[_-]?key|credential|operator[_-]?key)/i;

export interface Redactor {
  text(input: string): string;
  value<T>(input: T): T;
}

/** `extraSecrets` are exact values, such as the operator secret, that must never be stored. */
export function createRedactor(extraSecrets: readonly string[] = []): Redactor {
  const exact = extraSecrets.filter((secret) => secret.length >= 8);
  const text = (input: string): string => {
    let out = input;
    for (const secret of exact) out = out.split(secret).join("[REDACTED:secret]");
    for (const [kind, pattern] of PATTERNS) {
      out = out.replace(pattern, (_match, prefix: unknown) => `${typeof prefix === "string" ? prefix : ""}[REDACTED:${kind}]`);
    }
    return out;
  };
  const value = <T>(input: T): T => {
    if (typeof input === "string") return text(input) as T;
    if (Array.isArray(input)) return input.map((item) => value(item)) as T;
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input)) out[text(key)] = typeof item === "string" && SECRET_KEY.test(key) ? "[REDACTED:secret_key]" : value(item);
      return out as T;
    }
    return input;
  };
  return { text, value };
}
