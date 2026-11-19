#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CHECKS } from "./checks.js";
import { commonJsFiles, type Files } from "./code.js";
import { FAULTS } from "./faults.js";
import { ORIGINAL, REFERENCE } from "./sample.generated.js";

/**
 * The checks of the code migration job as commands, for a job that Claude Code does in a container under the
 * local `candor run`. `run <id>` reads the project in the current folder and exits 0 when the check passes and
 * 1 when it fails. `fault <id>` prepares a copy for the check strength test: with CANDOR_FAULT_MODE=control it
 * writes a state the check must pass on, with plant the same state with the check's fault in it.
 *
 * For a check of the finished migration, the control state is the reference migration, because the project as
 * the job finds it is not migrated yet. The two checks that run the code are run by the charter as shell
 * commands; their faults are here too.
 */

const SKIP = new Set([".git", "node_modules", "checks", "reports", ".candor", ".claude"]);

function readProject(root: string): Files {
  const out: Files = {};
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name) && dir === root) continue;
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) visit(full);
      else if (info.size < 200_000) out[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  visit(root);
  return out;
}

function writeProject(root: string, files: Files): void {
  for (const path of Object.keys(readProject(root))) if (!(path in files)) rmSync(join(root, path));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function inventoryOf(root: string): string[] | undefined {
  try {
    const report = JSON.parse(readFileSync(join(root, "reports", "stage-inventory.json"), "utf8")) as { inventory?: unknown };
    return Array.isArray(report.inventory) ? report.inventory.map(String) : undefined;
  } catch {
    return undefined;
  }
}

function writeInventory(root: string, inventory: string[]): void {
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports", "stage-inventory.json"), JSON.stringify({ done: true, summary: "Planted for the check strength test.", deviations: [], confidence: 1, inventory }));
}

/** Faults of the two checks that run the code. */
const RUNNING_FAULTS: Record<string, { control: (root: string) => void; plant: (root: string) => void }> = {
  // The tests pass on the reference migration, and fail when a tax rate in the code is wrong.
  "tests-pass": {
    control: (root) => writeProject(root, REFERENCE),
    plant: (root) => writeProject(root, { ...REFERENCE, "src/rates.js": (REFERENCE["src/rates.js"] ?? "").replace("north: 0.08", "north: 0.09") }),
  },
  // The legacy report loads in the project as found, and stops loading once the package is a module.
  "legacy-loads": {
    control: () => {},
    plant: (root) => writeProject(root, REFERENCE),
  },
};

function main(args: string[]): number {
  const [verb, id] = args;
  const root = process.cwd();
  if (verb === "run") {
    const check = CHECKS.find((c) => c.id === id);
    if (!check) {
      process.stderr.write(`There is no check ${id}.\n`);
      return 2;
    }
    const result = check.run({ original: ORIGINAL as Files, files: readProject(root), inventory: inventoryOf(root) });
    process.stdout.write(`${result.output}\n`);
    return result.status === "passed" ? 0 : 1;
  }
  if (verb === "fault") {
    const plant = process.env.CANDOR_FAULT_MODE !== "control";
    const running = id ? RUNNING_FAULTS[id] : undefined;
    if (running) {
      (plant ? running.plant : running.control)(root);
      return 0;
    }
    const fault = id ? FAULTS[id] : undefined;
    if (!fault) {
      process.stderr.write(`There is no fault for ${id}.\n`);
      return 2;
    }
    const full = Object.keys(commonJsFiles(ORIGINAL as Files, "src/"));
    if (!plant) {
      writeProject(root, REFERENCE);
      writeInventory(root, full);
      return 0;
    }
    const planted = fault.plant(REFERENCE as Files, ORIGINAL as Files);
    writeProject(root, planted.files);
    writeInventory(root, planted.inventory ?? full);
    return 0;
  }
  process.stderr.write("Usage: check-cli run <check id> | check-cli fault <check id>\n");
  return 2;
}

process.exitCode = main(process.argv.slice(2));
