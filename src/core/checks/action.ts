import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { digest } from "../canonical.js";
import type { Charter } from "../charter/schema.js";
import { containsPattern, matchesCommand, matchesPath } from "./glob.js";
import { personalDataPattern } from "./pii.js";
import { parseShell, type Segment, TRAVERSAL } from "./shell.js";

/**
 * The deterministic rules that run on every tool call before it happens: scope, command, network,
 * personal data and irreversible actions. The budget needs run state, so the daemon checks it.
 * Nothing here calls a model.
 */

export type Rule = "scope" | "command" | "network" | "personal_data" | "irreversible" | "tool";

export interface Effect {
  kind: "network" | "irreversible" | "mcp" | "subagent";
  summary: string;
  reversible: boolean;
}

export interface Verdict {
  decision: "allow" | "deny" | "hold";
  rule?: Rule;
  reason?: string;
  /** Short redacted-later text for the ledger. */
  summary: string;
  /** Digest of the exact action, including the content of any script it runs. Approvals bind to this. */
  actionDigest: string;
  effects: Effect[];
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
const SAFE_TOOLS = new Set(["TodoWrite", "Task", "Agent", "Skill", "ToolSearch", "ExitPlanMode", "BashOutput", "KillShell"]);
const NETWORK_COMMANDS = new Set(["curl", "wget", "ssh", "scp", "sftp", "nc", "ncat", "netcat", "telnet", "ftp", "ping", "dig", "nslookup", "rsync", "git", "gh", "npm", "npx", "pnpm", "yarn", "pip", "pip3", "brew", "apt", "apt-get"]);
const INTERPRETERS = new Set(["node", "sh", "bash", "zsh", "python", "python3", "ruby", "perl"]);
// Only these dot-commands are allowed in sqlite3. Any other can run a program or write outside the workspace.
const SQLITE_SAFE_DOT = new Set([".mode", ".headers", ".header", ".tables", ".schema", ".quit", ".exit", ".timeout", ".width", ".separator", ".nullvalue", ".help", ".indexes", ".databases"]);
const SQLITE_DANGEROUS = /\battach\b|load_extension|writefile|readfile|edit\s*\(|vacuum\s+into|-init\b|-cmd\b|-interactive/i;
function sqliteUnsafe(args: string[]): boolean {
  if (SQLITE_DANGEROUS.test(args.join(" "))) return true;
  return args.some((arg) => /^\s*\./.test(arg) && !SQLITE_SAFE_DOT.has(arg.trim().split(/\s+/)[0] ?? ""));
}
const SCRIPT_NETWORK = /\b(fetch\s*\(|XMLHttpRequest|WebSocket|require\s*\(\s*['"](node:)?(http|https|net|dgram|tls|child_process)['"]\s*\)|from\s+['"](node:)?(http|https|net|dgram|tls|child_process)['"]|import\s*\(\s*['"](node:)?(http|https|net|child_process)['"]|https?:\/\/|urllib|requests\.|socket\.)/i;
const MAX_SCRIPT = 256 * 1024;

/** Resolves a path the worker named. The deepest folder that exists is resolved through links, so a link cannot lead out. */
export function resolveInWorkspace(root: string, path: string): { inside: boolean; absolute: string; relative: string } {
  const realRoot = realpathSync(root);
  const joined = isAbsolute(path) ? resolve(path) : resolve(realRoot, path);
  let existing = joined;
  const tail: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    tail.unshift(existing.slice(dirname(existing).length + 1));
    existing = dirname(existing);
  }
  const absolute = join(realpathSync(existing), ...tail);
  const rel = relative(realRoot, absolute);
  const inside = !rel.startsWith("..") && !isAbsolute(rel);
  return { inside, absolute, relative: inside ? rel.split("\\").join("/") : rel };
}

const clip = (text: string, max = 300): string => (text.length > max ? `${text.slice(0, max)}...` : text);

interface Context {
  charter: Charter;
  root: string;
}

function deny(rule: Rule, reason: string, summary: string, actionDigest: string, effects: Effect[] = []): Verdict {
  return { decision: "deny", rule, reason, summary, actionDigest, effects };
}

function patternChecks(charter: Charter) {
  return charter.checks.filter((check) => check.type === "pattern" && check.when === "every_action" && check.deny && check.paths?.length);
}

function textOf(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["content", "new_string", "new_source"]) if (typeof input[key] === "string") parts.push(input[key] as string);
  if (Array.isArray(input.edits)) for (const edit of input.edits) {
      const text = (edit as Record<string, unknown> | null)?.new_string;
      if (typeof text === "string") parts.push(text);
    }
  return parts.join("\n");
}

function fileTool(ctx: Context, tool: string, input: Record<string, unknown>, base: Omit<Verdict, "decision">): Verdict {
  const raw = input.file_path ?? input.notebook_path ?? input.path;
  const writing = WRITE_TOOLS.has(tool);
  const target = typeof raw === "string" && raw.length > 0 ? raw : ".";
  const where = resolveInWorkspace(ctx.root, target);
  if (!where.inside) return deny("scope", `${tool} names ${clip(target, 120)}, which is outside the workspace.`, base.summary, base.actionDigest);
  const summary = clip(`${tool} ${where.relative || "."}`, 200);
  const known = { ...base, summary };
  if (writing) {
    if (matchesPath(ctx.charter.scope.deny_paths, where.relative)) return deny("scope", `${where.relative} is in deny_paths of the charter.`, summary, base.actionDigest);
    if (!matchesPath(ctx.charter.scope.allow_paths, where.relative)) return deny("scope", `${where.relative} is not in allow_paths of the charter, so the job may not change it.`, summary, base.actionDigest);
    const content = textOf(input);
    for (const check of patternChecks(ctx.charter)) {
      if (matchesPath(check.paths ?? [], where.relative) && check.deny && personalDataPattern(check.deny).test(content)) {
        return deny("personal_data", `The text written to ${where.relative} contains personal data (${check.deny}). Check ${check.id} does not allow it there.`, summary, base.actionDigest);
      }
    }
  } else if (typeof input.pattern === "string" && (isAbsolute(input.pattern) || TRAVERSAL.test(input.pattern))) {
    return deny("scope", "A search pattern that starts at the root or climbs out of the folder is not allowed.", summary, base.actionDigest);
  }
  return { ...known, decision: "allow" };
}

function checkSegment(ctx: Context, segment: Segment, scripts: Record<string, string>): { error: Verdict["reason"] | null; rule: Rule; irreversibleText: string[] } {
  const text = segment.words.join(" ");
  const irreversibleText: string[] = [text];
  const first = segment.words[0] ?? "";
  const name = first.split("/").pop() ?? first;
  if (segment.words.length > 0 && !matchesCommand(ctx.charter.scope.allow_commands, text)) {
    return { error: `The command ${clip(text, 120)} does not match allow_commands of the charter.`, rule: "command", irreversibleText };
  }
  if (!ctx.charter.scope.network && NETWORK_COMMANDS.has(name)) {
    return { error: `${name} can reach the network, and the charter sets network to false.`, rule: "network", irreversibleText };
  }
  if (name === "sqlite3" && sqliteUnsafe(segment.words.slice(1))) {
    return { error: "This sqlite3 command can run a program or write outside the workspace (a dot-command other than a plain setting, ATTACH, writefile, VACUUM INTO, -init) and is not allowed.", rule: "command", irreversibleText };
  }
  const targets: { path: string; writing: boolean }[] = [];
  segment.words.forEach((word, index) => {
    if (TRAVERSAL.test(word)) targets.push({ path: "..", writing: false });
    const candidate = word.includes("=") && word.startsWith("-") ? word.slice(word.indexOf("=") + 1) : word;
    if (index === 0 && !candidate.includes("/")) return;
    if (candidate.startsWith("/")) targets.push({ path: candidate, writing: false });
    else if (index > 0 && !candidate.startsWith("-") && segment.globbed[index]) targets.push({ path: candidate.split(/[*?[]/)[0] || ".", writing: false });
  });
  for (const redirect of segment.redirects) targets.push({ path: redirect.target, writing: redirect.op !== "<" });
  for (const target of targets) {
    if (target.path === "..") return { error: "A path with .. in a command cannot be checked. Use a path inside the workspace.", rule: "scope", irreversibleText };
    if (target.path === "/dev/null") continue;
    const where = resolveInWorkspace(ctx.root, target.path);
    if (!where.inside) return { error: `The command names ${clip(target.path, 120)}, which is outside the workspace.`, rule: "scope", irreversibleText };
    if (target.writing) {
      if (matchesPath(ctx.charter.scope.deny_paths, where.relative) || !matchesPath(ctx.charter.scope.allow_paths, where.relative)) {
        return { error: `The command writes ${where.relative}, which the charter scope does not allow.`, rule: "scope", irreversibleText };
      }
    }
  }
  // A file fed in with < is read too, so a statement hidden in an input file is seen.
  for (const redirect of segment.redirects.filter((r) => r.op === "<")) {
    const where = resolveInWorkspace(ctx.root, redirect.target);
    if (where.inside && existsSync(where.absolute) && statSync(where.absolute).isFile()) {
      if (statSync(where.absolute).size > MAX_SCRIPT) return { error: `${where.relative} is too large to check, so it is not allowed as input.`, rule: "command", irreversibleText };
      const content = readFileSync(where.absolute, "utf8");
      scripts[where.relative] = digest(content);
      irreversibleText.push(content);
    }
  }
  // A script the command runs is read, so an irreversible step or a network call hidden inside it is seen.
  if (INTERPRETERS.has(name)) {
    const scriptName = segment.words.slice(1).find((word) => !word.startsWith("-"));
    if (scriptName && !scriptName.startsWith("/")) {
      const where = resolveInWorkspace(ctx.root, scriptName);
      if (where.inside && existsSync(where.absolute) && statSync(where.absolute).isFile()) {
        if (statSync(where.absolute).size > MAX_SCRIPT) return { error: `${where.relative} is too large to check, so it is not allowed to run.`, rule: "command", irreversibleText };
        const content = readFileSync(where.absolute, "utf8");
        scripts[where.relative] = digest(content);
        irreversibleText.push(content);
        if (!ctx.charter.scope.network && SCRIPT_NETWORK.test(content)) {
          return { error: `${where.relative} appears to use the network or start other programs, and the charter sets network to false. This check reads the script text and can be fooled.`, rule: "network", irreversibleText };
        }
      }
    }
  }
  return { error: null, rule: "command", irreversibleText };
}

function bashTool(ctx: Context, input: Record<string, unknown>, base: Omit<Verdict, "decision">): Verdict {
  const command = typeof input.command === "string" ? input.command : "";
  const summary = `Bash: ${clip(command)}`;
  if (command.trim() === "") return deny("command", "The command is empty.", summary, base.actionDigest);
  if (/\|\s*sqlite3\b/.test(command)) return deny("command", "Piping text into sqlite3 cannot be checked. Use a file with < or the command argument.", summary, base.actionDigest);
  const parsed = parseShell(command);
  if (!parsed.ok) return deny("command", `${parsed.reason} Rewrite it as plain commands.`, summary, base.actionDigest);
  const scripts: Record<string, string> = {};
  const texts: string[] = [];
  for (const segment of parsed.segments) {
    const result = checkSegment(ctx, segment, scripts);
    if (result.error) return deny(result.rule, result.error, summary, base.actionDigest);
    texts.push(...result.irreversibleText);
  }
  const actionDigest = digest({ tool: "Bash", input: { command: command.trim() }, scripts });
  const hit = containsPattern(ctx.charter.irreversible, texts.join("\n"));
  if (hit) {
    return {
      decision: "hold",
      rule: "irreversible",
      reason: `This action matches the irreversible pattern "${hit}".`,
      summary,
      actionDigest,
      effects: [{ kind: "irreversible", summary, reversible: false }],
    };
  }
  return { decision: "allow", summary, actionDigest, effects: [] };
}

export function evaluateAction(charter: Charter, root: string, tool: string, input: Record<string, unknown>): Verdict {
  const ctx: Context = { charter, root };
  const actionDigest = digest({ tool, input });
  const base = { summary: tool, actionDigest, effects: [] as Effect[] };
  if (tool === "Bash") return bashTool(ctx, input, base);
  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) return fileTool(ctx, tool, input, base);
  if (NETWORK_TOOLS.has(tool)) {
    const effect: Effect = { kind: "network", summary: `${tool} ${clip(String(input.url ?? input.query ?? ""), 120)}`, reversible: false };
    return charter.scope.network ? { ...base, decision: "allow", effects: [effect] } : deny("network", `${tool} needs the network, and the charter sets network to false.`, base.summary, actionDigest, [effect]);
  }
  if (tool.startsWith("mcp__")) {
    const effect: Effect = { kind: "mcp", summary: tool, reversible: false };
    return charter.scope.network ? { ...base, decision: "allow", effects: [effect] } : deny("network", `${tool} is a tool from another program and may leave the workspace. The charter sets network to false.`, base.summary, actionDigest, [effect]);
  }
  if (SAFE_TOOLS.has(tool)) return { ...base, decision: "allow", effects: tool === "Task" || tool === "Agent" ? [{ kind: "subagent", summary: tool, reversible: true }] : [] };
  return deny("tool", `The tool ${tool} is not one Candor knows how to check, so it is not allowed. Use Bash, Read, Edit or Write.`, base.summary, actionDigest);
}
