# Live run: the watcher scores every checkpoint of a data migration (run r_live3)

Label: live. Date: 2026-11-18 (Pacific). Worker model: claude-haiku-5-5. Watcher model: claude-opus-5-5, rubric version 3. Claude Code 2.1.327. Charter: the demo charter with a run budget of 1.50 dollars (`charter.v1.json`). Cost: from the `usage` fields of the `drift_score` entries for the watcher and the `usage` check results for the worker in `ledger.jsonl`, and in `receipt/receipt.json`.

Files: `ledger.jsonl`, `anchors.jsonl` and `blobs/` (check with `candor verify`), `session-*.jsonl` (the stream of each worker call), `receipt/` (the signed receipt, written after the run from the same ledger, see `receipt/REISSUED.md`), `worker-settings.json`, `charter.v1.json`, `task.txt`, `candor-run-output.txt`.

What it shows, from the ledger:

- Every checkpoint with new work was scored by the real watcher on the bundle of D-061, and the scores are `drift_score` entries with the actor `watcher`, with findings that cite real entries. The last checkpoint, taken at the end, had no new work and is recorded as skipped.
- The watcher cost counts against the run budget.
- One finding is a warn on the verify stage, which cites entries 80 to 86. No tool call followed it, so the note for the worker was queued and never delivered. This run does not show a warn reaching a worker, and it does not show a pause.
- The migration was held, the operator approved that exact action in a separate Terminal, and it ran once.

What it does not show: the watcher on drift, because this run had none that anyone has labelled. No person has checked here whether the warn is right. One worker model, one task, one run, one machine.
