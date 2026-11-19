# Receipt written after the run

Label: live (the run r_live3 of 2026-11-18). This receipt was written after the run from the same ledger. The run was not repeated. At the time of the run, Candor wrote a shorter receipt that did not read drift scores. That receipt is not published. The ledger copy here is identical to `../ledger.jsonl`. The key id is in `receipt.json` and must reach a reviewer by another route than this folder.

Check it from this folder with `candor verify receipt.json --key-id <the key id>`.

Known fault of this receipt, found when it was made: it says drift was scored at one checkpoint more than the watcher scored, because the final checkpoint, which the watcher recorded as skipped for lack of new work, is counted as a score. The receipt is kept as it was written.
