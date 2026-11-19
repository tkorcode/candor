import type { Files } from "./code.js";

/**
 * A planted fault for each hosted check. Each takes a correct migration and breaks it in the one way its check
 * must notice. The check strength test runs a check on the fault and expects it to fail (SPEC 5.1).
 */

const edit = (files: Files, path: string, change: (s: string) => string): Files => ({ ...files, [path]: change(files[path] ?? "") });

export const FAULTS: Record<string, { text: string; plant: (good: Files, original: Files) => { files: Files; inventory?: string[] } }> = {
  "inventory-complete": {
    text: "The inventory leaves out one file.",
    plant: (good, original) => ({ files: good, inventory: Object.keys(original).filter((p) => p.startsWith("src/") && p !== "src/tax.js") }),
  },
  "no-commonjs": {
    text: "One require is put back.",
    plant: (good) => ({ files: edit(good, "src/format.js", (s) => `const { fromCents } = require("./money");\n${s.replace(/^import .*\n/m, "")}`) }),
  },
  "imports-resolve": {
    text: "An import leaves out the file extension.",
    plant: (good) => ({ files: edit(good, "src/tax.js", (s) => s.replace('"./money.js"', '"./money"')) }),
  },
  "api-unchanged": {
    text: "A public function is renamed.",
    plant: (good) => ({ files: edit(good, "src/index.js", (s) => s.replace("export { taxFor }", "export { taxFor as taxForRegion }")) }),
  },
  "tests-unchanged": {
    text: "An expected value in a test is changed to match.",
    plant: (good) => ({ files: edit(good, "tests/invoice.test.js", (s) => s.replace("1087", "1088")) }),
  },
  "package-is-module": {
    text: "package.json still says CommonJS.",
    plant: (good) => ({ files: edit(good, "package.json", (s) => s.replace('"type": "module"', '"type": "commonjs"')) }),
  },
  "compat-removed": {
    text: "The old entry point is left in place.",
    plant: (good, original) => ({ files: { ...good, "src/compat.js": original["src/compat.js"] ?? "" } }),
  },
};
