---
name: milestone
description: Start or continue a build milestone from docs/SPEC.md section 9. Use when the user says to start, continue or finish a milestone such as M2.
argument-hint: "[milestone-id]"
disable-model-invocation: true
---

# Work a milestone

Milestone: $ARGUMENTS

1. Read `docs/ROADMAP.md`, then the row for this milestone in `docs/SPEC.md` section 9, then the requirements it touches in section 7.
2. Check `docs/DECISIONS.md` for choices that constrain it.
3. If a requirement is unclear or the current Claude Code documentation contradicts it, ask before building. For anything about hooks, mods, skills or the Agent SDK, read the current documentation page listed in `docs/SOURCES.md` section A instead of relying on memory.
4. State the plan in a few lines: what will be built, in what order, and which check shows each part works. Wait for a yes if the plan changes scope.
5. Build in small steps. Write the test or the check first where one is possible. Run `npm run check` often.
6. Before calling the milestone done:
   - Every exit criterion in the table is met, and you can show the command and its output for each.
   - Use the `spec-reviewer` subagent on the diff. Fix gaps that affect correctness. Skip style.
   - `docs/ROADMAP.md` is updated, including anything built weaker than the spec says.
   - New decisions are in `docs/DECISIONS.md`.
   - The work is committed with a message that describes the product change.
7. Report: what was built, the evidence for each exit criterion, what is weaker than specified, and the next milestone.

Do not start the next milestone in the same turn. Do not add features that are not in the spec.
