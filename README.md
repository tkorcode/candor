# Candor

**Candor supervises long-running Claude Code jobs and ends each one with a trust receipt.**

Candor is an oversight layer for long Claude Code jobs. It does not do the work. Claude Code does that. Candor starts the job, sits beside it, checks each stage against what you asked for, pauses the run when it wanders, and lets you add a rule or restart from an earlier point. At the end it gives you a trust receipt that says whether the job stayed on course and whether the result passed the checks you set.

**What it is not.** It is not an agent framework, a logging tool, or a guarantee. It will not tell you a job was safe or correct. It tells you what was recorded, what was checked, and what was not.

## Why it matters

Models can now work on one job for hours or days. A job that long is either watched the whole time or trusted blindly, and neither works at scale. The time people have for review sets a ceiling on how much work they can hand to agents.

A model also cannot be its own witness. Agents have been shown to tamper with their own traces and to slip past monitors that read their reasoning (see `docs/SOURCES.md`). So the record of the job, and the model that assesses it, have to sit outside the agent doing the work.

With Candor a person can leave a long job running and step in only when something needs a decision. They approve a charter before the run starts. The run stops and waits for them when drift reaches the pause level, or when the job reaches a step that cannot be undone. At the end they read a receipt that sets out what was asked, what was done, where it drifted, who corrected it, which checks passed and what was never checked. The measure Candor aims to lower is human review minutes per hour of agent work.

## Who it is for

- **The operator** is the engineer or lead who starts a long job and wants to oversee it without watching it.
- **The reviewer** is a compliance, security or audit owner who was not there and has to decide whether to accept the result.
- **The approver** signs off a migration, a release or a month-end close, and needs to know both that the job followed its brief and that the result was checked.
- **Smaller organizations** with no compliance team can show the receipt to a board, a funder or a regulator. For them it can be what makes agent work possible at all.

## This repository

Candor is published in layers. Each layer is a pull request with its own tests, and this first one is the definition of the product, before any code.

| File | What it covers |
|---|---|
| `docs/SPEC.md` | What Candor must do, how it is built, the threat model, and when each part counts as done |
| `docs/DECISIONS.md` | Why it is built the way it is, one dated entry per decision, with the alternatives and the cost of each choice |
| `docs/EVALUATION.md` | How the watcher and the checks are measured, using seeded failures and a held-out half |
| `docs/COVERAGE.md` | What Candor does not check. This statement ships inside every receipt |
| `docs/SOURCES.md` | The sources behind the design |
| `CLAUDE.md` and `.claude/` | The instructions, skills and review agents used to build Candor with Claude Code |

---

Copyright (c) 2026 tkorcode. All rights reserved. See `COPYRIGHT`.
