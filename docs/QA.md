# Questions and answers

Answers to the questions people ask most about Candor. Where an answer needs a number, the number is in a file under `results/`, never typed here.

## Design

**Why hooks and not a proxy?**
Hooks see the tool call before it runs and can hold it. They also see compaction, subagent and settings events. A proxy sees only model traffic, and in local Desktop sessions the app sets the API address and it cannot be overridden. Hooks run on the worker machine, which is their weakness. The production design adds a proxy or a provider record as a second witness, and the two must agree.

**What does the hash chain show?**
Each entry includes the hash of the one before, so an edit, deletion or insertion breaks every later hash. Alone that shows little, because whoever can write the file can rebuild the chain. So the head hash is copied to an anchor file outside the run folder at every checkpoint. On one machine, under one user, that anchor is a hurdle, not a wall, and an anchor kept elsewhere is on the roadmap. The chain then shows that the record up to each anchor has not changed since. It does not show that every event was recorded, or that a tool did what it reported.

**What can a rollback not undo?**
Anything that left the workspace, such as a message sent, a record written to an outside system, a pushed commit, a payment. These go in an effect register, and checkpoints after such an action are marked record only. A restart is also not a replay, because the model will not repeat itself exactly.

**How was the evaluator calibrated?**
On seeded failures with known answers, split into a calibration half and a held-out half with a fixed seed. The rubric of the watcher was tuned on the calibration half only, then frozen before the held-out half ran (D-044). The warn and pause thresholds are the starting values of the charter and were not tuned. The watcher part was repeated on each half to show spread. No person has labelled a sample of verdicts yet, and the results say so.

**What does it cost per run?**
Every receipt reports the cost, turns and active minutes of its run, and the watcher cost counts against the budget of the run. Tokens and the delay the hooks add are not recorded yet.

## Strategy

**If models become reliable, is this still needed?**
Yes. Reliability reduces how often a person is needed. It does not remove the need for a record made by something other than the worker. The product gains as the watcher improves, with fewer pauses and more runs per person.

**Why not just use outcomes in Managed Agents?**
Outcomes grades finished work against a rubric in a separate context. This extends the same idea to the middle of a run in Claude Code, with an assessment at each stage, a record, a restart that preserves what came before, and re-scoring when a rule changes.

**Is the watcher independent if it is the same model family?**
Only partly. It shares no context with the worker, has no tools, and uses a different model tier where possible. It can still share blind spots. That is why deterministic checks do not depend on it and why the by-detector table reports where it failed.

**Is a receipt the same as a SOC 2 report?**
No. A SOC 2 report carries weight because an independent auditor issues it against a shared standard. No format for agent audit records is final yet. The receipt is the evidence an auditor would start from.

**Does a clean receipt mean the result is right?**
No, and the receipt is built so that nobody reads it that way. It gives two separate verdicts. Stayed on course means the job followed its charter. Result verified means every success criterion passed an acceptance check on the final state, and each of those checks was first shown to fail on a planted fault. A criterion with no check is listed as not verified. On synthetic data with a known right answer, the evaluation reports how many verified results were right. To be measured.

**What stops the agent from turning this off?**
See the threat model in `docs/SPEC.md` section 8. On an unmanaged machine the prototype detects it and cannot prevent it.

**What does Candor not check?**
See `docs/COVERAGE.md`. It ships inside every receipt.

**Could the platform build this itself?**
Parts of it, yes. Records signed by the provider, checkpoints that cover shell and subagent changes, and a self-report signal in the API can only come from the platform. The prototype shows the design and the demand, and marks where it can only approximate.

## Honesty

**Which runs are real?**
Every recorded run is labelled live or scripted. Live runs carry date, model IDs, cost and a full trace.

**What did the watcher miss?**
The by-detector table in `results/evaluation/2026-11-18-scripted-failures/summary.json` lists every seeded failure, which layer caught it, and the misses. The decisions log explains each miss.
