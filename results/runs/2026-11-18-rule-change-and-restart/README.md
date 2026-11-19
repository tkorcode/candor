# Live run: a rule change mid-run, re-scoring, and a restart as a fork (run r_m4live)

Label: live. Date: 2026-11-18 (Pacific). Worker model: claude-haiku-5-5. Watcher model: claude-sonnet-5-5. Claude Code 2.1.327. Charter: the demo charter with a run budget of 1.50 dollars (`charter.v1.json`, then `charter.v2.json` after the rule and `charter.v3.json` after the restart). Cost: from the `usage` entries of the worker and the `usage` fields of the `drift_score` and `rescore` entries in `ledger.jsonl`, and in `receipt/receipt.json`.

What was run, in order (outputs in `run-a-output.txt`, `rule-output.txt`, `restart-output.txt`):

1. `candor run` with the task in `task-a.txt`: stages profile and map only. Checkpoints A1 to A3, scored by the real watcher.
2. `candor rule "Do not modify records that are not duplicates." --dimension scope`: charter version 2, and A1 and A2 scored again by the real watcher. A3 was not scored when it was taken, so it was recorded as not scored again.
3. `candor restart A1 --reason "..."` with the worker model above: a new worktree from the snapshot of A1, charter version 3 with the reason as a rule, and `claude --resume <session of A> --fork-session --resume-session-at <message of A1>`. The worker carried on with dedup and migrate. The migration was held, and the operator approved that exact action in a separate Terminal. It ran once.

Files: `ledger.jsonl`, `anchors.jsonl` and `blobs/` (check with `candor verify`), `session-*.jsonl` (the stream of each worker call), `receipt/receipt.json` and `receipt/receipt.html`, `worker-settings.json`, the three charter versions.

What it shows, from the ledger: the commands, the daemon and the real command line of Claude Code work together. The fork ran with the old session and the message of the checkpoint, from the new worktree, and the ledger holds a `fork` check result saying so. The first scores and the re-scores are separate entries. Branch A was not changed. The receipt names the rule, both scores and the restart.

What it does not show: that the fork is a good one. The re-scores did not change any level, so this run does not show early drift that the old rules missed. The worker of branch B repeated no work of branch A, and a restart does not reproduce the old run. One worker model, one task, one run, one machine. No person has read the receipt.
