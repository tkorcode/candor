# Coverage statement

What Candor does not check. This file ships inside every receipt. Add to it whenever the evaluation exposes a gap.

- The reasoning of the worker. Only actions, outputs and reports are seen.
- Whether a tool did what it reported.
- Events that never reached a hook.
- A tool call that another installed mod answered before the hooks ran. The receipt lists the plugins and mods loaded at session start, so a reader can see what else was present.
- Actions taken outside Claude Code on the same machine.
- Correctness that no charter check expresses.
- Any effect in an outside system beyond the fact that a call was made.
- A change to columns of the source table that no check reads. A shell command that the allow list permits can rewrite them, and the demo checks see emails and counts only (D-062).
- A worker that skips its own validation. The daemon runs the exit checks itself, so nothing is flagged when the result is good (D-062).
- The order of stages. A skipped or reordered stage with no report raises no flag from the checks (D-062).
- A stage report that cites a check result the ledger does not show. No cross-check is built. A bad result is still caught by the exit check (D-062).
- A criterion with no check, such as the one about the most recent contact details in the demo. The demo answer key was extended to cover contact details after the first run showed that the first key missed F19 (D-065), so catching F19 shows that the key can catch what it was written for, not that a key written without knowing the failure would. A wrong result on a criterion that neither a check nor the key covers is only left not verified.
