import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projects = JSON.parse(readFileSync("site/projects.json", "utf8")).projects as { id: string; samples: { file: string; code: string }[] }[];

describe("the project pages of the workspace", () => {
  it("copies each code sample from the file it names, so a sample cannot go stale", () => {
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects)
      for (const s of p.samples) {
        const source = readFileSync(s.file, "utf8");
        for (const part of s.code.split("\n")) expect(source, `${p.id}: ${s.file}`).toContain(part);
      }
  });
});
