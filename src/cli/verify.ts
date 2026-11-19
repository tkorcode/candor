import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAnchors } from "../core/anchor/file.js";
import { composeReceipt } from "../core/report/receipt.js";
import { checkSignature, localKeyId } from "../core/report/sign.js";
import { canonicalJson } from "../core/canonical.js";
import { anchorPath, blobDirPath, ledgerPath } from "../core/paths.js";
import { verifyFile } from "../core/ledger/verify.js";

/**
 * Verifies a ledger given a run id in the Candor home, or a path to a ledger
 * file. Exit 0 when it verifies, 1 when it does not, with the first bad entry.
 */
export function runVerify(home: string, args: string[]): number {
  const valued = ["--anchors", "--ledger", "--key-id"];
  const target = args.find((arg, i) => !arg.startsWith("--") && !valued.includes(args[i - 1] ?? ""));
  if (!target) {
    process.stderr.write("Usage: candor verify <receipt.json | run id | ledger file> [--anchors <file>] [--ledger <file>] [--key-id <id>]\n");
    return 2;
  }
  if (existsSync(target) && target.endsWith(".json")) return verifyReceipt(home, target, args);
  const asRun = /^r_[a-z0-9]+$/.test(target) && !existsSync(target);
  const ledger = asRun ? ledgerPath(home, target) : target;
  const given = args.indexOf("--anchors") >= 0 ? args[args.indexOf("--anchors") + 1] : undefined;
  const anchors = given ?? (asRun ? anchorPath(home, target) : undefined);
  const blobDir = asRun ? blobDirPath(home, target) : join(dirname(target), "blobs");
  const result = verifyFile(ledger, { anchorsPath: anchors, blobDir, ...(asRun ? { expectedRun: target } : {}) });
  if (!result.ok) {
    process.stdout.write(`FAILED. First bad entry: ${result.firstBadSeq}\n${result.reason}\n`);
    return 1;
  }
  const checked = anchors && existsSync(anchors) ? readAnchors(anchors).length : 0;
  process.stdout.write(
    `The ledger verifies: ${result.entries} entries, head ${result.head}.\n` +
      (checked > 0
        ? `${checked} anchor${checked === 1 ? "" : "s"} from outside the ledger matched.\n`
        : "No anchor file was checked, so this shows the chain is consistent, not that it is the chain that was first written.\n") +
      (checked > 0 ? "This is evidence that the record has not changed since it was anchored. " : "") +
      "It does not show that every event was recorded, or that a tool did what it reported.\n",
  );
  return 0;
}

const optionOf = (args: string[], name: string): string | undefined => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);

/**
 * `candor verify receipt.json`. Three checks, each reported on its own line:
 *   1. the signature over the receipt,
 *   2. the hash chain of the ledger, and that the receipt names an entry of that chain,
 *   3. the anchors.
 * Then it says plainly what a pass does and does not show. Exit 0 only when all three passed. Exit 1 when any
 * check failed. Exit 3 when the signature is good but no ledger could be found, so the chain was not checked.
 */
function verifyReceipt(home: string, file: string, args: string[]): number {
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    out(`FAILED. ${file} is not valid JSON.`);
    return 1;
  }
  if (receipt.kind !== "candor-receipt") {
    out(`FAILED. ${file} is not a Candor receipt.`);
    return 1;
  }
  if (args.includes("--key-id") && !optionOf(args, "--key-id")?.startsWith("sha256:")) {
    out("--key-id needs a value of the form sha256:<64 hex characters>.");
    return 2;
  }
  let failed = false;
  let partial = false;
  const integrity = (receipt.integrity ?? {}) as { head?: string | null; head_seq?: number; anchor_records?: { seq: number; head: string }[] };
  const run = String(receipt.run ?? "");

  // 1. Signature.
  const sig = checkSignature(receipt);
  if (sig.ok) {
    const local = localKeyId(home);
    const pinned = optionOf(args, "--key-id");
    out(`PASS  signature: the receipt is unchanged since it was signed. Key ${sig.key_id}.`);
    if (pinned !== undefined) {
      if (pinned === sig.key_id) out("PASS  signer: the key is the one you named with --key-id. Verify cannot tell where you got that id. It is only as good as the route it came by.");
      else {
        failed = true;
        out("FAIL  signer: the key is not the one you named with --key-id.");
      }
    } else if (local === sig.key_id) out("PASS  signer: this is the signing key of this machine.");
    else if (local !== null) {
      failed = true;
      out("FAIL  signer: this is NOT the signing key of this machine. Someone else signed it, or it came from another machine. If that is expected, name the key with --key-id.");
    } else {
      partial = true;
      out("SKIP  signer: this machine has no signing key to compare with, and the key travels inside the receipt. Anyone can re-sign an edited receipt with a key of their own. Pass --key-id <id> with the id you got from the issuer.");
    }
  } else {
    failed = true;
    out(`FAIL  signature: ${sig.reason}`);
  }

  // 2 and 3. Chain and anchors. The home of this machine comes first, then files beside the receipt, then flags.
  const beside = dirname(file);
  const homeLedger = run && /^r_[a-z0-9]+$/.test(run) ? ledgerPath(home, run) : null;
  const givenLedger = optionOf(args, "--ledger");
  let ledger: string | null = null;
  let anchors: string | undefined;
  let source = "";
  if (givenLedger) {
    ledger = givenLedger;
    anchors = optionOf(args, "--anchors");
    source = "the files you named";
  } else if (homeLedger && existsSync(homeLedger)) {
    ledger = homeLedger;
    anchors = anchorPath(home, run);
    source = "the Candor home of this machine, which is where the anchors were written";
  } else if (existsSync(join(beside, "ledger.jsonl"))) {
    ledger = join(beside, "ledger.jsonl");
    anchors = existsSync(join(beside, "anchors.jsonl")) ? join(beside, "anchors.jsonl") : undefined;
    source = "the copies beside the receipt, so the anchors are copies and not independent of the ledger";
  }
  if (ledger === null) {
    out("SKIP  chain and anchors: no ledger was found in the Candor home or beside the receipt. Give one with --ledger <file> [--anchors <file>].");
    out("");
    out(failed ? "RESULT: FAILED" : "RESULT: PARTLY CHECKED. Only the signature was checked.");
    return failed ? 1 : 3;
  }
  const blobDir = givenLedger ? join(dirname(givenLedger), "blobs") : ledger === homeLedger ? blobDirPath(home, run) : join(beside, "blobs");
  const result = verifyFile(ledger, { anchorsPath: anchors, blobDir, expectedRun: run });
  if (!result.ok) {
    failed = true;
    out(`FAIL  chain: first bad entry ${result.firstBadSeq}. ${result.reason}`);
  } else {
    out(`PASS  chain: ${result.entries} entries link up and match their hashes. Read from ${source}.`);
    const entries = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { seq: number; hash: string });
    const at = integrity.head_seq ?? 0;
    if (integrity.head && entries[at - 1]?.hash === integrity.head) out(`PASS  receipt head: entry ${at} of the ledger has the head hash the receipt names. The ledger holds ${result.entries - at} later entr${result.entries - at === 1 ? "y" : "ies"}.`);
    else {
      failed = true;
      out(`FAIL  receipt head: the ledger at entry ${at} does not have the head hash named in the receipt.`);
    }
    const checked = anchors && existsSync(anchors) ? readAnchors(anchors) : [];
    if (checked.length === 0) {
      if ((integrity.anchor_records ?? []).length > 0) partial = true;
      out("SKIP  anchors: no anchor file was checked, so the chain is consistent but may not be the chain that was first written.");
    }
    else {
      const named = integrity.anchor_records ?? [];
      const missing = named.filter((a) => !checked.some((c) => c.seq === a.seq && c.head === a.head));
      if (missing.length > 0) {
        failed = true;
        out(`FAIL  anchors: ${missing.length} anchor${missing.length === 1 ? "" : "s"} named in the receipt are not in the anchor file.`);
      } else out(`PASS  anchors: ${checked.length} anchor${checked.length === 1 ? "" : "s"} matched the chain, and every anchor named in the receipt is among them.`);
    }
    // The verdicts are worked out again from the ledger, when this machine holds the run folder.
    if (ledger === homeLedger) {
      try {
        const again = composeReceipt(home, run, { label: receipt.label as "live" | "scripted" | "unlabelled" });
        const pick = (r: Record<string, unknown>): string => canonicalJson(["verdicts", "criteria", "stages", "findings", "effects", "answer_key", "sessions", "charter_versions", "run_map", "held_and_approved", "denied"].map((k) => r[k]));
        const same = pick(again as unknown as Record<string, unknown>) === pick(receipt);
        if (same || (integrity.head_seq ?? 0) !== result.entries) out(same ? "PASS  verdicts: worked out again from the ledger, the verdicts, criteria, stages, findings and actions are the same." : "SKIP  verdicts: the ledger has grown since the receipt was written, so they were not compared.");
        else {
          failed = true;
          out("FAIL  verdicts: worked out again from the ledger, the receipt differs from the ledger.");
        }
      } catch (error) {
        out(`SKIP  verdicts: they could not be worked out again here: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  out("");
  out(failed ? "RESULT: FAILED" : partial ? "RESULT: PARTLY CHECKED. A check above was skipped, so this is not a pass." : "RESULT: PASSED");
  out("What this shows: the receipt has not changed since it was signed, and the record it names has not changed since it was anchored. This is evidence, and it is tamper-evident on one machine, not tamper-proof.");
  out("What this does not show: that the signer is who you think, that every event was recorded, that a tool did what it reported, or that the result is right. The receipt says which checks ran. Read its coverage statement and limits.");
  return failed ? 1 : partial ? 3 : 0;
}
