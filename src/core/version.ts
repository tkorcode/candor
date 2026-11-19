import { execFileSync } from "node:child_process";

/**
 * The first Claude Code version with `onFailure` for hooks. Below it, a hook
 * that cannot start, crashes or times out lets the tool call through.
 */
export const MIN_CLAUDE_CODE_VERSION = "2.1.295";

export type Version = readonly [number, number, number];

export function parseVersion(text: string): Version | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type VersionCheck = { ok: true; version: string } | { ok: false; version: string | null; message: string };

export function checkClaudeCodeVersion(found: string | null, minimum: string = MIN_CLAUDE_CODE_VERSION): VersionCheck {
  const min = parseVersion(minimum);
  if (!min) throw new Error(`The minimum version ${minimum} is not a version number.`);
  const parsed = found === null ? null : parseVersion(found);
  if (!parsed) {
    return {
      ok: false,
      version: null,
      message: `Claude Code was not found, or its version could not be read. Candor needs Claude Code v${minimum} or later. Install or update it, then try again.`,
    };
  }
  const version = parsed.join(".");
  if (compareVersions(parsed, min) < 0) {
    return {
      ok: false,
      version,
      message: `Claude Code v${version} is older than v${minimum}. Below that version a failed hook lets a tool call through, so Candor will not start a run. Update Claude Code, then try again.`,
    };
  }
  return { ok: true, version };
}

export function installedClaudeCodeVersion(command = "claude"): string | null {
  try {
    return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
