import { z } from "zod";

/** The first entry of every ledger points at this value. */
export const GENESIS = `sha256:${"0".repeat(64)}`;

export const ENTRY_TYPES = [
  "run_start",
  "session_start",
  "charter_approved",
  "tool_intent",
  "tool_result",
  "verdict",
  "check_result",
  "stage_report",
  "checkpoint",
  "drift_score",
  "rule_change",
  "rescore",
  "restart",
  "effect",
  "human_action",
  "config_change",
  "hook_event",
  "heartbeat",
  "anchor",
  "charter_review",
  "check_strength",
  "acceptance_result",
  "receipt_issued",
  "receipt_amended",
  "run_end",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const ACTORS = ["worker", "operator", "candord", "watcher"] as const;
export type Actor = (typeof ACTORS)[number];

/**
 * Which actor may write which entry type. The daemon sets the actor from the
 * channel an event arrived on, so a type written by the wrong actor means a
 * forged entry or a bug. Both append and verify enforce this table.
 */
export const ALLOWED_ACTORS: Record<EntryType, readonly Actor[]> = {
  run_start: ["candord"],
  session_start: ["worker", "candord"],
  charter_approved: ["operator"],
  tool_intent: ["worker"],
  tool_result: ["worker"],
  verdict: ["watcher"],
  check_result: ["candord"],
  stage_report: ["worker"],
  checkpoint: ["candord"],
  drift_score: ["watcher"],
  rule_change: ["operator"],
  rescore: ["watcher"],
  restart: ["operator"],
  effect: ["candord"],
  // A refused operator action is recorded with the worker as the actor.
  human_action: ["operator", "worker"],
  config_change: ["worker"],
  hook_event: ["worker"],
  heartbeat: ["candord"],
  anchor: ["candord"],
  charter_review: ["operator"],
  check_strength: ["candord"],
  acceptance_result: ["candord"],
  receipt_issued: ["operator"],
  receipt_amended: ["operator"],
  run_end: ["candord"],
};

const digestString = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const Digest = digestString;

export const EntrySchema = z
  .object({
    seq: z.number().int().positive(),
    ts: z.string().datetime(),
    run: z.string().min(1),
    branch: z.string().min(1).optional(),
    type: z.enum(ENTRY_TYPES),
    actor: z.enum(ACTORS),
    body: z.record(z.string(), z.unknown()),
    prev: digestString,
    hash: digestString,
  })
  .strict();
export type LedgerEntry = z.infer<typeof EntrySchema>;

/** A pointer to a payload kept in the blob store. */
export interface BlobRef {
  $blob: string;
  bytes: number;
}

/** Bodies with a fixed shape. Other types take any record until the milestone that produces them. */
export const BODY_SCHEMAS: Partial<Record<EntryType, z.ZodType>> = {
  charter_approved: z.object({ charter_id: z.string(), version: z.number().int().positive(), charter_hash: digestString, review_digest: digestString }).strict(),
  anchor: z.object({ anchored_seq: z.number().int().positive(), anchored_hash: digestString, kind: z.enum(["file", "git"]) }).strict(),
};
