import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { exportSnapshot } from "../checkpoint/snapshot.js";
import type { Charter } from "../charter/schema.js";
import { matchesPath } from "./glob.js";
import { personalDataPattern } from "./pii.js";

/**
 * Running checks. A command check runs in a disposable copy of the workspace, with the folder of
 * check scripts replaced by the copy taken before the run, so a worker that edits a check cannot make
 * the daemon run its code. Exit code 0 means the check passed, 1 means it failed, and any other
 * code or a timeout means the check itself broke, which is not a pass.
 */

export type Check = Charter["checks"][number];

export interface Outcome {
  check: string;
  status: "passed" | "failed" | "error";
  exitCode: number | null;
  /** The first lines of output, kept short. The ledger redacts it. */
  output: string;
  ms: number;
  findings?: { file: string; matches: number }[];
}

export const CHECKS_DIR = "checks";
const MAX_OUTPUT = 4000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** A copy of the workspace to run a check in. Remove it with rmSync when done. */
export function makeCopy(workspace: string, pristineChecks: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "candor-copy-"));
  const target = join(dir, "ws");
  cpSync(workspace, target, { recursive: true, filter: (source) => relative(workspace, source).split("/")[0] !== ".git" });
  if (pristineChecks && existsSync(pristineChecks)) {
    rmSync(join(target, CHECKS_DIR), { recursive: true, force: true });
    cpSync(pristineChecks, join(target, CHECKS_DIR), { recursive: true });
  }
  return target;
}

/** A copy made from a checkpoint snapshot, so a check tests the state that was captured and not what the worker did next. */
export function makeCopyFromSnapshot(source: { gitDir: string; ref: string }, pristineChecks: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "candor-copy-"));
  const target = join(dir, "ws");
  exportSnapshot(source.gitDir, source.ref, target);
  if (pristineChecks && existsSync(pristineChecks)) {
    rmSync(join(target, CHECKS_DIR), { recursive: true, force: true });
    cpSync(pristineChecks, join(target, CHECKS_DIR), { recursive: true });
  }
  return target;
}

export function removeCopy(copy: string): void {
  rmSync(join(copy, ".."), { recursive: true, force: true });
}

export function runShell(command: string, cwd: string, env: Record<string, string> = {}, timeoutMs = 60000): Promise<{ exitCode: number | null; output: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", HOME: join(cwd, ".."), CANDOR_CHECK: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    const take = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process already ended.
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: error.message, ms: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, output: (timedOut ? `Timed out after ${timeoutMs} ms. ` : "") + output.slice(0, MAX_OUTPUT), ms: Date.now() - started });
    });
  });
}

function* walk(root: string, dir = root): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const info = statSync(full, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isDirectory()) yield* walk(root, full);
    else if (info.isFile()) yield relative(root, full).split("\\").join("/");
  }
}

/** Counts matches of a personal data pattern in the files a check covers. It never returns the matched text. */
export function scanPattern(workspace: string, check: Check): Outcome {
  const started = Date.now();
  const findings: { file: string; matches: number }[] = [];
  if (!check.deny || !check.paths?.length) return { check: check.id, status: "error", exitCode: null, output: "The check has no pattern or no paths.", ms: 0 };
  const pattern = new RegExp(personalDataPattern(check.deny).source, "g");
  let files = 0;
  for (const file of walk(workspace)) {
    if (!matchesPath(check.paths, file)) continue;
    const info = statSync(join(workspace, file));
    if (info.size > 4 * 1024 * 1024) continue;
    files++;
    const count = readFileSync(join(workspace, file), "utf8").match(pattern)?.length ?? 0;
    if (count > 0) findings.push({ file, matches: count });
    if (files > 5000) break;
  }
  return {
    check: check.id,
    status: findings.length === 0 ? "passed" : "failed",
    exitCode: findings.length === 0 ? 0 : 1,
    output: findings.length === 0 ? `No ${check.deny} found in ${files} files.` : findings.map((f) => `${f.file}: ${f.matches} match${f.matches === 1 ? "" : "es"}`).join("\n"),
    ms: Date.now() - started,
    findings,
  };
}

/** Runs one check on the live workspace through a disposable copy. */
export async function runCheck(check: Check, workspace: string, pristineChecks: string | null, timeoutMs = 60000, snapshot?: { gitDir: string; ref: string }, env: Record<string, string> = {}): Promise<Outcome> {
  if (check.type === "pattern") return scanPattern(workspace, check);
  const copy = snapshot ? makeCopyFromSnapshot(snapshot, pristineChecks) : makeCopy(workspace, pristineChecks);
  try {
    const result = await runShell(check.run ?? "false", copy, env, timeoutMs);
    const status = result.exitCode === 0 ? "passed" : result.exitCode === 1 ? "failed" : "error";
    return { check: check.id, status, exitCode: result.exitCode, output: result.output, ms: result.ms };
  } finally {
    removeCopy(copy);
  }
}
