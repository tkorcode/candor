---
name: mod-pane
description: How to build and change the Claude Code mod under plugin/, including the pane, the band, commands and tool call hooks. Use when working on anything in plugin/ or on how the interface shows runs, checkpoints, drift or the ledger.
---

# Working on the mod

## First

1. Load the built-in `plugin-authoring` skill. It has the current file layout, the API types and working examples. Follow it over anything written here.
2. Read the current pages listed under mods in `docs/SOURCES.md` section A. The mods API is new and changes between versions.
3. Check the Claude Code version meets the requirement in the mods overview.

## Design rules for this project

- The mod is thin. It reads run state from the daemon and draws it. It holds no source of truth and makes no trust decision of its own.
- An action in the pane (restart, add rule, approve) calls the same daemon operation as the CLI and produces the same ledger entries.
- If the daemon cannot be reached, the pane says so plainly and the job is not affected.
- Draw for the surface in use. SVG is not available in the terminal, so the run map needs a text form there.
- The first frame is complete: with no run, the pane says what will appear and how to start one.

## The pane

Follow `docs/SPEC.md` section 4.2 and the `receipt-copy` skill.

- Run map: branches as lines, checkpoints as nodes, a drift bar per checkpoint, the threshold line, superseded branches dashed. Flagged checkpoints differ by shape or label as well as color.
- Selecting a checkpoint shows stage, scores by dimension, findings with their ledger entries, checks, and safety class.
- Restart is offered only on a checkpoint marked safe to restart, and it asks for a reason.
- After a rule change, re-scored checkpoints show old and new scores together.
- The receipt tab shows the two verdicts at the top and never merges them.

## Check

- `claude plugin validate plugin/` after every change.
- `claude plugin test plugin/` for the tests.
- Load it in a real local session with `--plugin-dir` and run the demo story. A mod that validates can still draw nothing.
- Look at it in the Desktop Code tab and in the terminal.
