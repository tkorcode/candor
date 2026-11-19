import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type ClaudeCall, claudeArgs, runClaude } from "./claude.js";

const call = (dir: string, command?: string): ClaudeCall => ({
  cwd: dir,
  prompt: "Do the stage.",
  appendSystemPrompt: "",
  model: "claude-haiku-5-5",
  settingsFile: join(dir, "settings.json"),
  maxBudgetUsd: 0.5,
  maxTurns: 10,
  tools: ["Read", "Write"],
  env: { PATH: process.env.PATH ?? "", ENABLE_CLAUDEAI_MCP_SERVERS: "true" },
  ...(command ? { command } : {}),
});

describe("the worker command line", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-args-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loads no MCP server: --strict-mcp-config with no --mcp-config", () => {
    const args = claudeArgs(call(dir));
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });

  it("keeps the flag when a session is resumed or forked", () => {
    expect(claudeArgs({ ...call(dir), resume: "s1", fork: { atMessage: "m1" } })).toContain("--strict-mcp-config");
  });

  it("turns off claude.ai connectors in the environment of the worker, whatever the caller passed", async () => {
    const fake = join(dir, "fake-claude.sh");
    writeFileSync(fake, `#!/bin/sh\necho "$ENABLE_CLAUDEAI_MCP_SERVERS" > "${join(dir, "seen")}"\n`);
    chmodSync(fake, 0o755);
    const handlers = { onInit: () => {}, onAssistant: () => {}, onResult: () => {} };
    await runClaude(call(dir, fake), handlers);
    expect(readFileSync(join(dir, "seen"), "utf8").trim()).toBe("false");
  });
});
