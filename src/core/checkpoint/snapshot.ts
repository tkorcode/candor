import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Working tree snapshots. The git directory sits in the run store, outside the workspace, so the
 * worker cannot write its settings, hooks or attributes (D-030, which closes the open risks of D-017).
 * The workspace is only read. Its own .git folder is never captured, and its .gitignore does not
 * hide files, so a worker cannot choose what a checkpoint leaves out.
 */

export interface Snapshot {
  ref: string;
  commit: string;
  tree: string;
}

export interface SnapshotOptions {
  /** The bare repository in the run store. Created on first use. */
  gitDir: string;
  /** The working tree to capture. It does not need to be a git repository. */
  workdir: string;
  /** The hidden ref to write, such as refs/candor/r_8f3c/A/3. */
  ref: string;
  message: string;
  /** Fixed time for the snapshot commit, so scripted runs repeat exactly. */
  date?: Date;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "candor",
  GIT_AUTHOR_EMAIL: "candor@localhost",
  GIT_COMMITTER_NAME: "candor",
  GIT_COMMITTER_EMAIL: "candor@localhost",
};

/** Settings that stop git from running a program or changing content: no global or system file, no hooks, no monitor, no line ending changes. */
const HARDENING = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.excludesFile=/dev/null",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.autocrlf=false",
  "-c", "core.quotepath=false",
  "-c", "gc.auto=0",
];

function git(gitDir: string, cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  try {
    return execFileSync("git", [...HARDENING, ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_DIR: gitDir, GIT_TERMINAL_PROMPT: "0", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function tryGit(gitDir: string, cwd: string, args: string[]): string | null {
  try {
    return git(gitDir, cwd, args);
  } catch {
    return null;
  }
}

export function assertCandorRef(ref: string): void {
  if (!/^refs\/candor\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(ref) || ref.includes("..")) {
    throw new Error(`A snapshot ref must look like refs/candor/<run>/<branch>/<number>. Got: ${ref}`);
  }
}

export function ensureSnapshotStore(gitDir: string): void {
  if (existsSync(join(gitDir, "HEAD"))) return;
  mkdirSync(gitDir, { recursive: true, mode: 0o700 });
  git(gitDir, gitDir, ["init", "--bare", "--quiet"]);
  mkdirSync(join(gitDir, "info"), { recursive: true });
  // The attributes of the store win over any .gitattributes file in the workspace.
  writeFileSync(join(gitDir, "info", "attributes"), "* -text -filter -ident -diff -merge -working-tree-encoding\n");
  writeFileSync(join(gitDir, "info", "exclude"), "");
}

/**
 * Captures the whole working tree, including untracked files, ignored files and files changed only
 * by shell commands, as a commit on a hidden ref. It builds the tree in a temporary index.
 * A nested repository is stored as a link, not as files.
 */
export function takeSnapshot(options: SnapshotOptions): Snapshot {
  assertCandorRef(options.ref);
  if (!existsSync(options.workdir)) throw new Error(`The workspace ${options.workdir} does not exist, so it cannot be captured.`);
  ensureSnapshotStore(options.gitDir);
  const scratch = mkdtempSync(join(tmpdir(), "candor-index-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index"), GIT_WORK_TREE: options.workdir };
  try {
    git(options.gitDir, options.workdir, ["add", "--all", "--force", "."], env);
    const tree = git(options.gitDir, options.workdir, ["write-tree"], env);
    const parent = tryGit(options.gitDir, options.workdir, ["rev-parse", "--verify", "--quiet", `${options.ref}^{commit}`]);
    const when = options.date ? { GIT_AUTHOR_DATE: options.date.toISOString(), GIT_COMMITTER_DATE: options.date.toISOString() } : {};
    const commit = git(options.gitDir, options.workdir, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", options.message], { ...IDENTITY, ...when });
    git(options.gitDir, options.workdir, ["update-ref", options.ref, commit]);
    return { ref: options.ref, commit, tree };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Checks a snapshot out into a new worktree. The original working tree is not changed. */
export function restoreSnapshot(options: { gitDir: string; ref: string; dir: string }): void {
  assertCandorRef(options.ref);
  git(options.gitDir, options.gitDir, ["worktree", "add", "--detach", options.dir, options.ref]);
}

/** Paths that differ between two snapshots. With no earlier one, every path in the later one. */
export function changedPaths(gitDir: string, from: string | null, to: string): string[] {
  const out = from ? git(gitDir, gitDir, ["diff", "--name-only", "--no-renames", from, to]) : git(gitDir, gitDir, ["ls-tree", "-r", "--name-only", to]);
  return out.split("\n").filter((line) => line.length > 0);
}

/**
 * The text of what changed between two snapshots, for the watcher. No external diff program or text filter runs.
 * The store marks every file as not text, so each file is read here: a file with a zero byte shows as one line
 * with its size, and any other file shows its changed lines. The result is cut at `maxChars` and says so.
 */
export function diffText(gitDir: string, from: string | null, to: string, maxChars: number): string {
  const empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const start = from ?? empty;
  const files = git(gitDir, gitDir, ["diff", "--name-status", "--no-renames", start, to])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => ({ status: line.slice(0, 1), path: line.slice(line.indexOf("\t") + 1) }));
  const parts: string[] = [];
  let used = 0;
  let shown = 0;
  for (const file of files) {
    if (used >= maxChars) break;
    shown += 1;
    const side = file.status === "D" ? start : to;
    let blob = "";
    try {
      blob = git(gitDir, gitDir, ["cat-file", "blob", `${side}:${file.path}`]);
    } catch {
      // A file that cannot be read shows as a changed path with no text.
    }
    let text: string;
    if (blob.includes("\u0000") || blob.includes("\ufffd")) {
      const size = tryGit(gitDir, gitDir, ["cat-file", "-s", `${side}:${file.path}`]);
      text = `${file.status === "D" ? "deleted" : file.status === "A" ? "added" : "changed"} binary file ${file.path} (${size ?? "unknown"} bytes). Its content is not shown.`;
    } else {
      text = git(gitDir, gitDir, ["diff", "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U1", "--minimal", start, to, "--", file.path]);
    }
    parts.push(text);
    used += text.length;
  }
  const joined = parts.join("\n");
  const cut = joined.length > maxChars ? `${joined.slice(0, maxChars)}\n[cut: ${joined.length - maxChars} more characters of changes]` : joined;
  return files.length > shown ? `${cut}\n[${files.length - shown} more changed files are not shown]` : cut;
}

/** Writes the content of one snapshot into a folder, without a worktree entry in the store. */
export function exportSnapshot(gitDir: string, ref: string, dir: string): void {
  assertCandorRef(ref);
  mkdirSync(dir, { recursive: true });
  const archive = execFileSync("git", [...HARDENING, "archive", "--format=tar", ref], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_DIR: gitDir },
    maxBuffer: 1024 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
}

/** The tree a snapshot commit holds. Two snapshots with the same tree hold the same files. */
export function treeOf(gitDir: string, commit: string): string {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("A snapshot commit is 40 hexadecimal characters.");
  return git(gitDir, gitDir, ["rev-parse", `${commit}^{tree}`]);
}
