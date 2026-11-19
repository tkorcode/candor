import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedPaths, exportSnapshot, restoreSnapshot, takeSnapshot } from "./snapshot.js";

const sh = (cwd: string, command: string): string => execFileSync("sh", ["-c", command], { cwd, encoding: "utf8" }).trim();
const gitIn = (gitDir: string, args: string): string => sh(gitDir, `GIT_DIR='${gitDir}' git ${args}`);

describe("working tree snapshot with the git directory in the run store", () => {
  let base: string;
  let work: string;
  let gitDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "candor-snap-"));
    work = join(base, "work");
    gitDir = join(base, "store", "snapshots.git");
    mkdirSync(work);
    writeFileSync(join(work, "tracked.txt"), "one\n");
    writeFileSync(join(work, "to-delete.txt"), "bye\n");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("captures untracked, shell-made, deleted and ignored files, and leaves the workspace alone", () => {
    sh(work, "git init -q -b main && git config user.email t@example.com && git config user.name t && git add -A && git commit -q -m first");
    writeFileSync(join(work, ".gitignore"), "ignored/\n*.secret\n");
    writeFileSync(join(work, "tracked.txt"), "two\n");
    sh(work, "mkdir -p out ignored && printf 'made by a shell command\\n' > out/shell.txt && printf 'x' > ignored/cache.bin && printf 'hidden' > a.secret");
    unlinkSync(join(work, "to-delete.txt"));
    const statusBefore = sh(work, "git status --porcelain=v1");
    const headBefore = sh(work, "git rev-parse HEAD");

    const snapshot = takeSnapshot({ gitDir, workdir: work, ref: "refs/candor/r_test/A/1", message: "checkpoint A1" });

    expect(sh(work, "git status --porcelain=v1")).toBe(statusBefore);
    expect(sh(work, "git rev-parse HEAD")).toBe(headBefore);
    expect(existsSync(join(work, ".git", "refs", "candor"))).toBe(false);
    expect(gitIn(gitDir, "rev-parse refs/candor/r_test/A/1")).toBe(snapshot.commit);

    const restored = join(base, "restored");
    restoreSnapshot({ gitDir, ref: snapshot.ref, dir: restored });
    expect(readFileSync(join(restored, "tracked.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(restored, "out", "shell.txt"), "utf8")).toBe("made by a shell command\n");
    expect(readFileSync(join(restored, "ignored", "cache.bin"), "utf8")).toBe("x");
    expect(readFileSync(join(restored, "a.secret"), "utf8")).toBe("hidden");
    expect(existsSync(join(restored, "to-delete.txt"))).toBe(false);
    // The nested .git folder of the workspace is not captured.
    expect(gitIn(gitDir, `ls-tree -r --name-only ${snapshot.commit}`)).not.toMatch(/\.git\//);
  });

  it("works when the workspace is not a git repository", () => {
    const snapshot = takeSnapshot({ gitDir, workdir: work, ref: "refs/candor/r_test/A/1", message: "x" });
    expect(gitIn(gitDir, `ls-tree --name-only ${snapshot.commit}`)).toBe("to-delete.txt\ntracked.txt");
  });

  it("chains a second snapshot on the same ref to the first and lists what changed", () => {
    const first = takeSnapshot({ gitDir, workdir: work, ref: "refs/candor/r_test/A/1", message: "one" });
    writeFileSync(join(work, "later.txt"), "later\n");
    writeFileSync(join(work, "tracked.txt"), "changed\n");
    const second = takeSnapshot({ gitDir, workdir: work, ref: "refs/candor/r_test/A/2", message: "two" });
    expect(second.tree).not.toBe(first.tree);
    expect(changedPaths(gitDir, first.commit, second.commit).sort()).toEqual(["later.txt", "tracked.txt"]);
    expect(changedPaths(gitDir, null, first.commit).sort()).toEqual(["to-delete.txt", "tracked.txt"]);
  });

  it("gives the same tree for the same content", () => {
    const first = takeSnapshot({ gitDir, workdir: work, ref: "refs/candor/r_test/A/1", message: "one" });
    const second = takeSnapshot({ gitDir, workdir: work, ref: "refs/candor/r_test/A/2", message: "two" });
    expect(second.tree).toBe(first.tree);
  });

  it("does not run a program that the workspace settings, hooks, attributes or filters name", () => {
    sh(work, "git init -q -b main");
    const marker = join(base, "ran.txt");
    writeFileSync(join(work, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    writeFileSync(join(work, "monitor.sh"), `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`, { mode: 0o755 });
    // A filter driver and an attributes file in the workspace, which the worker can write.
    sh(work, `git config core.fsmonitor '${join(work, "monitor.sh")}' && git config filter.evil.clean 'touch ${marker}; cat' && git config filter.evil.smudge 'touch ${marker}; cat'`);
    writeFileSync(join(work, ".gitattributes"), "* filter=evil\n");
    const snapshot = takeSnapshot({ gitDir, workdir: work, ref: "refs/candor/r_test/A/1", message: "x" });
    restoreSnapshot({ gitDir, ref: snapshot.ref, dir: join(base, "restored") });
    expect(existsSync(marker)).toBe(false);
  });

  it("does not change line endings or content because of a .gitattributes file", () => {
    writeFileSync(join(work, ".gitattributes"), "* text eol=crlf\n");
    writeFileSync(join(work, "unix.txt"), "a\nb\n");
    const snapshot = takeSnapshot({ gitDir, workdir: work, ref: "refs/candor/r_test/A/1", message: "x" });
    const out = join(base, "export");
    exportSnapshot(gitDir, snapshot.ref, out);
    expect(readFileSync(join(out, "unix.txt"), "utf8")).toBe("a\nb\n");
  });

  it("stores a link as a link and does not follow it out of the workspace", () => {
    writeFileSync(join(base, "outside.txt"), "outside\n");
    symlinkSync(join(base, "outside.txt"), join(work, "link.txt"));
    const snapshot = takeSnapshot({ gitDir, workdir: work, ref: "refs/candor/r_test/A/1", message: "x" });
    expect(gitIn(gitDir, `ls-tree ${snapshot.commit} link.txt`)).toMatch(/^120000 /);
  });

  it("says what is wrong when the workspace is missing", () => {
    expect(() => takeSnapshot({ gitDir, workdir: join(base, "nope"), ref: "refs/candor/r_test/A/1", message: "x" })).toThrow(/does not exist/);
  });

  it("refuses a ref outside refs/candor", () => {
    expect(() => takeSnapshot({ gitDir, workdir: work, ref: "refs/heads/main", message: "x" })).toThrow(/refs\/candor/);
  });
});
