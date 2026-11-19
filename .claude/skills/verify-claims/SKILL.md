---
name: verify-claims
description: Audit every claim and number in the project documents against the code and the results before sharing. Use only when the user asks for a release check or a claims audit.
disable-model-invocation: true
context: fork
---

# Claims audit before sharing

Go through `README.md`, every file in `docs/`, the receipt template and the pane copy. Report findings. Do not fix anything in this pass.

## For every number

- Find the file under `results/` it came from. If there is none, flag it.
- Check the document value matches the file.
- Check it is labelled scripted or live.

## For every capability claim

- Find the code and the test that implement it. If a control in the threat model table is not built, flag it.
- Check `docs/ROADMAP.md` lists anything built weaker than the spec says, and that the documents do not claim more.

## For wording

- Search for: proof, proves, proven, tamper-proof, secure, guarantee, ensures, compliant, safe. Each use must be accurate or removed.
- Check that a competitor description says what the product does before what it lacks, and has a source.
- Check every external claim has a link, and that self-reported lab claims are marked as such.

## For the reviewer path

- From a clean clone, follow the README only. Time how long it takes to reach a verified receipt.
- Run `npm run demo` with no API key and no network.
- Open `receipt.html` and run the verify command it prints.

## Report

A table: file, line, claim, finding, severity. Then three lists: must fix before sharing, should fix, fine as is.
