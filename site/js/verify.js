// Verification in the reader's browser. It repeats the checks of `candor verify` on the files the
// console loaded: the hash chain, the anchors, the blob store and the Ed25519 signature of the
// receipt. Nothing here trusts a summary: every result is computed from the raw files.

import { canonicalJson, digest, sha256Hex } from "./canonical.js";

export const GENESIS = `sha256:${"0".repeat(64)}`;

/**
 * Checks the chain line by line. Returns the first bad sequence number and why, as `candor verify` does.
 * `lines` are the raw lines of ledger.jsonl.
 */
export async function verifyChain(lines) {
  let prev = GENESIS;
  let expectedSeq = 1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return { ok: false, firstBadSeq: expectedSeq, reason: `Line ${i + 1} is not JSON.` };
    }
    if (entry.seq !== expectedSeq) return { ok: false, firstBadSeq: expectedSeq, reason: `Entry ${expectedSeq} is missing or out of order: line ${i + 1} holds entry ${entry.seq}.` };
    if (entry.prev !== prev) return { ok: false, firstBadSeq: entry.seq, reason: `Entry ${entry.seq} does not point at the hash of the entry before it.` };
    const { hash, ...unsigned } = entry;
    const computed = await digest(unsigned);
    if (computed !== hash) return { ok: false, firstBadSeq: entry.seq, reason: `Entry ${entry.seq} does not match its hash, so it was changed after it was written.` };
    if (canonicalJson(entry) !== line) return { ok: false, firstBadSeq: entry.seq, reason: `Line ${i + 1} is not in canonical form, so the file was rewritten by something other than the ledger writer.` };
    prev = hash;
    expectedSeq += 1;
  }
  return { ok: true, entries: lines.length, head: prev };
}

/** Every anchor must name an entry of the chain with exactly that hash. A ledger cut short fails here. */
export function verifyAnchors(anchors, entries) {
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  for (const anchor of anchors) {
    const entry = bySeq.get(anchor.seq);
    if (!entry) return { ok: false, reason: `An anchor was recorded at entry ${anchor.seq}, but the ledger ends at entry ${entries.length}. The ledger was cut short.` };
    if (entry.hash !== anchor.head) return { ok: false, reason: `The anchor at entry ${anchor.seq} names a hash the chain does not hold there.` };
  }
  return { ok: true, anchors: anchors.length };
}

/** Large values live in a content-addressed blob store. Each blob must hash to its own name. */
export async function verifyBlobs(entries, fetchBlob) {
  const refs = new Set();
  const walk = (value) => {
    if (value && typeof value === "object") {
      if (typeof value.$blob === "string") refs.add(value.$blob.replace(/^sha256:/, ""));
      for (const item of Object.values(value)) walk(item);
    }
  };
  for (const entry of entries) walk(entry.body);
  for (const hexName of refs) {
    const text = await fetchBlob(hexName);
    if (text === null) return { ok: false, reason: `The blob ${hexName.slice(0, 12)} named by the ledger is missing.` };
    if ((await sha256Hex(text)) !== hexName) return { ok: false, reason: `The blob ${hexName.slice(0, 12)} does not match its name, so it was changed.` };
  }
  return { ok: true, blobs: refs.size };
}

const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The Ed25519 signature over the canonical JSON of the receipt without its signature field. */
export async function verifyReceiptSignature(receipt) {
  const s = receipt?.signature;
  if (s?.alg !== "ed25519" || typeof s.public_key !== "string" || typeof s.value !== "string") return { ok: false, reason: "The receipt carries no signature in the expected form." };
  const { signature: _omitted, ...rest } = receipt;
  const der = fromBase64(s.public_key);
  const keyId = `sha256:${await sha256Hex(der)}`;
  let key;
  try {
    key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { ok: false, unsupported: true, keyId, reason: "This browser cannot check Ed25519 signatures. Use the command line: candor verify receipt.json --key-id <id>." };
  }
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(s.value), new TextEncoder().encode(canonicalJson(rest)));
  return valid ? { ok: true, keyId } : { ok: false, keyId, reason: "The signature does not match the content of the receipt. It was changed after it was signed, or signed by a different key." };
}

/** The head the receipt names must be an entry of this chain, with that hash. */
export function verifyReceiptHead(receipt, entries) {
  const head = receipt?.integrity?.head;
  const seq = receipt?.integrity?.head_seq;
  const entry = entries.find((e) => e.seq === seq);
  if (!head || !entry) return { ok: false, reason: "The receipt names a head entry that this ledger does not hold." };
  if (entry.hash !== head) return { ok: false, reason: `Entry ${seq} does not have the head hash the receipt names.` };
  return { ok: true, seq, later: entries.length - seq };
}
