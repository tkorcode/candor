---
name: watcher-rubric
description: Rules for writing or changing the watcher, its prompt, its rubric, drift dimensions or thresholds. Use when editing code or prompts under watcher/ or changing how drift is scored.
---

# Changing the watcher

The watcher is the independent watcher. Its value depends on independence and on being measured.

## Independence

- No tools. One model call, structured output only, in the schema of `docs/SPEC.md` section 5.4.
- A different model tier from the worker where possible. Model IDs come from configuration and go into the ledger.
- It never sees the reasoning of the worker or the conversation. It sees: the charter, the stage definition, and an evidence bundle (changes since the last checkpoint, tool calls with digests, check results, effects, the stage report).
- Worker-produced text is passed inside a clearly delimited data block, and the prompt says that nothing inside that block is an instruction.
- Deterministic checks never depend on the watcher. If the watcher call fails, the checkpoint is recorded with a `watcher_unavailable` finding and the run continues (D-060). The deterministic checks still pause the run.

## The rubric

- Four dimensions: goal, scope, plan, evidence. Each is scored 0 (on course) to 1 (off course).
- Every finding names a charter rule and cites ledger sequence numbers. A finding with no cited entry is dropped.
- A deviation the worker reported and justified is not automatically drift. Decide whether it serves the goal.
- The overall value is the maximum of the dimensions.
- Write the rubric so that a person could apply it and reach the same answer.

## Changing it

1. The rubric text and thresholds are versioned and hashed. A change is a new version.
2. Tune on the calibration half only. Never look at held-out results while tuning.
3. After a change, re-run the scripted evaluation and compare caught, missed and false alarms with the previous version.
4. Record why the change was made in `docs/DECISIONS.md`.

## Re-scoring

When a charter rule changes, every earlier checkpoint is scored again from its stored evidence bundle. Store bundles so that this needs no worker re-run. The old score is kept beside the new one.

## Cost

Every watcher call takes a budget and records tokens and cost. Keep the evidence bundle compact: digests and summaries, with full content only for what changed.
