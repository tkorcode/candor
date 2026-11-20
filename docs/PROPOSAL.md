# Product proposal: Candor, trust in long-running jobs

Candor is an oversight layer for long-running Claude Code jobs. Claude Code does the work. Candor records it from outside the worker, has a separate Claude model score each stage against a goal approved before the run, pauses the job when it drifts, lets a person add a rule or restart from an earlier checkpoint without losing what happened, and ends with a signed trust receipt that someone who was not there can approve from. It is built on the capability in `docs/CAPABILITY.md`.

## The problem

Models can carry one job for hours or days, but organizations cannot use that length on work that matters. A long job is either watched the whole time, which does not scale, or trusted blindly, which fails the first time someone asks what the agent did. The barrier is sharpest where the value is highest. A migration of patient records, a month-end close or a reanalysis of a drug screen needs evidence an auditor or regulator will accept, and a transcript written by the agent itself is not evidence.

**The metric Candor exists to lower is human review minutes per hour of agent work.** It caps how much work any organization can hand to agents.

## Who it is for

- **The operator** starts a long job and wants to be called only when a decision is needed.
- **The reviewer** in compliance, security or audit was not there, and must accept or reject the result from one document they can check without trusting the sender.
- **The approver** signs off a release, a migration or a close, and needs to know the job followed its brief and the result was checked.
- **Small organizations** such as nonprofits, public agencies and clinics have no compliance team. A receipt they can show a board, funder or regulator is what makes agent work possible for them at all.

## The product

A job starts from a **charter**: the goal, each success criterion with its check, the scope, the stages, drift rules in plain words, the actions that cannot be undone, and a budget. Candor challenges the charter before approval, and each check must first fail on a planted fault to count. During the run every tool call passes through Claude Code hooks to a daemon the worker cannot reach. The daemon applies the rules before the action runs, holds irreversible actions for a person, writes an append-only hash-chained ledger, and checkpoints each stage. A **watcher**, a separate Claude model with no tools, scores each checkpoint on goal, scope, plan and evidence. The highest of the four is the drift, so one bad dimension is never averaged away. At the warn level the worker gets a note. At the pause level the job waits for a person.

Four things are new together, in one loop:

1. **Drift is measured against the goal of this job,** not only against permissions.
2. **History is scored again when a rule changes,** and both scores are kept, so a reviewer sees what the new rule would have caught.
3. **A restart carries its lesson forward.** It forks the files and the worker conversation at an earlier checkpoint, keeps the old branch, and turns the reason into a rule on the new one.
4. **The receipt gives two verdicts, never merged:** the job stayed on course, and the result passed its acceptance checks. Staying on course is not the same as being right.

## What v1 looks like, running today

- **[Candor workspace](https://candor.tkorcode.workers.dev/workspace.html):** describe a code migration, approve the charter Claude drafts, and watch real Claude Code run under Candor in its own container. Decide the held deletion, add a rule, restart from a checkpoint, plant a fault, and download a record that `candor verify` accepts.
- **[Candor console](https://candor.tkorcode.workers.dev):** recorded live runs with signed receipts, verified in the browser, and a live watcher that rescores a checkpoint under a rule you write.
- **Evidence about the watcher itself:** seeded failures with known answers, split into calibration and held-out halves, with every catch, miss and false alarm reported in `results/evaluation/`. What Candor does not check is in `docs/COVERAGE.md`, and the threat model is in `docs/SPEC.md` section 8.

## Why Anthropic

- **It turns safety into the reason to buy.** Capability is unlocked as safeguards are shown to work. Candor applies that idea to one job.
- **It extends Outcomes in Managed Agents** from the finished artifact to the middle of the run. Outcomes could serve as the final acceptance check of a Candor run.
- **It puts Anthropic research into architecture:** live, independent monitors catch what offline reasoning monitors miss, and agents grade their own work too generously.
- **It makes Claude Code the place to run long, high-stakes jobs,** built on its hooks, sandbox, managed settings and session fork.
- **Only Anthropic can close the last gap.** A provider-signed record of what the model did would make every receipt stronger, and no third party can build it.
- **It grows with the models.** Each job runs Claude as worker and as watcher, and better models mean fewer pauses.
- **It serves Beneficial Deployments.** The organizations with the most sensitive data and the least compliance capacity are the ones a receipt unlocks.

## One engine, many regulated jobs

Everything specific to a job lives in its charter, so the same loop applies wherever long work needs evidence. Four example charters in `examples/charters/` already pass review on the same engine. Candor does not make a job compliant. It produces the kind of record these regimes ask organizations to keep.

| Domain | Long job, and how it drifts | Why a record matters |
|---|---|---|
| Healthcare | Deduplicating patient records; repairing records out of scope | HIPAA audit controls (45 CFR 164.312(b)) |
| Life sciences | Reanalyzing a screen; dropping awkward points, changing the fit | Audit trails for electronic records (21 CFR Part 11) |
| Financial services | Month-end close; forcing a balance without support | Internal control over financial reporting (SOX section 404) |
| Software and security | Patching across services; editing tests until they pass | Change management in SOC 2 and ISO/IEC 27001 audits |
| Public sector, nonprofits | Grant or case data; inconsistent rules, mishandled personal data | Record retention for federal awards (2 CFR 200.334) |
| High-risk AI in the EU | Any agent within Annex III | Automatic logging under AI Act Article 12, applying to Annex III from 2 December 2027 |

## Is an MVP viable?

Yes. **The hard parts are built and run on real Claude Code:** the trust boundary, ledger and verifier, fork and restart, re-scoring and the receipt. The MVP is hardening and packaging, not invention. **It generalizes by configuration:** a new domain needs a charter and its checks, not engine code. **It rides the model curve:** its value grows as jobs get longer and watchers get better.

The MVP adds a team and a real trust boundary: managed settings that allow only managed hooks, a second witness for model traffic, off-machine anchors, the daemon running approved irreversible actions itself, signing keys in a KMS with organization identity, and integration with the Agent SDK and Managed Agents. The architecture, scaling and tradeoffs are in `docs/MVP.md`.

**First pilot:** three design partners in regulated work, such as a health data migration, a month-end close and a security patch rollout. Measure review minutes per agent hour against their current process, the watcher catches and false alarms on their jobs, and whether their reviewers accept a receipt as evidence.

## Roadmap

- **Next:** a live run that drifts to a pause, then a rule, a re-score and a restart; a scripted demo with no key; results rendered into the documents from `results/`.
- **MVP:** the items above, detailed in `docs/MVP.md`.
- **Beyond:** **earned autonomy**, where rules loosen for a job type as its receipts prove it reliable, approved by a person and reversible; receipt amendment; provider-signed session records; and an open receipt format auditors can rely on, the way a SOC 2 report lets one company buy software from another.

## Risks

- **A green receipt gets rubber-stamped.** Two verdicts, a coverage statement in every receipt, and evidence behind every flag.
- **The watcher shares blind spots or is talked round.** Deterministic checks do not depend on it, worker output reaches it only as data, and seeded failures measure it.
- **The worker disables the oversight.** Hooks fail closed, settings changes are blocked and recorded, and production uses managed settings.
- **Rollback cannot undo outside effects.** Effects are registered, later checkpoints are marked record only, and irreversible actions are held.
- **The platform builds this itself.** The parts only a provider can build are marked as such. Candor is the layer above them, and shows the design and the demand.
