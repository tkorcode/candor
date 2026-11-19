import { z } from "zod";
import { digest } from "../canonical.js";
import type { Charter } from "./schema.js";

/**
 * The challenge to a draft charter before approval. It is rule based and needs
 * no model. It lists what a person should look at: a vague goal, a vague
 * criterion, a criterion with no check, a check with no planted fault, a stage
 * with no exit check, and a scope that allows every path. The operator fixes
 * the charter or accepts each item with a reason, and the review is a ledger
 * entry.
 */
export const REVIEW_KINDS = ["vague_goal", "vague_criterion", "unchecked_criterion", "check_without_fault", "stage_without_exit_check", "broad_scope"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export interface ReviewItem {
  /** Stable across edits: kind and subject. The operator names an item by this id. */
  id: string;
  kind: ReviewKind;
  subject: string;
  message: string;
  /** The text under review. An acceptance holds only while this text is unchanged. */
  basis: string;
}

export const ResolutionSchema = z.union([
  z.object({ status: z.literal("fixed") }).strict(),
  z.object({ status: z.literal("accepted"), reason: z.string().trim().min(1), basis_digest: z.string() }).strict(),
]);

/** Words that name no outcome. A goal or criterion built on them cannot be checked. */
const VAGUE_TERMS = [
  "improve", "improved", "better", "enhance", "optimize", "optimise", "clean up", "cleanup", "tidy", "fix things", "handle", "as needed", "as appropriate",
  "appropriate", "properly", "good", "nice", "robust", "etc", "and so on", "whatever", "stuff", "things", "reasonable", "high quality", "make it work", "works well",
];
export function vagueTerms(text: string): string[] {
  const lower = ` ${text.toLowerCase()} `;
  return VAGUE_TERMS.filter((term) => new RegExp(`[^a-z]${term.replace(/ /g, "\\s+")}[^a-z]`).test(lower));
}

function wordCount(text: string): number {
  return (text.match(/[A-Za-z0-9_]+/g) ?? []).length;
}

export function reviewCharter(charter: Charter): ReviewItem[] {
  const items: ReviewItem[] = [];
  const bases: Record<string, string> = { goal: charter.goal, allow_paths: charter.scope.allow_paths.join("\n") };
  for (const c of charter.success) bases[c.id] = `${c.text}\n${c.check ?? ""}`;
  for (const c of charter.checks) bases[c.id] = `${c.run ?? c.deny ?? ""}\n${c.fault ?? ""}`;
  for (const st of charter.stages) bases[st.id] = `${st.title}\n${st.exit_checks.join(",")}`;
  const add = (kind: ReviewKind, subject: string, message: string): void => {
    items.push({ id: `${kind}:${subject}`, kind, subject, message, basis: bases[subject] ?? "" });
  };

  const goalVague = vagueTerms(charter.goal);
  if (wordCount(charter.goal) < 6) add("vague_goal", "goal", "The goal is very short. Say what is changed, in what, and what must be true at the end.");
  else if (goalVague.length > 0) add("vague_goal", "goal", `The goal uses words that name no outcome (${goalVague.join(", ")}). Say what must be true at the end.`);

  for (const criterion of charter.success) {
    const terms = vagueTerms(criterion.text);
    if (terms.length > 0) add("vague_criterion", criterion.id, `Success criterion ${criterion.id} uses words that name no outcome (${terms.join(", ")}). State something a check could pass or fail.`);
    else if (wordCount(criterion.text) < 4) add("vague_criterion", criterion.id, `Success criterion ${criterion.id} is too short to check. Say what must be true and how a person would tell it failed.`);
    if (criterion.check === null) add("unchecked_criterion", criterion.id, `Success criterion ${criterion.id} has no check. The receipt will list it as not verified unless you add one.`);
  }

  for (const check of charter.checks) {
    if (!check.fault) add("check_without_fault", check.id, `Check ${check.id} has no planted fault, so nothing shows that it can fail. The receipt will mark it unproven.`);
  }

  for (const stage of charter.stages) {
    if (stage.exit_checks.length === 0) add("stage_without_exit_check", stage.id, `Stage ${stage.id} has no exit check, so nothing independent of the worker says that it is done.`);
  }

  if (charter.scope.allow_paths.some((path) => path === "**" || path === "**/*" || path === "*")) {
    add("broad_scope", "allow_paths", "The scope allows every path in the workspace. Name the folders the job may change, so a change outside them counts as drift.");
  }
  return items;
}

export const ReviewRecordSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.enum(REVIEW_KINDS), subject: z.string(), message: z.string(), basis: z.string(), resolution: ResolutionSchema.nullable() }).strict()),
}).strict();
/** Every item seen in any pass, with how it ended. */
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

/**
 * Merges the items of the current pass with what was seen before. An item that
 * was seen and is gone now counts as fixed. An item still present stays open
 * unless the operator accepted it with a reason.
 */
export function mergeReview(current: ReviewItem[], previous: ReviewRecord | null, accept: Record<string, string>): ReviewRecord {
  const now = new Map(current.map((item) => [item.id, item]));
  const out = new Map<string, ReviewRecord["items"][number]>();
  for (const old of previous?.items ?? []) {
    if (!now.has(old.id)) out.set(old.id, { ...old, resolution: { status: "fixed" } });
    else {
      const item = now.get(old.id) as ReviewItem;
      // An acceptance holds only while the text it was given for is unchanged.
      const holds = old.resolution?.status === "accepted" && old.resolution.basis_digest === digest(item.basis);
      out.set(old.id, { ...old, resolution: holds ? old.resolution : null });
    }
  }
  for (const item of current) {
    const kept = out.get(item.id);
    out.set(item.id, { ...item, resolution: kept?.resolution ?? null });
  }
  for (const [id, reason] of Object.entries(accept)) {
    const item = out.get(id);
    if (!item || !now.has(id)) throw new Error(`There is no open review item ${id}. Run candor charter review to see the item ids.`);
    if (reason.trim().length === 0) throw new Error(`Accepting ${id} needs a reason, so the receipt can say why it was left.`);
    out.set(id, { ...item, resolution: { status: "accepted", reason: reason.trim(), basis_digest: digest((now.get(id) as ReviewItem).basis) } });
  }
  return { items: [...out.values()] };
}

export function openItems(record: ReviewRecord): ReviewRecord["items"] {
  return record.items.filter((item) => item.resolution === null);
}

export function reviewDigest(record: ReviewRecord): string {
  return digest(record);
}
