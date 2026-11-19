---
name: run-eval
description: Run the seeded-failure evaluation and write up the results. Use only when the user asks to run the evaluation or produce results.
argument-hint: "[scripted|live] [label]"
disable-model-invocation: true
---

# Run the evaluation

Arguments: $ARGUMENTS

Follow `docs/EVALUATION.md`. This skill is the checklist.

## Before any live run

1. Confirm with the user: the mode, the worker and watcher model IDs, the per-run cap, and the total budget. Print the worst-case spend (runs times cap) and wait for a yes.
2. Check `CANDOR_EVAL_BUDGET_USD` is set and `ANTHROPIC_API_KEY` is present. Never print the key.
3. Check the thresholds and rubric are frozen and their hashes are recorded.

## Run

1. Scripted first. It is free and catches bugs in Candor before money is spent.
2. Live second, held-out half only for reported numbers, each run repeated at least 3 times.
3. Stop when the total budget is reached. Report what did not run.

## Write up

1. The results are the files the run writes under `results/evaluation/`. `npm run results:render`, when it is built, writes `docs/RESULTS.md` from them. Do not edit that file by hand.
2. Report counts, not percentages: caught, caught late, missed, false alarms.
3. Include the by-detector table: deterministic only, watcher only, both, neither.
4. List every miss and every false alarm by ID with one line on what happened.
5. State the overhead: added time, tokens and cost per run.
6. Update `docs/COVERAGE.md` with any gap the run exposed.
7. The spend is in the manifest and summary of the run. Do not type it into a document.

## Honesty rules

- A bad result is published as it is.
- If the rubric or thresholds changed after seeing held-out results, say so and re-split.
- A scripted result is labelled scripted wherever it appears.
- Tell the user plainly which questions in `docs/EVALUATION.md` section 1 the run answered and which it did not.
