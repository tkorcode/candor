---
name: record-run
description: Record a real, labelled run of the demo story with its trace. Use only when the user asks to record a demo run.
disable-model-invocation: true
---

# Record a real run

A reader must be able to tell that the run was real and check it.

1. Confirm with the user the model IDs and the spending cap. Print the cap and wait for a yes.
2. Start from a clean checkout of the demo project at a recorded commit.
3. Run the demo story from `docs/SPEC.md` section 4.1 with a real worker. Do not script the drift. If the worker does not drift in this run, record that run as a clean run and try the seeded variant.
4. Keep everything: the ledger, checkpoints, both branches, the session transcript, the receipt JSON and HTML.
5. Write a `README.md` beside them with: date, mode (live), model IDs for worker and watcher, cost, duration, git commit, charter version, and what a person did during the run and when.
6. Run `candor verify` on the receipt and include its output.
7. Run `npm run results:redact` on the run folder (D-086), then check the transcript and the ledger for secrets or personal data before anything is committed.
8. Put the run under `results/runs/<date>-<what it shows>/` and link it from the README.

Never edit a recorded run beyond the redaction of D-086. If something in it shows a flaw, say so in its `README.md`, or record another run and keep both.
