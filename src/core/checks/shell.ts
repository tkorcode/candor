/**
 * A cautious reader for shell command text. It does not run a shell. It splits a command into simple
 * commands and refuses any text it cannot read with confidence: command substitution, variable
 * expansion, subshells, here documents and a leading variable assignment. A refusal is a deny, so
 * text the reader cannot follow never reaches the allow list.
 */

export interface Redirect {
  op: ">" | ">>" | "<";
  target: string;
}

export interface Segment {
  words: string[];
  redirects: Redirect[];
  /** True for a word that held an unquoted glob character. The path check then uses the part before it. */
  globbed: boolean[];
}

export type Parsed = { ok: true; segments: Segment[] } | { ok: false; reason: string };

export function parseShell(command: string): Parsed {
  const segments: Segment[] = [];
  let words: string[] = [];
  let globbed: boolean[] = [];
  let redirects: Redirect[] = [];
  let word = "";
  let inWord = false;
  let hasGlob = false;
  let pending: Redirect["op"] | null = null;

  const endWord = (): void => {
    if (!inWord) return;
    if (pending) {
      redirects.push({ op: pending, target: word });
      pending = null;
    } else {
      words.push(word);
      globbed.push(hasGlob);
    }
    word = "";
    inWord = false;
    hasGlob = false;
  };
  const endSegment = (): string | null => {
    endWord();
    if (pending) return "A redirection has no target.";
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects, globbed });
    words = [];
    globbed = [];
    redirects = [];
    return null;
  };

  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === "`") return { ok: false, reason: "Command substitution with backticks cannot be checked." };
    if (c === "$") return { ok: false, reason: "Variable or command expansion with $ cannot be checked." };
    if (c === "\\") {
      if (next === undefined || next === "\n") return { ok: false, reason: "A line continuation cannot be checked." };
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "(" || c === ")") return { ok: false, reason: "Subshells and grouping cannot be checked." };
    if (c === "\n" || c === ";") {
      const error = endSegment();
      if (error) return { ok: false, reason: error };
      continue;
    }
    if (c === "|" || c === "&") {
      if (c === "&" && (word === "" || /^\d*$/.test(word)) && next === ">") {
        // &> file
        word = "";
        inWord = false;
        i++;
        pending = ">";
        if (command[i + 1] === ">") i++;
        continue;
      }
      const error = endSegment();
      if (error) return { ok: false, reason: error };
      if (next === c) i++;
      continue;
    }
    if (c === ">" || c === "<") {
      if (c === "<" && next === "<") return { ok: false, reason: "Here documents cannot be checked. Write the file with the Write tool." };
      if (c === "<" && next === "(") return { ok: false, reason: "Process substitution cannot be checked." };
      // A file descriptor number just before the operator belongs to it, as in 2>.
      if (/^\d+$/.test(word) && inWord) {
        word = "";
        inWord = false;
      } else endWord();
      let op: Redirect["op"] = c;
      if (c === ">" && next === ">") {
        op = ">>";
        i++;
      }
      if (c === ">" && command[i + 1] === "&") {
        // 2>&1 duplicates a descriptor and names no file.
        const target = /^(\d+|-)/.exec(command.slice(i + 2));
        if (!target) return { ok: false, reason: "A redirection with >& that is not a descriptor cannot be checked." };
        i += 1 + target[0].length;
        continue;
      }
      pending = op;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "~" && !inWord) return { ok: false, reason: "A tilde path cannot be checked. Use a path inside the workspace." };
    if (c === "*" || c === "?" || c === "[") hasGlob = true;
    word += c;
    inWord = true;
  }
  if (quote) return { ok: false, reason: "A quote is not closed." };
  const error = endSegment();
  if (error) return { ok: false, reason: error };
  for (const segment of segments) {
    const first = segment.words[0];
    if (first !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return { ok: false, reason: "A variable assignment before a command cannot be checked." };
  }
  return { ok: true, segments };
}

export const TRAVERSAL = /(^|[/{,=])\.\.([/},]|$)/;
