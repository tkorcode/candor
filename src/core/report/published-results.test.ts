import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Recorded runs are published without details of the computer they ran on (D-086). A run recorded on a Mac names
 * the home folder, the private temporary folder and every MCP server and tool set up there. scripts/redact-results.mjs
 * removes them. This test fails if a run in results/ still holds one.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const files = walk(join(root, "results"))
  .map((file) => ({ file: relative(root, file), bytes: readFileSync(file) }))
  .filter(({ bytes }) => !bytes.includes(0))
  .map(({ file, bytes }) => ({ file, text: bytes.toString("utf8") }));

const RULES: Array<[string, RegExp]> = [
  ["no home folder other than /Users/owner", /\/Users\/(?!owner\/|owner\b|Shared\b)[^/"'\s\\<>]+|-Users-(?!owner-)[A-Za-z0-9]/],
  ["no private temporary folder", /var[/-]folders[/-](?!xx[/-]redacted)[A-Za-z0-9_+]{2}[/-]/],
  ["no MCP tool name", /mcp__[A-Za-z0-9]/],
  ["no list of MCP servers that is not empty", /"mcp_servers"\s*:\s*\[\s*\{/],
];

describe("the recorded runs in results/", () => {
  it("are read by this test", () => {
    expect(files.some((f) => f.file.endsWith("ledger.jsonl"))).toBe(true);
  });

  it.each(RULES)("hold %s", (_what, pattern) => {
    expect(files.filter(({ text }) => pattern.test(text)).map(({ file }) => file)).toEqual([]);
  });
});
