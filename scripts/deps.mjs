// Checks that every installed package has a permitted license, and writes
// the table of direct dependencies in docs/DEPENDENCIES.md.
//   node scripts/deps.mjs --check   fail if any license is not permitted
//   node scripts/deps.mjs --write   also rewrite the table
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PERMITTED = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"]);
const START = "<!-- deps:start -->";
const END = "<!-- deps:end -->";
const root = join(import.meta.dirname, "..");

function permitted(expr) {
  if (typeof expr !== "string") return false;
  const text = expr.replace(/[()]/g, "").trim();
  // "A OR B" is fine if either side is permitted. "A AND B" needs both.
  return text.split(/\s+OR\s+/i).some((alt) => alt.split(/\s+AND\s+/i).every((id) => PERMITTED.has(id.trim())));
}

function installed(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (name.startsWith("@")) {
      installed(path, out);
      continue;
    }
    const manifest = join(path, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name && pkg.version) out.push({ name: pkg.name, version: pkg.version, license: pkg.license });
    }
    installed(join(path, "node_modules"), out);
  }
  return out;
}

const all = installed(join(root, "node_modules"));
const bad = all.filter((pkg) => !permitted(pkg.license));
if (bad.length > 0) {
  console.error("These installed packages do not have a permitted license (MIT, Apache 2.0, BSD, ISC):");
  for (const pkg of bad) console.error(`  ${pkg.name}@${pkg.version}: ${pkg.license ?? "none stated"}`);
  console.error("Remove the dependency that brings them in, or record an exception in docs/DEPENDENCIES.md.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const uses = JSON.parse(readFileSync(join(root, "scripts", "deps-uses.json"), "utf8"));
const rows = [];
for (const [kind, deps] of [["Runtime", manifest.dependencies ?? {}], ["Development", manifest.devDependencies ?? {}]]) {
  for (const name of Object.keys(deps).sort()) {
    const pkg = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
    if (!uses[name]) {
      console.error(`scripts/deps-uses.json has no entry for ${name}. Add one line saying what it is used for.`);
      process.exit(1);
    }
    rows.push(`| \`${name}\` | ${pkg.version} | ${pkg.license} | ${uses[name]} | ${kind} |`);
  }
}
const table = [
  START,
  "| Package | Installed version | License | Used for | Runtime or development |",
  "|---|---|---|---|---|",
  ...rows,
  "",
  "`npm run deps:check` checks every installed package, direct or indirect, against these rules. It is part of `npm run check`.",
  END,
].join("\n");

const docPath = join(root, "docs", "DEPENDENCIES.md");
const doc = readFileSync(docPath, "utf8");
const next = doc.includes(START) ? doc.slice(0, doc.indexOf(START)) + table + doc.slice(doc.indexOf(END) + END.length) : `${doc.trimEnd()}\n\n${table}\n`;
if (process.argv.includes("--write")) {
  writeFileSync(docPath, next);
  console.log(`docs/DEPENDENCIES.md written: ${rows.length} direct dependencies.`);
} else if (next !== doc) {
  console.error("docs/DEPENDENCIES.md is out of date. Run: npm run deps:render");
  process.exit(1);
} else {
  console.log(`Licenses permitted for all ${all.length} installed packages. docs/DEPENDENCIES.md is up to date.`);
}
