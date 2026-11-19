/**
 * Small glob matcher for charter scope. Path patterns follow the usual rules: `*` stays inside one
 * folder, `**` crosses folders, and a pattern with no slash matches a file name at any depth.
 * Command patterns are anchored, and `*` matches anything, including spaces.
 */

const escapeRe = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

export function pathPatternToRegExp(pattern: string): RegExp {
  let rest = pattern.replace(/^\.\//, "");
  const anyDepth = !rest.includes("/");
  let out = "";
  if (rest.endsWith("/**")) {
    rest = rest.slice(0, -3);
    out = `${translate(rest)}(?:/.*)?`;
  } else out = translate(rest);
  return new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${out}$`, "s");
}

function translate(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += escapeRe(c);
  }
  return out;
}

export function matchesPath(patterns: readonly string[], relativePath: string): boolean {
  const rel = relativePath.split("\\").join("/").replace(/^\.\//, "");
  return patterns.some((pattern) => pathPatternToRegExp(pattern).test(rel));
}

export const squeeze = (text: string): string => text.trim().replace(/\s+/g, " ");

export function commandPatternToRegExp(pattern: string): RegExp {
  const body = squeeze(pattern)
    .split("*")
    .map((part) => escapeRe(part))
    .join(".*");
  return new RegExp(`^${body}$`, "s");
}

export function matchesCommand(patterns: readonly string[], command: string): boolean {
  const text = squeeze(command);
  return patterns.some((pattern) => commandPatternToRegExp(pattern).test(text));
}

/** An irreversible pattern matches anywhere in the text, ignoring case, so `DROP TABLE *` finds a statement inside a longer command. */
export function containsPattern(patterns: readonly string[], text: string): string | null {
  // SQL comments and doubled or dotted path parts are removed first, so DROP /* x */ TABLE and migration//apply.js still match.
  const flat = squeeze(text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\/{2,}/g, "/").replace(/\/\.\//g, "/"));
  for (const pattern of patterns) {
    // A trailing " *" means any arguments, including none: "node migration/apply.js *" also holds the bare command.
    const optionalTail = /\s\*$/.test(pattern);
    const body = squeeze(optionalTail ? pattern.replace(/\s\*$/, "") : pattern)
      .split("*")
      .map((part) => escapeRe(part))
      .join(".*");
    if (new RegExp(optionalTail ? `${body}(?:\\s.*)?(?:$|\\n)` : body, "is").test(flat)) return pattern;
  }
  return null;
}
