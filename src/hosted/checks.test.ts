import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKS } from "./checks.js";
import { commonJsFiles, type Files, publicApi } from "./code.js";
import { FAULTS } from "./faults.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "demo", "invoices");
function load(folder: string): Files {
  const base = join(root, folder);
  const out: Files = {};
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else out[relative(base, full)] = readFileSync(full, "utf8");
    }
  };
  visit(base);
  return out;
}
const original = load("original");
const reference = load("reference");
const inventory = Object.keys(commonJsFiles(original, "src/"));

describe("the hosted code migration checks", () => {
  it("read the public functions of the service in both module styles alike", () => {
    expect(publicApi(original, "src/index.js")).toEqual(publicApi(reference, "src/index.js"));
    expect(publicApi(original, "src/index.js").map((e) => e.name)).toEqual(["applyDiscount", "createInvoice", "formatInvoice", "lineTotal", "taxFor"]);
    expect(publicApi(original, "src/index.js").every((e) => typeof e.params === "number")).toBe(true);
  });

  it.each(CHECKS.map((c) => [c.id, c]))("pass %s on a correct migration", (_id, check) => {
    expect(check.run({ original, files: reference, inventory })).toMatchObject({ status: "passed" });
  });

  it.each(CHECKS.map((c) => [c.id, c]))("fail %s on its planted fault", (id, check) => {
    const fault = FAULTS[id];
    expect(fault, `no planted fault for ${id}`).toBeDefined();
    const planted = fault?.plant(reference, original);
    expect(check.run({ original, files: planted?.files ?? reference, inventory: planted?.inventory ?? inventory })).toMatchObject({ status: "failed" });
  });

  it("find the work still to do on the original project", () => {
    const results = Object.fromEntries(CHECKS.map((c) => [c.id, c.run({ original, files: original, inventory }).status]));
    expect(results).toMatchObject({ "no-commonjs": "failed", "package-is-module": "failed", "compat-removed": "failed", "api-unchanged": "passed", "tests-unchanged": "passed", "imports-resolve": "passed" });
  });
});

describe("the sample project", () => {
  // The hosted job never runs the code. Here, on a machine with Node, the tests of the sample run on both the
  // original and the reference migration, to show that the reference keeps the behaviour the tests describe.
  it.each(["original", "reference"])("passes its own tests in the %s version", (folder) => {
    const out = execFileSync(process.execPath, ["--test"], { cwd: join(root, folder), encoding: "utf8" });
    expect(out).toMatch(/# pass 4/);
    expect(out).toMatch(/# fail 0/);
  });
});

describe("the copy of the sample project the Worker carries", () => {
  it("matches demo/invoices. Run npm run hosted:sample after a change there", async () => {
    const { ORIGINAL, REFERENCE } = await import("./sample.generated.js");
    expect(ORIGINAL).toEqual(original);
    expect(REFERENCE).toEqual(reference);
  });
});
