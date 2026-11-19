# Roadmap

What Candor does today, what it does not do yet, and what comes next. `docs/SPEC.md` is the definition of done and `docs/DECISIONS.md` records why each part is built the way it is.

## What is built

| Part | What it does | Where |
|---|---|---|
| Charter | A job is described by a charter, which holds the goal, scope, stages, success criteria, checks, irreversible actions and a budget. `candor charter review` flags a vague goal, a criterion with no check, and a check that cannot fail. Approval is a ledger entry | `src/core/charter`, `demo/charter.yaml`, `examples/charters` |
| Ledger | Append-only JSON lines with a SHA-256 hash chain, a blob store named by content hash, redaction of secrets before anything is written, and anchor files outside the run folder. `candor verify` names the first entry that changed | `src/core/ledger`, `src/core/anchor` |
| Capture and checks | Claude Code hooks call `candor hook`, which talks to `candord` over a Unix socket. The daemon assigns the actor of every entry. Scope, command, network, personal data and irreversible rules run before every tool call and fail closed. Irreversible actions are held until the operator approves that exact action | `plugin/hooks`, `src/daemon`, `src/core/checks` |
| Checkpoints | A checkpoint is recorded when it is triggered, at stage done, before an irreversible action, before compaction, when a subagent stops, by hand, and at the end. Each has a snapshot of the working tree, kept outside the workspace, and a safety mark | `src/daemon/server.ts`, `src/core/checkpoint` |
| Watcher | A separate model, with no tools, scores each checkpoint on four dimensions (goal, scope, plan, evidence) from an evidence bundle built from the ledger. Worker output reaches it only as data inside a delimited block. Warn and pause thresholds come from the charter. Every call has a budget | `src/watcher`, `src/daemon/watch.ts` |
| Rule change and re-score | `candor rule` writes a new charter version through the operator channel, and every earlier checkpoint is scored again from the evidence stored with its first score. Both scores are kept | `src/cli/operator.ts`, `src/daemon` |
| Restart as a fork | `candor restart <checkpoint>` restores the snapshot into a new worktree, forks the worker conversation at that checkpoint, and adds the reason for the restart as a rule on the new branch. The old branch is kept. The daemon suggests where to restart from the drift scores | `src/cli/restart.ts`, `src/core/restart-point.ts` |
| Trust receipt | `candor receipt` writes a signed receipt in JSON and HTML with two verdicts that are never merged, stayed on course and result verified. It lists findings, held and approved actions, effects, rule changes, re-scores, restarts, what was not checked, and the cost. `candor verify receipt.json` checks the signature, the chain, the head and the anchors | `src/core/report` |
| Hosted console | A static site that shows recorded runs, verified in the browser. It opens with the two verdicts and a few sentences, built from the ledger, on what happened in the run. The run map shows the branches, each checkpoint with its score, where a restart is possible, held steps and restarts, beside the warn and pause levels a reader can change. A right-click on a checkpoint opens its actions. The checkpoint view shows what happened, why it scored what it did against the charter, the worker report beside what Candor checked, and the restart command. Rules, ledger and receipt have their own views. One live endpoint scores stored evidence again with a rule the reader writes, or one of the rules suggested for the demo, under a daily spending cap (D-089, D-090) | `site/`, `src/web/`, `wrangler.jsonc` |
| Hosted job | The workspace at `/workspace.html`: a reader describes a code migration of the sample service in `demo/invoices`, checks and approves the charter Claude drafts, and watches a real worker run under Candor. Every write and delete is checked first, each stage ends in a checkpoint scored by the watcher, a deletion waits for the reader, a rule can be added with earlier checkpoints scored again, and any checkpoint can be restarted from as a fork. The record passes `candor verify`. The checks read the code and never run it. It runs in a Cloudflare Durable Object, and with no API key the same job runs scripted (D-092) | `src/hosted/`, `src/web/job-object.ts`, `site/workspace.html` |
| Claude Code in the workspace | The reader can choose real Claude Code as the worker. It runs in a container of its own under the real `candor run`, with its checks also running the tests of the service and loading the retired report. Separate users keep the worker away from Candor, and the API key stays outside the container. The job object copies each ledger entry out, checks it links up, sends anchors to the key value store and signs the receipt. The reader can plant one of three named faults (D-093 to D-096) | `container/`, `src/web/container.ts`, `src/web/cc-job.ts`, `src/core/run/isolation.ts`, `src/hosted/check-cli.ts` |
| Example charters | Charters for a code migration, a security patch rollout, a screening analysis and a financial reconciliation, each loaded and reviewed by a test, with the same engine applying their rules | `examples/charters` |
| Evaluation | 21 seeded failures and clean runs, played against the real daemon and checks with no model calls, and scored by the real watcher on scripted traces. Thresholds are set on a calibration half and reported on a held-out half | `src/bench`, `results/evaluation` |
| Recorded runs | Live runs with their ledgers, session streams and signed receipts, with personal details of the computer removed (D-086) | `results/runs` |

## Known limits

These hold today, and the receipt says so where they apply.

- **The record is tamper-evident on one machine.** Anchors are kept outside the run folder, on the same machine and under the same user. An anchor kept elsewhere, such as in git, is not built.
- **The signature does not show who signed.** The public key travels inside the receipt. The key id has to reach a reviewer by another route.
- **Rules read command text.** A script that builds its statement at run time, or loads a helper file, can run an irreversible action unheld (D-038, D-083). The lasting fix is for `candord` to run the approved action itself.
- **Hooks run on the worker machine.** On an unmanaged machine Candor can detect that the hooks were turned off, and cannot prevent it.
- **The heartbeat is written at start only.** A session that stops sending hooks is noticed only when the daemon starts again, not by a timer. Interval checkpoints are not built.
- **One writer is assumed.** Nothing stops a second process from writing the ledger.
- **Redaction is pattern based.** It cannot catch every secret.
- **A receipt cannot be amended.** A finding after issue needs a new receipt.
- **A restart does not score the old branch again**, and a rule cannot be removed once added.
- **Tokens and the delay the hooks add are not recorded.** Cost, turns and active minutes are.
- **The evaluation is small.** The traces are authored, one rubric and one watcher model were used, and no person has labelled a sample of watcher verdicts. The two-tier live study of worker models is not done (D-078).
- **Candor is not yet a plugin you can install.** It is installed as a command-line tool. The hooks and pane in `plugin/` work from this repository only, and the pane has been seen in a terminal, not in the Desktop Code tab. The hosted console is the main view (D-079).
- **The charter review is rule based**, with no model call.
- **Security alerts in the test tooling.** `npm audit --omit=dev` reports none for what Candor runs. `npm audit` and Dependabot report findings in the test tooling that Vitest 3 brings in (tinypool and @vitest/mocker). None of it ships with Candor, and the tests give it no untrusted input. The fix is a later Vitest major, which installs a package under MPL-2.0 and so breaks the license policy (D-009).

## Next

- **Run the tests of the hosted job.** The hosted job reads the code and never runs it. A sandbox that can execute code would let the checks run the tests of the service on the original and on the migrated code.

1. **A scripted demo.** `npm run demo` runs the full story through the real daemon, with no API key.
2. **A live run that pauses.** Drift rises, the watcher pauses the job, the operator adds a rule, earlier checkpoints are scored again, and the operator restarts from the suggested point.
3. **A summary of each run that a person can act on.** Measure how long and complex recorded runs are, and give each run a short summary of what happened, what needs a decision and what to check.
4. **Tool profiles.** Move the rules that know about `sqlite3` out of the core checks into a profile a charter names, so other tools get their own.
5. **An architecture guide.** `docs/ARCHITECTURE.md` covers the components, the data flow, and what is configurable and what is fixed.
6. **Candor as a Claude Code plugin.** Install it with `/plugin install` from a marketplace in this repository, instead of from a clone. The plugin carries the hooks, with paths resolved from the plugin root so it works from any copy (D-018), slash commands for status, approve, rule and restart, and the pane, checked in the Desktop Code tab as well as the terminal. A plugin has no Node, so the `candor` command and `candord` are still installed with npm, and the plugin calls them. Until then Candor is installed as a command-line tool, and `plugin/` holds the hooks and a pane spike.
7. **Results written into the documents.** `npm run results:render` writes `docs/RESULTS.md` from `results/`, so no number is typed by hand.
8. **Approved actions run by the daemon.** `candord` runs an approved irreversible action itself, which closes the gap in D-083.
9. **An anchor outside the machine, and receipt amendment.**
10. **A person-labelled sample of watcher verdicts, and the two-tier study of worker models.**
