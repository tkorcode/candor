import { changedTests, commonJsFiles, type Files, publicApi, unresolvedImports } from "./code.js";

/**
 * The checks of the hosted code migration. Each reads the files and returns passed or failed with a short reason.
 * None runs the code. `original` is the project as the job found it, `files` the project now.
 */

export type CheckResult = { status: "passed" | "failed"; output: string };
export type CheckInput = { original: Files; files: Files; inventory?: string[] };
export type HostedCheck = { id: string; text: string; run: (input: CheckInput) => CheckResult };

const pass = (output: string): CheckResult => ({ status: "passed", output: `PASS: ${output}` });
const fail = (output: string): CheckResult => ({ status: "failed", output: `FAIL: ${output}` });
const ENTRY = "src/index.js";

export const CHECKS: HostedCheck[] = [
  {
    id: "inventory-complete",
    text: "The inventory names every file under src/ that uses CommonJS.",
    run: ({ original, inventory }) => {
      const want = Object.keys(commonJsFiles(original, "src/")).sort();
      const got = new Set(inventory ?? []);
      const missed = want.filter((f) => !got.has(f));
      return missed.length ? fail(`the inventory leaves out ${missed.join(", ")}`) : pass(`the inventory names all ${want.length} files`);
    },
  },
  {
    id: "no-commonjs",
    text: "No file under src/ uses require, module.exports or exports.",
    run: ({ files }) => {
      const left = commonJsFiles(files, "src/");
      const list = Object.entries(left).map(([f, lines]) => `${f} line ${lines.join(", ")}`);
      return list.length ? fail(`CommonJS is still used in ${list.join("; ")}`) : pass("no file under src/ uses CommonJS");
    },
  },
  {
    id: "imports-resolve",
    text: "Every relative import points to a file that exists.",
    run: ({ files }) => {
      const missing = unresolvedImports(Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith("src/") || p.startsWith("tests/"))));
      return missing.length ? fail(missing.map((m) => `${m.file} imports ${m.specifier}, which does not exist`).join("; ")) : pass("every relative import in src/ and tests/ points to a file that exists");
    },
  },
  {
    id: "api-unchanged",
    text: "The service exports the same public functions as before, with the same number of parameters.",
    run: ({ original, files }) => {
      const before = publicApi(original, ENTRY);
      const after = new Map(publicApi(files, ENTRY).map((e) => [e.name, e.params]));
      const problems = before.flatMap((e) => (!after.has(e.name) ? [`${e.name} is no longer exported`] : after.get(e.name) !== e.params ? [`${e.name} took ${e.params} parameters and now takes ${after.get(e.name)}`] : []));
      return problems.length ? fail(problems.join("; ")) : pass(`${ENTRY} exports the same ${before.length} functions with the same parameters`);
    },
  },
  {
    id: "tests-unchanged",
    text: "The tests test the same things: only the lines that load modules changed.",
    run: ({ original, files }) => {
      const changed = changedTests(original, files, "tests/");
      return changed.length ? fail(`more than the import lines changed in ${changed.join(", ")}`) : pass("only the import lines of the tests changed");
    },
  },
  {
    id: "package-is-module",
    text: "package.json declares the project an ES module.",
    run: ({ files }) => {
      try {
        const type = JSON.parse(files["package.json"] ?? "{}").type;
        return type === "module" ? pass('package.json has "type": "module"') : fail(`package.json has "type": ${JSON.stringify(type ?? null)}`);
      } catch {
        return fail("package.json is not valid JSON");
      }
    },
  },
  {
    id: "compat-removed",
    text: "The old entry point src/compat.js is removed.",
    run: ({ files }) => ("src/compat.js" in files ? fail("src/compat.js is still there") : pass("src/compat.js is removed")),
  },
];
