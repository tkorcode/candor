#!/usr/bin/env node
// Removes personal details from recorded runs before they are published in results/.
//
// A run recorded on a person's computer holds details of that computer: the home folder and user name in paths,
// the private temporary folder, and the names of the MCP servers and connectors the person has set up, which the
// worker session lists when it starts. This script replaces the user name with `owner`, replaces the temporary
// folder with `xx/redacted`, and drops MCP server and MCP tool names from the lists that hold them.
//
// Ledgers are hash chained, so a ledger that changes is written again as a new chain: each entry is hashed again,
// blobs that change are stored under their new hash, and anchors follow the new hashes. A signed receipt is signed
// again with the key of the Candor home this script runs with. The published copy is then tamper-evident from the
// redaction on, not from the run. REDACTED.md in each run folder records the old and new heads and keys, so the
// person who ran it can show that the published copy matches the original files, which that person keeps.
//
// Usage: npm run build && node scripts/redact-results.mjs [results/<run folder> ...]   (default: every folder in results/)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../dist/core/canonical.js";
import { GENESIS } from "../dist/core/ledger/types.js";
import { entryHash } from "../dist/core/ledger/verify.js";
import { candorHome } from "../dist/core/paths.js";
import { ensureReceiptKey, keyId, signReceipt } from "../dist/core/report/sign.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const folders = (args.length > 0 ? args : readdirSync(join(root, "results")).map((f) => join("results", f))).map((f) => resolve(root, f)).filter((f) => statSync(f).isDirectory());

const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const files = folders.flatMap(walk).filter((f) => !readFileSync(f).includes(0));
const sha = (text) => createHash("sha256").update(text).digest("hex");

// The user names in home paths. `owner` is the replacement, and Shared is not a person.
const names = new Set();
for (const file of files) for (const m of readFileSync(file, "utf8").matchAll(/\/Users\/([^/"'\s\\<>]+)/g)) if (m[1] !== "owner" && m[1] !== "Shared") names.add(m[1]);
const subs = [...names].flatMap((n) => [
  [`/Users/${n}`, "/Users/owner"],
  [`-Users-${n.replace(/[^A-Za-z0-9]/g, "-")}-`, "-Users-owner-"],
  [n, "owner"],
]);
const redactText = (text) =>
  subs
    .reduce((t, [from, to]) => t.split(from).join(to), text)
    .replace(/\/var\/folders\/[A-Za-z0-9_+]{2}\/[A-Za-z0-9_+]{12,}/g, "/var/folders/xx/redacted")
    .replace(/-var-folders-[A-Za-z0-9_+]{2}-[A-Za-z0-9_+]{12,}-/g, "-var-folders-xx-redacted-");

/** Old hex digest to new, for ledger entries, blobs and keys. Shortened digests of twelve or more characters follow too. */
const hexMap = new Map();
const mapHex = (text) =>
  text.replace(/[0-9a-f]{12,}/g, (m) => {
    if (m.length === 64) return hexMap.get(m) ?? m;
    if (m.length > 64) return m;
    for (const [from, to] of hexMap) if (from.startsWith(m)) return to.slice(0, m.length);
    return m;
  });

/** Strings are redacted, MCP tool names are dropped from lists, and lists of MCP servers are emptied. */
function clean(value, key, onBlob) {
  if (typeof value === "string") return mapHex(redactText(value));
  if (Array.isArray(value)) {
    if (key === "mcp_servers") return [];
    return value.filter((v) => !(typeof v === "string" && v.startsWith("mcp__"))).map((v) => clean(v, undefined, onBlob));
  }
  if (value !== null && typeof value === "object") {
    if (onBlob && typeof value.$blob === "string" && typeof value.bytes === "number") return onBlob(value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k, onBlob)]));
  }
  return value;
}

const changed = new Set();
const write = (file, text) => {
  if (readFileSync(file, "utf8") === text) return;
  writeFileSync(file, text);
  changed.add(file);
};
const heads = new Map();

// 1. Ledgers, with their blobs, in order, so later entries and anchors can follow the new hashes of earlier ones.
for (const ledger of files.filter((f) => basename(f) === "ledger.jsonl")) {
  const dir = dirname(ledger);
  const blobs = new Map();
  const onBlob = (ref) => {
    const hex = ref.$blob.replace("sha256:", "");
    if (!blobs.has(hex)) {
      const file = join(dir, "blobs", hex);
      const text = readFileSync(file, "utf8");
      const next = mapHex(redactText(text));
      if (next === text) blobs.set(hex, ref);
      else {
        const newHex = sha(next);
        writeFileSync(join(dir, "blobs", newHex), next);
        rmSync(file);
        changed.add(file);
        hexMap.set(hex, newHex);
        blobs.set(hex, { $blob: `sha256:${newHex}`, bytes: Buffer.byteLength(next) });
      }
    }
    return blobs.get(hex);
  };
  let prev = GENESIS;
  const lines = readFileSync(ledger, "utf8").split("\n").filter(Boolean);
  const out = lines.map((line) => {
    const entry = JSON.parse(line);
    const { hash: oldHash, ...rest } = entry;
    const next = { ...rest, prev, body: clean(entry.body, "body", onBlob) };
    const hash = entryHash(next);
    if (hash !== oldHash) hexMap.set(oldHash.replace("sha256:", ""), hash.replace("sha256:", ""));
    prev = hash;
    return canonicalJson({ ...next, hash });
  });
  const oldHead = JSON.parse(lines.at(-1)).hash;
  write(ledger, `${out.join("\n")}\n`);
  if (oldHead !== prev) heads.set(relative(root, ledger), { from: oldHead, to: prev });
}

// 2. Anchors follow the new hashes.
for (const file of files.filter((f) => basename(f) === "anchors.jsonl")) write(file, mapHex(readFileSync(file, "utf8")));

// 3. Receipts are cleaned and, when they were signed, signed again with this Candor home's key.
const home = candorHome();
const { publicDerBase64 } = ensureReceiptKey(home);
const newKey = keyId(publicDerBase64);
const keys = new Map();
const swaps = [];
for (const file of files.filter((f) => basename(f) === "receipt.json")) {
  const text = readFileSync(file, "utf8");
  const receipt = JSON.parse(text);
  const old = receipt.signature;
  if (old) hexMap.set(old.key_id.replace("sha256:", ""), newKey.replace("sha256:", ""));
  const { signature: _drop, ...body } = receipt;
  const next = clean(body);
  if (canonicalJson(next) === canonicalJson(body)) continue;
  if (old) {
    next.signature = signReceipt(home, next);
    keys.set(relative(root, file), { from: old.key_id, to: next.signature.key_id });
    swaps.push([old.public_key, next.signature.public_key], [old.value, next.signature.value]);
  }
  write(file, `${JSON.stringify(next, null, 2)}\n`);
}

// 4. Every other text file: session streams line by line, and the rest as text.
const skip = (f) => ["ledger.jsonl", "anchors.jsonl", "receipt.json", "REDACTED.md"].includes(basename(f)) || basename(dirname(f)) === "blobs";
for (const file of files.filter((f) => !skip(f) && existsSync(f))) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    const lines = text.split("\n").map((line) => {
      if (line.trim() === "" || (mapHex(redactText(line)) === line && !/"mcp_servers":\[\{|"mcp__/.test(line))) return line;
      try {
        return JSON.stringify(clean(JSON.parse(line)));
      } catch {
        return mapHex(redactText(line));
      }
    });
    write(file, lines.join("\n"));
  } else write(file, swaps.reduce((t, [from, to]) => t.split(from).join(to), mapHex(redactText(text))));
}

// 5. Documents and tests elsewhere in the repository that cite a digest that changed.
if (hexMap.size > 0) {
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f && !f.startsWith("results/") && /\.(md|ts|mjs|js|json|html|yaml)$/.test(f));
  for (const f of tracked) {
    const file = join(root, f);
    if (existsSync(file)) write(file, mapHex(readFileSync(file, "utf8")));
  }
}

// 6. A note in each run folder whose ledger or receipt changed.
for (const folder of folders) {
  const inFolder = (map) => [...map].filter(([f]) => resolve(root, f).startsWith(`${folder}/`));
  const h = inFolder(heads);
  const k = inFolder(keys);
  if (h.length === 0 && k.length === 0) continue;
  const note = [
    "# Personal details removed",
    "",
    "This run was recorded on the computer of the person who ran it. Before publication, `scripts/redact-results.mjs` replaced the user name in paths with `owner`, replaced the private temporary folder with `xx/redacted`, and dropped the names of MCP servers and MCP tools from the lists that hold them. Nothing else was changed.",
    "",
    "The ledger is hash chained, so the published ledger is a new chain: every entry from the first changed one on has a new hash, changed blobs are stored under their new hash, and the anchors follow. A signed receipt was signed again with a key made for the redaction. The published copy is tamper-evident from the redaction on. It is not the file the daemon wrote. That person keeps the original files, and the old heads and keys below match them.",
    "",
    ...h.map(([f, { from, to }]) => `- \`${relative(folder, resolve(root, f))}\`: head ${from} is now ${to}`),
    ...k.map(([f, { from, to }]) => `- \`${relative(folder, resolve(root, f))}\`: signing key ${from} is now ${to}`),
    "",
  ].join("\n");
  writeFileSync(join(folder, "REDACTED.md"), note);
  changed.add(join(folder, "REDACTED.md"));
}

process.stdout.write(`${changed.size} files changed. ${hexMap.size} digests changed.${keys.size > 0 ? ` Receipts signed again with key ${newKey}.` : ""}\n`);
for (const f of [...changed].sort()) process.stdout.write(`  ${relative(root, f)}\n`);
