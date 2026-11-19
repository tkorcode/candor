import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPath, runDir } from "../paths.js";
import { Ledger } from "../ledger/ledger.js";
import { createRedactor } from "../ledger/redact.js";
import { loadCharterFile } from "./file.js";
import { mergeReview, openItems, type ReviewRecord, ReviewRecordSchema, reviewCharter, reviewDigest } from "./review.js";
import { type Charter, charterHash } from "./schema.js";

/** The charter is stored as written, because its hash covers the exact text. So it must not hold a secret. */
export function assertNoSecrets(charter: Charter): void {
  const redactor = createRedactor();
  if (JSON.stringify(redactor.value(charter)) !== JSON.stringify(charter)) {
    throw new Error("The charter contains text that looks like a secret or personal data, such as a key, a token or an email address. Remove it from the charter file. Candor stores the charter as written and will not write a secret to disk.");
  }
}

const reviewsDir = (home: string): string => join(home, "reviews");
const reviewFile = (home: string, charterId: string): string => join(reviewsDir(home), `${charterId}.json`);

function readReview(home: string, charter: Charter): ReviewRecord | null {
  const file = reviewFile(home, charter.id);
  if (!existsSync(file)) return null;
  const parsed = ReviewRecordSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`The review record ${file} is not in the format Candor writes, so it cannot be trusted. Delete it and run the review again.`);
  return parsed.data;
}

/**
 * One pass of the review. The record of what was seen, fixed and accepted is
 * kept in the Candor home, outside the workspace, because the operator owns it.
 */
export function reviewCharterFile(home: string, file: string, accept: Record<string, string> = {}): { charter: Charter; record: ReviewRecord; open: ReviewRecord["items"] } {
  const charter = loadCharterFile(file);
  assertNoSecrets(charter);
  const record = mergeReview(reviewCharter(charter), readReview(home, charter), accept);
  mkdirSync(reviewsDir(home), { recursive: true, mode: 0o700 });
  const target = reviewFile(home, charter.id);
  writeFileSync(`${target}.tmp`, JSON.stringify(createRedactor().value(record), null, 2), { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
  return { charter, record, open: openItems(record) };
}

export interface Approval {
  run: string;
  charterHash: string;
  reviewDigest: string;
  ledger: string;
}

/**
 * Approval writes the charter hash as the first ledger entry of a new run,
 * then the review. It needs a review on record and no open items. It writes
 * the ledger itself, because no daemon runs for the run before it is approved.
 */
export function approveCharterFile(home: string, file: string, options: { run?: string; now?: () => Date } = {}): Approval {
  const charter = loadCharterFile(file);
  assertNoSecrets(charter);
  const record = readReview(home, charter);
  if (record === null) throw new Error(`The charter ${charter.id} has not been reviewed. Run: candor charter review ${file}`);
  // Review again from the file as it is now, so an edit after the last review cannot slip through.
  const current = mergeReview(reviewCharter(charter), record, {});
  const open = openItems(current);
  if (open.length > 0) {
    throw new Error(
      `The charter has ${open.length} review item${open.length === 1 ? "" : "s"} that nobody has resolved:\n${open.map((item) => `  - ${item.id}: ${item.message}`).join("\n")}\nFix the charter, or accept an item with: candor charter review ${file} --accept <id>="<reason>"`,
    );
  }
  const run = options.run ?? `r_${randomBytes(2).toString("hex")}`;
  if (!/^r_[a-z0-9]+$/.test(run)) throw new Error(`The run id ${run} is not valid. Use r_ followed by lower case letters and digits.`);
  const path = ledgerPath(home, run);
  if (existsSync(path)) throw new Error(`Run ${run} already has a ledger. Choose another run id, or leave --run out.`);
  mkdirSync(runDir(home, run), { recursive: true, mode: 0o700 });

  const hash = charterHash(charter);
  const stored = createRedactor().value(current);
  const digest = reviewDigest(stored);
  const ledger = Ledger.open({ path, run, now: options.now });
  // The charter hash is the first entry, as the spec requires. The review it was approved with follows and carries the same digest.
  ledger.append({ type: "charter_approved", actor: "operator", body: { charter_id: charter.id, version: charter.version, charter_hash: hash, review_digest: digest } });
  ledger.append({ type: "charter_review", actor: "operator", body: { charter_hash: hash, review_digest: digest, items: stored.items } });
  writeFileSync(join(runDir(home, run), `charter.v${charter.version}.json`), JSON.stringify(charter, null, 2), { mode: 0o400 });
  return { run, charterHash: hash, reviewDigest: digest, ledger: path };
}
