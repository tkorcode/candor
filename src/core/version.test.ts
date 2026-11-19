import { describe, expect, it } from "vitest";
import { checkClaudeCodeVersion, compareVersions, parseVersion } from "./version.js";

describe("Claude Code version check", () => {
  it("reads the version from the command output", () => {
    expect(parseVersion("2.1.327 (Claude Code)")).toEqual([2, 1, 327]);
    expect(parseVersion("no version here")).toBeNull();
  });

  it("orders versions by number, not by text", () => {
    expect(compareVersions([2, 1, 295], [2, 1, 30])).toBeGreaterThan(0);
    expect(compareVersions([2, 1, 294], [2, 1, 295])).toBeLessThan(0);
    expect(compareVersions([2, 1, 295], [2, 1, 295])).toBe(0);
  });

  it("refuses a version below the minimum and says what to do", () => {
    const result = checkClaudeCodeVersion("2.1.294 (Claude Code)");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Update Claude Code/);
  });

  it("accepts the minimum and later versions", () => {
    expect(checkClaudeCodeVersion("2.1.295 (Claude Code)").ok).toBe(true);
    expect(checkClaudeCodeVersion("2.2.0").ok).toBe(true);
  });

  it("refuses when Claude Code is not found", () => {
    expect(checkClaudeCodeVersion(null).ok).toBe(false);
  });
});
