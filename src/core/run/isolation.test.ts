import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { userIsolation } from "./isolation.js";
import { buildWorkerSettings } from "./settings.js";

const env = { CANDOR_ISOLATION: "users", CANDOR_AGENT_UID: "1001", CANDOR_AGENT_GID: "1001", CANDOR_WORKER_UID: "1002", CANDOR_WORKER_GID: "1003" };
const root = typeof process.getuid === "function" && process.getuid() === 0;

describe("separate users in a container", () => {
  it("is off unless CANDOR_ISOLATION=users", () => {
    expect(userIsolation({})).toBeNull();
  });

  it.runIf(root)("reads the users and the shell prefix", () => {
    expect(userIsolation(env)).toEqual({ agent: { uid: 1001, gid: 1001, home: "/home/agent" }, worker: { uid: 1002, gid: 1003 }, shellPrefix: "/opt/candor/as-worker" });
  });

  it.runIf(root)("refuses root as the agent or the worker", () => {
    expect(() => userIsolation({ ...env, CANDOR_WORKER_UID: "0" })).toThrow(/other than root/);
    expect(() => userIsolation({ ...env, CANDOR_AGENT_UID: "" })).toThrow(/CANDOR_AGENT_UID/);
  });

  it.runIf(!root)("refuses to run when Candor is not root, because the worker could then reach its files", () => {
    expect(() => userIsolation(env)).toThrow(/root/);
  });

  it("turns Claude Code's sandbox off and keeps the permission rules and hooks", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "candor-iso-")));
    const settings = buildWorkerSettings({ home, candorBin: "/opt/candor/bin/candor.js", usersIsolation: true }) as { sandbox: { enabled: boolean }; permissions: { deny: string[] }; hooks: Record<string, unknown> };
    expect(settings.sandbox).toEqual({ enabled: false });
    expect(settings.permissions.deny).toContain(`Read(/${join(home, "operator.key")})`);
    expect(Object.keys(settings.hooks)).toContain("PreToolUse");
  });
});
