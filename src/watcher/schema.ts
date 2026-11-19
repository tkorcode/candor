import { z } from "zod";

/** Spec 5.4. Scale 0 (on course) to 1 (off course). */
export const DIMENSIONS = ["goal", "scope", "plan", "evidence"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const levelSchema = z.enum(["ok", "warn", "pause"]);
export type Level = z.infer<typeof levelSchema>;

export const thresholdsSchema = z
  .object({ warn: z.number().min(0).max(1), pause: z.number().min(0).max(1) })
  .refine((t) => t.warn <= t.pause, { message: "warn must not be above pause" });
export type Thresholds = z.infer<typeof thresholdsSchema>;

/** Placeholder values from the spec. Real values come from calibration. */
export const DEFAULT_THRESHOLDS: Thresholds = { warn: 0.35, pause: 0.6 };

const score = z.number().min(0).max(1);

export const driftScoreSchema = z.object({
  checkpoint: z.string(),
  charter_version: z.number().int(),
  judge_model: z.string(),
  dimensions: z.object({ goal: score, scope: score, plan: score, evidence: score }),
  overall: score,
  level: levelSchema,
  findings: z.array(
    z.object({
      rule: z.string(),
      severity: z.enum(["low", "medium", "high"]),
      summary: z.string(),
      entries: z.array(z.number().int()).min(1),
    }),
  ),
});
export type DriftScore = z.infer<typeof driftScoreSchema>;

/** The overall value is the maximum of the dimensions. One bad dimension is not averaged away. */
export function overallOf(dimensions: Record<Dimension, number>): number {
  return Math.max(...DIMENSIONS.map((d) => dimensions[d]));
}

export function levelFor(overall: number, thresholds: Thresholds): Level {
  if (overall >= thresholds.pause) return "pause";
  if (overall >= thresholds.warn) return "warn";
  return "ok";
}

export const driftRuleSchema = z.object({ id: z.string(), dimension: z.enum(DIMENSIONS), text: z.string() });

export const judgeInputSchema = z.object({
  charter: z.object({
    goal: z.string(),
    scope: z.string(),
    drift_rules: z.array(driftRuleSchema),
    thresholds: thresholdsSchema,
    version: z.number().int(),
  }),
  stage: z.object({ id: z.string(), title: z.string(), exit_checks: z.array(z.string()) }),
  checkpoint: z.string(),
  evidence: z.array(z.object({ seq: z.number().int(), type: z.string(), actor: z.string(), body: z.string() })),
});
export type JudgeInput = z.infer<typeof judgeInputSchema>;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  model: string;
}

export interface JudgeResult {
  score: DriftScore;
  usage: Usage;
  rubric_hash: string;
  /** Findings the watcher returned that cited no valid ledger entry or an unknown rule. They are dropped from the score. */
  dropped_findings: number;
  /** Evidence entries of a reasoning type that were never sent to the watcher. */
  withheld_entries: number;
}

/** What the model must return. The code, not the model, computes overall and level. */
export const modelOutputSchema = z.object({
  dimensions: z.object({ goal: z.number(), scope: z.number(), plan: z.number(), evidence: z.number() }),
  findings: z.array(
    z.object({
      rule: z.string(),
      severity: z.enum(["low", "medium", "high"]),
      summary: z.string(),
      entries: z.array(z.number().int()),
    }),
  ),
});

/** The same shape as a JSON schema for the structured output of the API. */
export const MODEL_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dimensions", "findings"],
  properties: {
    dimensions: {
      type: "object",
      additionalProperties: false,
      required: [...DIMENSIONS],
      properties: Object.fromEntries(DIMENSIONS.map((d) => [d, { type: "number" }])),
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rule", "severity", "summary", "entries"],
        properties: {
          rule: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          summary: { type: "string" },
          entries: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
} as const;
