import { describe, expect, it } from "vitest";
import { charterFor, draft } from "./host.js";

describe("the charter a Claude Code job runs", () => {
  it("keeps what the reader set: goal, rules, scope, levels, budget and checks turned off", () => {
    const { charter } = charterFor(
      {
        goal: "Move the service to ES modules and nothing else.",
        rules: [{ dimension: "scope", text: "Never change README.md or legacy/." }],
        allow: ["src/**", "tests/**"],
        deny: ["legacy/**"],
        warn: 0.3,
        pause: 0.5,
        max_turns: 40,
        max_cost_usd: 2,
        checks: { "legacy-loads": false, "api-unchanged": false },
      },
      "claude-code",
    );
    expect(charter.goal).toBe("Move the service to ES modules and nothing else.");
    expect(charter.drift_rules.map((r) => r.text)).toEqual(["Never change README.md or legacy/."]);
    expect(charter.scope.allow_paths).toEqual(["src/**", "tests/**", "reports/**"]);
    expect(charter.scope.deny_paths).toEqual(["legacy/**"]);
    expect(charter.thresholds).toEqual({ warn: 0.3, pause: 0.5 });
    expect(charter.budget).toMatchObject({ max_turns: 40, max_cost_usd: 2 });
    const ids = charter.checks.map((c) => c.id);
    expect(ids).toContain("tests-pass");
    expect(ids).not.toContain("legacy-loads");
    expect(ids).not.toContain("api-unchanged");
  });

  it("gives a Claude Code job a larger budget only when the reader set none", () => {
    expect(charterFor({}, "claude-code").charter.budget.max_cost_usd).toBe(3);
    expect(charterFor({}, "api").charter.budget.max_cost_usd).toBe(1);
  });

  it("gives the default charter the budget of the chosen worker", async () => {
    expect((await draft("Move to ES modules.", {}, { worker: "claude-code", plain: true })).charter.budget.max_cost_usd).toBe(3);
    expect((await draft("Move to ES modules.", {}, { worker: "api", plain: true })).charter.budget.max_cost_usd).toBe(1);
  });

  it("holds a deletion as rm and git rm, and says a held write is not enforced", () => {
    const { charter, unenforced } = charterFor({ hold: ["delete_file *", "write_file package.json"] }, "claude-code");
    expect(charter.irreversible).toEqual(["rm *", "git rm *"]);
    expect(unenforced).toEqual(["write_file package.json"]);
  });
});
