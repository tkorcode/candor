---
name: ledger-change
description: Rules for any change to the ledger, hash chain, anchors, receipt signing or the verifier. Use when editing code under core/ledger, core/anchor, report or the verify command, or when adding a ledger entry type.
---

# Changing the ledger or anything that verifies it

The ledger is the part of this project an attacker or an auditor will test first. Hold these invariants.

## Invariants

- Append only. No function edits, deletes or reorders an entry. A correction is a new entry that refers to the old one by sequence number.
- `hash` is SHA-256 over the canonical JSON of the entry without the `hash` field. Canonical means sorted keys, no insignificant whitespace, UTF-8, numbers in one fixed form. Use one canonicalization function everywhere.
- `prev` is the `hash` of the entry before. The first entry has a fixed genesis value.
- Large payloads go to the blob store and the entry carries the digest.
- Redaction happens before hashing and before storage. A secret must never reach disk.
- Only the daemon process writes. The CLI and the mod ask the daemon.
- The head hash is anchored at every checkpoint, and the anchor is itself a ledger entry.

## When adding an entry type

1. Add it to the schema and to the list in `docs/SPEC.md` section 5.2.
2. Say which actor may write it.
3. Decide whether the receipt shows it, and add it to the receipt if so.
4. Add a test that a ledger containing it verifies, and that mutating it fails verification.

## Tests that must stay green

- Any single-entry mutation (edit, delete, insert, swap) fails `candor verify`, which names the first bad sequence number.
- A truncated ledger fails against its last anchor.
- A receipt with a changed field fails its signature.
- Two runs of the same scripted trace produce the same hashes when timestamps are fixed.

## Wording

The chain shows that the record up to each anchor has not changed since. It does not show that every event was recorded or that a tool did what it reported. Never write that the ledger proves a run was secure. Say tamper-evident, never tamper-proof.
