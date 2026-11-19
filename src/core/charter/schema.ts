import { z } from "zod";
import { digest } from "../canonical.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "An id uses lower case letters, digits, hyphens and underscores.");

const Check = z
  .object({
    id,
    type: z.enum(["command", "pattern"]),
    run: z.string().min(1).optional(),
    paths: z.array(z.string()).optional(),
    deny: z.string().min(1).optional(),
    when: z.enum(["checkpoint", "every_action", "final"]),
    /** A command that plants a known fault in a disposable copy of the workspace. The check must fail on it. */
    fault: z.string().min(1).nullish(),
  })
  .strict()
  .superRefine((check, ctx) => {
    if (check.type === "command" && !check.run) ctx.addIssue({ code: "custom", message: `Check ${check.id} is a command check and needs a run command.` });
    if (check.type === "pattern" && (!check.deny || !check.paths?.length)) ctx.addIssue({ code: "custom", message: `Check ${check.id} is a pattern check and needs paths and a deny pattern.` });
  });

export const CharterSchema = z
  .object({
    id,
    version: z.number().int().positive(),
    goal: z.string().min(1),
    success: z.array(z.object({ id, text: z.string().min(1), check: id.nullable() }).strict()).min(1, "A charter needs at least one success criterion."),
    scope: z
      .object({
        allow_paths: z.array(z.string()),
        deny_paths: z.array(z.string()),
        allow_commands: z.array(z.string()),
        network: z.boolean(),
      })
      .strict(),
    budget: z.object({ max_cost_usd: z.number().positive(), max_turns: z.number().int().positive(), max_minutes: z.number().positive() }).strict(),
    stages: z
      // `description` says what the stage is for, in plain words, for the people who read the run. It is optional.
      .array(z.object({ id, title: z.string().min(1), description: z.string().min(1).max(600).optional(), exit_checks: z.array(id), irreversible: z.boolean().optional() }).strict())
      .min(1, "A charter needs at least one stage."),
    checks: z.array(Check),
    drift_rules: z.array(z.object({ id, dimension: z.enum(["goal", "scope", "plan", "evidence"]), source: z.enum(["generated", "operator", "restart"]), text: z.string().min(1) }).strict()),
    thresholds: z.object({ warn: z.number().min(0).max(1), pause: z.number().min(0).max(1) }).strict(),
    irreversible: z.array(z.string()),
    escalation: z.object({ on_pause: z.literal("operator") }).strict(),
  })
  .strict()
  .superRefine((charter, ctx) => {
    const duplicate = (kind: string, ids: string[]): void => {
      const seen = new Set<string>();
      for (const item of ids) {
        if (seen.has(item)) ctx.addIssue({ code: "custom", message: `The ${kind} id ${item} is used twice.` });
        seen.add(item);
      }
    };
    duplicate("success criterion", charter.success.map((s) => s.id));
    duplicate("stage", charter.stages.map((s) => s.id));
    duplicate("check", charter.checks.map((c) => c.id));
    duplicate("drift rule", charter.drift_rules.map((r) => r.id));
    const checks = new Set(charter.checks.map((c) => c.id));
    for (const criterion of charter.success) {
      if (criterion.check !== null && !checks.has(criterion.check)) ctx.addIssue({ code: "custom", message: `Success criterion ${criterion.id} names check ${criterion.check}, which the charter does not define.` });
    }
    for (const stage of charter.stages) {
      for (const check of stage.exit_checks) {
        if (!checks.has(check)) ctx.addIssue({ code: "custom", message: `Stage ${stage.id} names exit check ${check}, which the charter does not define.` });
      }
    }
    if (charter.thresholds.warn >= charter.thresholds.pause) ctx.addIssue({ code: "custom", message: "The warn threshold must be below the pause threshold." });
  });

export type Charter = z.infer<typeof CharterSchema>;

/** The hash that goes in the ledger: SHA-256 of the canonical JSON of the validated charter. Comments and layout in the file do not change it. */
export function charterHash(charter: Charter): string {
  return digest(charter);
}

export class CharterInvalid extends Error {
  constructor(readonly issues: string[]) {
    super(`The charter is not valid:\n${issues.map((i) => `  - ${i}`).join("\n")}\nFix these in the charter file, then run the command again.`);
    this.name = "CharterInvalid";
  }
}

export function parseCharter(raw: unknown): Charter {
  const result = CharterSchema.safeParse(raw);
  if (!result.success) throw new CharterInvalid(result.error.issues.map((issue) => `${issue.path.join(".") || "charter"}: ${issue.message}`));
  return result.data;
}
