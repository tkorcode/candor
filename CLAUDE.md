# Candor

An oversight layer for long-running Claude Code jobs. Claude Code does the work. Candor checkpoints the job, has a separate Claude model, the watcher, score each stage against the goal, lets a person restart from a checkpoint as a fork, and ends with a signed trust receipt.

Read `docs/SPEC.md` before any work. It is the definition of done. `docs/ROADMAP.md` says what is built, what is not, and what is next. `docs/DECISIONS.md` records choices already made.

# Commands
- Install: `npm install`
- Build the `candor` command into `dist/`: `npm run build`
- All checks (typecheck, lint, license check, unit tests): `npm run check`
- Rewrite the dependency table: `npm run deps:render`
- Remove personal details from recorded runs before committing them: `npm run results:redact` (D-086)
- One test file: `npx vitest run path/to/file.test.ts`
- Scripted demo, no API key: `npm run demo` (not built yet, see `docs/ROADMAP.md`)
- Live demo, needs `ANTHROPIC_API_KEY`, capped: `npm run demo:live` (not built yet)
- Seeded evaluation: `npm run eval` (frozen, D-078)
- Render results into docs: `npm run results:render` (not built yet)
- Hosted console: `site/`, deployed on Cloudflare Pages from `main`. Its live watcher is `functions/api/rescore.ts` (D-077, D-079)
- Validate the mod: `claude plugin validate plugin/`
- Test the mod: `claude plugin test plugin/`

# Rules that are not in the code
- Never type a result, count, cost or timing into a document. Numbers come from `results/` through `npm run results:render`.
- A recorded run is a real run. Label it live, with date, model IDs and cost, and keep its trace. Scripted traces are labelled scripted.
- Say evidence, never proof. Say tamper-evident, never tamper-proof.
- The receipt gives two verdicts and never merges them: stayed on course, and result verified. Staying on course is not the same as being right.
- The ledger is append only. No code path edits or deletes an entry. A correction is a new entry.
- The watcher gets no tools. Worker output reaches it as data inside a delimited block. Worker reasoning is never passed to it.
- Every code path that calls a model takes a budget and stops at it.
- Only synthetic data and code written for this project.
- A recorded run holds details of the computer it ran on. Run `npm run results:redact` before committing it. A test refuses home paths, private temporary folders and MCP names in `results/`.
- The worker has no direct channel to the daemon. Hooks are the only path from the worker, and the daemon assigns the actor, never the caller.
- The command is `candor`, never `trust`. The phrase trust receipt names only the output document.
- In prose, Candor is an oversight layer, never a harness or an agent framework. It is installed as a command-line tool. Plugin names only the hooks and pane in `plugin/`. Harness names only code: the runner inside `candor run` that drives the worker, and the evaluation runner in `src/bench`. Assurance is a word for compliance readers only.
- Dependencies must be free and under MIT, Apache 2.0, BSD or ISC. No GPL or AGPL. List each one in `docs/DEPENDENCIES.md`.
- There is no license. `COPYRIGHT` reserves all rights. Do not add a license file. The repository is public to read, and reading grants no right to reuse.
- Dates in documents are Pacific time, taken from `TZ=America/Los_Angeles date +%F`, never from the date in the session context. Timestamps in ledgers and results files stay exact UTC.
- In prose documents and interface copy, use full forms and no apostrophes (do not, it is, cannot).

# Working agreements
- Before any work, fetch every branch (`git fetch origin '+refs/heads/*:refs/remotes/origin/*'`) and read `docs/ROADMAP.md`. Work can sit on a branch that is not merged.
- One agent session changes the code at a time.
- Name each branch for its work: `feature/<topic>`, `fix/<topic>` or `docs/<topic>`, one branch per pull request. Commit messages and pull requests describe the product change, never the schedule.
- One milestone at a time, in the order in `docs/SPEC.md` section 9. Start one with `/milestone`.
- At the end of a milestone: update `docs/ROADMAP.md`, record decisions in `docs/DECISIONS.md`, commit.
- If the spec is wrong or unclear, stop and ask. Do not quietly change scope.
- Priorities are in `docs/SPEC.md` section 10.

# Gotchas
- Live runs need a machine where the Claude Code sandbox works and an `ANTHROPIC_API_KEY`. A container without bubblewrap cannot run them.
- `sqlite3` must be installed for the demo project, the evaluation and the tests that build it. `candor doctor` checks it.
- Mods draw only in local sessions (terminal, Desktop Code tab, VS Code). Headless and cloud runs fire hooks but draw nothing.
- The Agent SDK and headless runs authenticate with `ANTHROPIC_API_KEY`, not the claude.ai login.
- Native checkpoints do not cover files changed only by shell commands. Our snapshots must.
- `agent_id` appears in hook input only inside a subagent.
- A mod has no Node and no DOM. It reads state from the daemon and draws. Load the `plugin-authoring` skill before touching `plugin/`.
