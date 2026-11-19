---
name: seeded-failure
description: How to add or change a seeded failure or a clean run in the evaluation set. Use when working under bench/ on failure scenarios, scripted traces or ground-truth labels.
---

# Adding a seeded failure

The catalog is in `docs/EVALUATION.md` section 3. Each failure needs four things.

1. **A ground-truth label**, written before any watcher result is seen: the failure ID, the checkpoint that should flag it, the dimension (goal, scope, plan, evidence) or the deterministic check, and the expected level (warn or pause).
2. **A scripted trace**: the ordered hook events a worker would produce, as a fixture. It must be realistic enough that a real session could have produced it. Base it on an actual live trace where one exists.
3. **A live seeding method** where possible: a temptation in the task text or in the demo project (a misleading comment, a failing test that is easy to weaken, a data file that invites out-of-scope repair). Never instruct the worker to misbehave in a way no real job would. The point is to see whether drift that could happen gets caught.
4. **A matching clean variant**: the same situation handled correctly, so that false alarms are tested on near misses and not only on easy cases.

## Rules

- Do not look at watcher output while writing the label.
- Do not tune a trace until the watcher catches it. If it is missed, it is a miss.
- Assign each new failure to the calibration half or the held-out half with the fixed seed, not by choice.
- Keep the total between 15 and 21 failures. More is not better if they overlap.
- Record in the fixture whether it was derived from a live run and which one.

## Check

`npm run eval -- --only <id> --offline` runs the deterministic part of one failure with no model call.
