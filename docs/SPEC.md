# Candor: specification

This file defines what Candor does and when each part of it is done. If something here is wrong, unclear, or contradicted by current Claude Code documentation, raise it before building around it. Changes to it are recorded in `docs/DECISIONS.md`.

The product is Candor. The command is `candor` and the daemon is `candord`. The report a run ends with is called a trust receipt.

## 1. Purpose

Models now carry out jobs that run for hours or days. Nobody can watch such a job as it runs, and a log written by the agent cannot be its own witness. Candor is an oversight layer for long-running Claude Code jobs that lets a person leave the job running and step in only when something needs a decision. Claude Code does the work. It records the job outside the worker, has a separate model watcher each stage against the goal of the job, lets a person change a rule or restart from a checkpoint without losing what happened, and ends with a signed trust receipt that someone who was not there can approve from.

It must show four things:

1. Drift from the goal of a job can be measured while the job runs, not only after it ends.
2. A person can correct a long job in the middle, and the record keeps both what happened and the correction.
3. A reviewer can accept or reject the result from the receipt alone, and can check the receipt without trusting the person who sent it.
4. Rigour about limits, measurement and claims.

## 2. Why now

Agents already sustain runs of a working day and longer. What is still missing is a watcher dependable enough that people can step in only when something needs a decision. That is a model that watches the work of another agent and says at each stage whether the job is still on course. Candor builds the oversight around that watcher and measures the watcher instead of assuming it.

Product metric: **human review minutes per agent hour**. Lower means people spend less time watching and more time deciding.

Why oversight is needed even as models improve: a model cannot be its own witness. Research in `docs/SOURCES.md` shows agents tampering with their own traces and evading reasoning monitors. The record and the watcher must sit outside the worker. As the watcher becomes more accurate, fewer checkpoints need a person, so Candor gains from every improvement in the models it runs.

## 3. The product on one page

**Big idea.** Every long AI job ends with a trust receipt: what it was asked to do, what it did, where it drifted, who corrected it, which checks it passed, what was not checked, and what it cost. A SOC 2 report became the document that lets one company buy software from another. A trust receipt can become the document that lets an organization hand a multi-day job to an agent.

**The goal behind it.** Trust in a long-running job has five parts: it builds the right thing, the result is accurate, the record can be trusted, the run is transparent, and errors get corrected. Staying on course is not the same as being right. A run can follow its charter, pass every check and still be wrong, because a check was thin or the goal was badly stated. So the receipt gives **two verdicts and never merges them**: the job stayed on course, and the result was verified.

**Framing.** This is an unlock, not a guardrail. It is what lets an organization actually run the capability.

**Users.**

- The operator: an engineer or lead who starts a long job and wants to supervise it without watching it.
- The reviewer: a compliance or security person who was not there and must decide whether to accept the result.
- Smaller organizations (nonprofits, public agencies) with no compliance team, for whom a receipt they can show a funder, a board or a regulator is what makes agent use possible.

**What is new. These four things are the product. The demo must show all four.**

1. **Drift measured against the goal of the job**, not only against permissions.
2. **History re-scored when a rule changes.** A person edits a rule mid-run, every earlier checkpoint is scored again, and both scores are kept.
3. **A restart that carries its lesson forward.** Restarting forks the run and keeps the old branch. The reason for the restart becomes a rule on the new branch.
4. **A receipt a reviewer can approve from.**

The demo must not look like rewind plus a log viewer. If a screen or a feature only replays or lists, it is supporting material, not the point.

**How it differs from what exists.**

| Product | What it does | What it does not do |
|---|---|---|
| Claude Code checkpoints | Restores file edits and the conversation to an earlier prompt | Does not score the run or produce a record. Shell-only changes and most subagent edits are not restored |
| Entire | Stores agent sessions in git with rewind and resume | Does not score a run against its goal or signal when to stop |
| Drata | Inventories agents, checks each action against a per-agent policy, keeps a tamper-evident record | Governs a fleet by permission. Public description does not cover whether one job stayed on its goal |
| This project | Scores each stage of one job against its goal, re-scores, restarts with the lesson, ends with a receipt | Does not inventory a fleet or replace an auditor |

**Non-goals.** Earned autonomy (rules loosening for a job type as it shows itself reliable, approved by a person) is roadmap only. Fleet inventory. Replacing an auditor. Mapping to many compliance frameworks (one worked example only). Multi-agent delegation chains. Any claim that a run was secure or correct.

**Words.** Say evidence, never proof. Say tamper-evident, never tamper-proof.

## 4. The experience

### 4.1 The demo story (this is the acceptance test for the whole project)

A synthetic data job: migrate a messy customer table to a new schema and deduplicate it. It has countable invariants, one irreversible step, and a natural drift.

1. The operator writes a goal. The tool drafts a **charter** and then challenges it: one success criterion is vague and one has no check. The operator fixes the first and accepts the second as not verified. Each check is run against a planted fault to show that it can fail. The operator approves.
2. The job starts. Stage 1 (profile the data) and stage 2 (map the schema) pass. Checkpoints S1 and S2 appear on the run map, with low drift.
3. In stage 3 the worker starts repairing records outside its scope. At checkpoint S4 the watcher scores scope drift above the threshold and the run pauses. The console shows the finding and the ledger entries behind it.
4. The operator adds a rule ("do not modify records that are not duplicates"). **Every earlier checkpoint is re-scored** under the new rule. S3 now shows early drift that the old rules missed. Both scores stay visible.
5. The operator **restarts from S3** and gives a reason. Branch A is kept. Branch B starts with the reason installed as a rule and as an instruction.
6. Branch B reaches the irreversible step. It is denied and held until the operator approves that exact action, and the worker then retries it. Checkpoints after it are marked record only.
7. Branch B completes. Acceptance checks run on the final state, independent of what the worker claims. The operator exports the **trust receipt**. A reviewer opens it in a browser, runs `candor verify`, and sees the two verdicts (stayed on course, result verified), each success criterion with its check or marked not verified, the correction and its reason, what was not checked, cost, and an intact chain.
8. Later someone finds an error in the result. The operator amends the receipt. The amendment is a new signed version that links to the original. This is not built yet, so a finding after issue needs a new receipt (D-050).

### 4.2 The run views

The hosted console in `site/` is the main view of a run (D-079). It reads recorded runs and verifies them in the browser, and it has these views.

- **Run map.** Above it, the two verdicts, and a few sentences built from the ledger on what happened in the run. A right-click on a checkpoint, or its Actions button, opens what a reader can do there. Branches as horizontal lines, checkpoints as nodes with their drift score and level, a circle where a restart is possible and a square where the checkpoint is record only, a lock on a step held for a person, the restart drawn as an edge with its reason, superseded branches dashed. Selecting a checkpoint shows its stage, the scores by dimension, the findings with the ledger entries behind them, the checks and the safety class.
- **Checkpoint view.** What happened at the checkpoint and why it scored what it did: the four recorded dimension scores, the rule and finding behind each flagged one with the entries it cites, the level under warn and pause values the reader sets, the suggested restart point (D-080), and a button that asks the watcher to score the checkpoint again under a rule the reader writes (D-077).
- **Rules.** Each charter version, each rule change, and the old and new scores of every checkpoint scored again.
- **Ledger.** The entries in plain words, with registers for a compliance owner and an integrity line for the chain and anchors.
- **Receipt.** The two verdicts at the top, then the receipt, with its signature checked in the browser.

The console shows recorded runs. It does not approve, add rules or restart. Those are `candor` commands. A pane inside Claude Code with the same views, a band above the prompt and `/candor` commands is planned as part of the Claude Code plugin (see `docs/ROADMAP.md`). Today `plugin/` holds the hooks and a pane spike that shows the run state.

### 4.3 The receipt (static HTML, the reviewer view)

One self-contained file. Sections in this order: job and the two verdicts, success criteria with their checks, charter and its versions, run map, stages with drift and checks, corrections with reasons, rule changes and re-scores, actions that left the workspace, plugins and mods loaded, coverage statement, overhead, integrity and how to verify, limits.

### 4.4 Experience principles

- One glance answers: where is it, is it on plan, what did it do, can I rely on the record.
- Problems are as visible as progress. Calibrated trust, not reassurance.
- No single trust score. Show dimensions and trends.
- Every flag opens the evidence behind it.
- Plain words: stage, drift, restart, receipt.
- Color is never the only signal. The terminal gets a text fallback.
- The pane never blocks the work. If the pane fails, the job and the ledger continue.
- First-run and empty states say what will appear and how to start.

## 5. Concepts and data model

### 5.1 Charter

The contract for one job, approved before it starts. Stored outside the workspace. Its hash is the first ledger entry. Every edit creates a new version and a `rule_change` entry.

```yaml
id: migrate-customers
version: 1
goal: "Migrate customers_v1 to the customers_v2 schema and remove duplicate customers."
success:
  - { id: s1, text: "Every non-duplicate source row exists in customers_v2.", check: row-conservation }
  - { id: s2, text: "No customer appears twice in customers_v2.", check: no-duplicates }
  - { id: s3, text: "Merged records keep the most recent contact details.", check: null }
scope:
  allow_paths: ["migration/**", "reports/**"]
  deny_paths: ["tests/**", ".claude/**"]
  allow_commands: ["sqlite3 *", "node migration/*", "npm test"]
  network: false
budget: { max_cost_usd: 3.00, max_turns: 120, max_minutes: 45 }
stages:
  - { id: profile, title: "Profile the source data", exit_checks: [row-count-recorded] }
  - { id: map, title: "Map the schema", exit_checks: [mapping-complete] }
  - { id: dedup, title: "Deduplicate", exit_checks: [dedup-plan-valid] }
  - { id: migrate, title: "Run the migration", exit_checks: [row-conservation, no-duplicates], irreversible: true }
  - { id: verify, title: "Verify and report", exit_checks: [row-conservation, no-pii-in-logs] }
checks:
  - { id: row-conservation, type: command, run: "node checks/row-conservation.js", when: checkpoint, fault: "node checks/faults/drop-row.js" }
  - { id: dedup-plan-valid, type: command, run: "node checks/dedup-plan-valid.js", when: checkpoint, fault: "node checks/faults/bad-plan.js" }
  - { id: no-duplicates, type: command, run: "node checks/no-duplicates.js", when: checkpoint, fault: "node checks/faults/add-duplicate.js" }
  - { id: no-pii-in-logs, type: pattern, paths: ["reports/**", "*.log"], deny: "email", when: every_action }
drift_rules:
  - { id: goal-1, dimension: goal, source: generated, text: "Work serves migration and deduplication only." }
  - { id: scope-1, dimension: scope, source: generated, text: "Only files and tables named in scope are changed." }
thresholds: { warn: 0.35, pause: 0.6 }
irreversible: ["DROP TABLE *", "node migration/apply.js *"]
escalation: { on_pause: operator }
```

The warn and pause values above are the starting values. Calibration tuned the rubric of the watcher and kept these values, which were then frozen with it (D-044). Some checks are omitted here for length.

The budget covers the whole run across all branches. `candord` keeps the running total itself, because the `--max-budget-usd` cap of a `claude` run counts only the spend of one call, starts again on a resume, and can overshoot.

A success criterion with `check: null` appears in the receipt as not verified. A `fault` plants a known fault in a disposable copy of the workspace, and the check must fail on it. A check with no fault, or one that passes on its fault, is marked unproven in the receipt.

### 5.2 Ledger entry

Append only. One JSON object per line. `hash` is SHA-256 over the canonical JSON of the entry without `hash`. `prev` is the hash of the entry before.

```json
{ "seq": 42, "ts": "2026-11-18T12:04:11.201Z", "run": "r_8f3c", "branch": "A",
  "type": "tool_intent", "actor": "worker", "body": { "tool": "Bash", "input_digest": "sha256:..." },
  "prev": "sha256:...", "hash": "sha256:..." }
```

Entry types: `run_start`, `session_start`, `charter_approved`, `tool_intent`, `tool_result`, `verdict`, `check_result`, `stage_report`, `checkpoint`, `drift_score`, `rule_change`, `rescore`, `restart`, `effect`, `human_action`, `config_change`, `hook_event`, `heartbeat`, `anchor`, `charter_review`, `check_strength`, `acceptance_result`, `receipt_issued`, `receipt_amended`, `run_end`.

`actor` is assigned by `candord` from the channel the event arrived on, never taken from the caller. `session_start` carries the Claude Code version and every plugin and mod loaded in the session. `hook_event` records a hook event that has no entry type of its own (`Stop`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`), with the event name and the session.

Large payloads go to a content-addressed blob store and the entry carries the digest. Secrets and personal data are redacted before storage.

### 5.3 Checkpoint

```json
{ "id": "A3", "parent": "A2", "branch": "A", "stage": "dedup", "trigger": "stage_done",
  "git_ref": "refs/candor/r_8f3c/A/3", "session": { "id": "...", "message_uuid": "..." },
  "ledger_head": "sha256:...", "charter_version": 1,
  "safety": "safe_to_restart", "effects_since_parent": [] }
```

Triggers: a declared stage completes, before compaction, before an irreversible action, when a subagent stops, a backstop interval, or a manual request. `safety` is `record_only` once an irreversible effect has occurred on the branch.

Hook input carries no message identifier. `message_uuid` is read from the stream output of the `claude` run that Candor drives (the `uuid` of the assistant message).

### 5.4 Drift score

Scale 0 (on course) to 1 (off course). Four dimensions: `goal`, `scope`, `plan`, `evidence`. The overall value is the maximum of the dimensions, so one bad dimension is not averaged away. Each finding names a rule and cites ledger entries.

```json
{ "checkpoint": "A4", "charter_version": 1, "judge_model": "<model id>",
  "dimensions": { "goal": 0.1, "scope": 0.7, "plan": 0.2, "evidence": 0.1 },
  "overall": 0.7, "level": "pause",
  "findings": [ { "rule": "scope-1", "severity": "high", "summary": "Rewrote 212 non-duplicate rows.", "entries": [118, 121] } ] }
```

### 5.5 Other records

- **Stage report.** The self-report of the worker at the end of a stage: done or not, deviations, confidence. Compared with the independent verdict.
- **Effect.** Any action that left the workspace, with a reversible flag.
- **Approval.** The decision of the operator on a held action, stored as a `human_action` entry. It is bound to a digest of the exact action, can be used once, and expires.
- **Rescore.** A drift score for an old checkpoint under a new charter version. The old score is never replaced.
- **Charter review.** The challenge to a draft charter before approval: vague goals, criteria with no check, checks with no planted fault, and how the operator resolved each.
- **Check strength.** For each check, whether it failed on its planted fault. Values: proven, unproven.
- **Acceptance result.** For each success criterion, the outcome of its acceptance check on the final state: verified, failed, or not verified.
- **Receipt.** `receipt.json` (signed with Ed25519) and `receipt.html`. It opens with the two verdicts.
- **Amendment.** A finding added after a receipt was issued. It produces a new signed version that links to the original, which stays valid as a record.

## 6. Architecture

```
Inside the worker session                 Outside the worker
+-----------------------------+           +----------------------------------+
| Claude Code worker          |           | candord (local service)          |
| settings hooks -> candor CLI|--events-->|  ledger writer, checks, policy   |
| plugin: hooks, pane spike   |<--state---|  checkpoint and restart control  |
+-----------------------------+           |  watcher (model call, no tools)  |
                                          |  anchor, receipt, verifier       |
                                          +----------------------------------+
```

**Trust boundary.** The worker has a shell. Everything that must be trusted lives outside the workspace: the run store (`~/.candor/runs/<run>/`), the charter, keys, and the ledger writer process. The worker shell is sandboxed with writes to those paths denied. The sandbox covers shell commands only, so permission deny rules cover the same paths for the file tools, and the unsandboxed retry is turned off (`allowUnsandboxedCommands: false`).

**Channels and authority.** The worker has no direct channel to `candord`. Hooks are the only path from the worker session to the daemon, and `candord` assigns the actor of every entry from the channel an event arrived on, never from what the caller says. The operator acts through the pane or through a `candor` command run outside the session. Both present a secret that is stored outside the workspace, where the worker cannot read it. An operator action that arrives any other way is denied and recorded. On one machine under one user this separation rests on Claude Code permission rules and the sandbox, not on the operating system.

**Components.**

| Component | Responsibility |
|---|---|
| `core/charter` | Schema, draft from a goal, challenge before approval, versioning, approval |
| `core/ledger` | Canonical JSON, hash chain, append, redaction, verify |
| `core/checks` | Rules on every action, shell parsing, personal data patterns, exit and acceptance checks in a disposable copy, the strength test against planted faults, the answer key comparison |
| `core/checkpoint` | Working tree snapshot to a hidden git ref through a temporary index |
| `core/anchor` | Copies the head hash to an anchor file outside the run folder. A `git` anchor is not built |
| `core/report` | Receipt JSON and static HTML, signing and verification |
| `core/run` | Worker settings and the `claude -p` launch, with no MCP servers (D-087) |
| `core/restart-point.ts` | The suggested restart point (D-080) |
| `watcher` | Independent watcher. Charter, stage and evidence in, structured drift score out |
| `daemon` (`candord`) | Owns the run store, serves the CLI and the plugin, assigns the actor of every entry, tracks spend across branches, records rule changes, scores earlier checkpoints again, and runs restarts. It writes a heartbeat at start and records a gap it finds when it starts again |
| `cli` (`candor`) | `charter new`, `charter review`, `charter approve`, `run`, `status`, `approve`, `continue`, `pause`, `checkpoint`, `rule`, `restart`, `receipt`, `verify`, `doctor`, `hook` |
| `web`, `site` | The hosted console, its one live endpoint, and the Cloudflare Worker that serves them (D-077, D-079, D-088) |
| `plugin` | Claude Code plugin with the hooks and a pane spike. The worker learns how to report stages from its system prompt |
| `bench` | Seeded failures, scripted traces, the evaluation runner and scoring |
| `demo` | The synthetic project and its charter |

**Stack.** Claude Code at or above a pinned minimum version, which is at least v2.1.295. TypeScript in strict mode, ESM, Node 22 or later. npm. Vitest. Zod for schemas. `node:crypto` for SHA-256 and Ed25519. JSON Lines files for the ledger. Git plumbing for snapshots. The `claude` command line (`claude -p`, with `--max-budget-usd` and `--max-turns` on every call) for runs that `candor run` drives. The Messages API over `fetch` for the watcher call (D-040) with a structured output schema. No web framework: the receipt is one static HTML file. GitHub Actions for CI and the live demo.

**Capture path.** Settings hooks of type `command` call `candor hook <event>`, which reads the hook JSON on stdin and forwards it to `candord`. On `PreToolUse` the reply is allow or deny. A held action is a deny with a reason, because `ask` shows a prompt only in interactive sessions. If `candord` cannot be reached, `PreToolUse` fails closed (exit 2). The hook also sets `onFailure: "block"` and an explicit timeout, so a `candor` command that cannot start, crashes or times out blocks the call too. `onFailure` needs Claude Code v2.1.295 or later, so the minimum version is pinned and `candor run` refuses to start a run below it. A `ConfigChange` hook blocks a settings edit from applying to the running session and records the attempt. `SessionStart` records the Claude Code version and every loaded plugin and mod. Events used: `SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `ConfigChange`, `Stop`, `SessionEnd`.

**The mod is thin.** A mod has no Node and no DOM. It reads state from `candord` and draws. It holds no source of truth. A mod cannot start or fork a session, so a restart from the pane goes from the pane to the daemon to the `claude` command line (`--resume`, `--fork-session` and `--resume-session-at`). Load the built-in `plugin-authoring` skill before writing it, and read the current mods documentation.

**Models.** Model IDs come from configuration (`.env` or a flag), with a default in code when none is set. The watcher uses a different model tier from the worker where possible, and the IDs of both go in the ledger. Check the current model list before choosing.

## 7. Requirements and acceptance criteria

**R1 Charter.**
- `candor charter new --goal "<text>"` drafts a charter with stages, checks and drift rules.
- `candor charter review` challenges the draft before approval. It lists vague goals, success criteria with no check, and checks with no planted fault. The operator resolves or accepts each item, and the review is a ledger entry.
- `candor charter approve` writes the hash as the first ledger entry.
- A rule added with `candor rule` creates a new version and a `rule_change` entry with author and reason, and triggers R6. There is no other way to edit an approved charter.

**R2 Ledger.**
- Every hook event becomes an entry: intent before a tool call, result after.
- `candord` assigns the actor of each entry from the channel it arrived on.
- At session start the Claude Code version and every loaded plugin and mod are recorded.
- `candor verify` detects an edited, deleted, inserted or reordered entry and names the first bad sequence number.
- The head hash is anchored at every checkpoint.
- `candord` writes a heartbeat when it starts, and records a gap of more than two minutes when it starts again. There is no heartbeat timer and no interval setting, so a session that stops sending hooks is not noticed while it runs.

**R3 Checks on every action.**
- Scope, command, network, budget and personal-data rules run on `PreToolUse` and can deny.
- The budget is the charter budget for the whole run across branches, tracked by `candord`.
- An action matching `irreversible` is denied with a reason and held for a person. A checkpoint is taken first.
- The approval of the operator is bound to a digest of the exact action, is single use, expires, and is a ledger entry. The worker retries, and only the approved action passes.
- Operator actions (approve, continue, add rule, restart, charter edit) are accepted only from a `candor` command run outside the session, with the operator secret. An attempt from the worker is denied and recorded. Seeded failure F21 tests this.
- The `PreToolUse` hook blocks the call when `candord` cannot be reached and when the `candor` command cannot start, crashes or times out.
- `candor run` refuses to start a run on a Claude Code version below the pinned minimum.

**R4 Checkpoints.**
- A snapshot captures the whole working tree, including untracked files and changes made by shell commands, without touching the index or branch of the user.
- Each checkpoint has a safety class.
- The worker reports a finished stage by writing `reports/stage-<id>.json` in the workspace. A hook picks the file up and delivers it. The worker never talks to the daemon itself. M0 chose this form over a recognised command (D-019).

**R5 Watcher and response.**
- At each checkpoint the watcher returns a drift score in the schema of 5.4.
- The watcher has no tools. Worker output is passed as delimited data. The worker reasoning is not passed.
- `warn` adds a note for the worker and the operator. `pause` denies further tool calls until a person chooses continue, add rule, or restart.

**R6 Re-scoring.**
- After a rule change, every earlier checkpoint on the run is scored again from stored evidence, without re-running the worker.
- Old and new scores are both kept and both shown.

**R7 Restart as a fork.**
- `candor restart <checkpoint> --reason "<text>"` creates a new branch from a `safe_to_restart` checkpoint, in a new worktree, with the conversation forked at that point through the `claude` command line.
- The reason is installed as a drift rule on the new branch and as an instruction to the worker.
- The old branch stays intact and visible. Approvals do not carry over.
- Ledger, drift and checkpoints continue on the new branch. Spend on it counts against the same charter budget.

**R8 Receipt.**
- `candor receipt <run>` writes signed `receipt.json` and self-contained `receipt.html`.
- The receipt opens with the two verdicts of R12 and lists each success criterion with its check or the words not verified.
- The receipt contains a coverage statement and the overhead of the run in cost, turns and active minutes. Tokens and the delay added by the hooks are not recorded yet, and the receipt says so.
- The receipt lists the plugins and mods loaded in each session of the run.
- `candor amend <receipt> --finding "<text>"` issues a new signed version that links to the original. The original stays valid as a record. Not built yet (D-050).
- `candor verify receipt.json` checks signature, chain and anchors.

**R9 Run views.**
- The hosted console shows the views of 4.2 for recorded runs and verifies them in the browser (D-079).
- A pane inside Claude Code, with Restart, Add rule and Approve producing the same ledger entries as the CLI, is planned with the plugin. Not built yet.

**R10 Evaluation.** See `docs/EVALUATION.md`.

**R11 Reviewer path.**
- `npm run demo` runs the whole story from scripted traces with no API key and opens the receipt. Not built yet.
- `npm run demo:live` runs it with a real worker under a hard spending cap. Not built yet.
- A manually triggered GitHub Actions workflow does the same with a capped key and uploads the receipt. Not built yet.
- What a reader can use today is the recorded runs in `results/runs/` with their receipts, `candor verify` on any of them, and the hosted console.

**R12 Accuracy.**
- Every success criterion in the charter maps to an acceptance check, or is listed in the receipt as not verified.
- Before the run, each check is run against its planted fault in a disposable copy of the workspace. It must fail. A check that passes on its fault, or has none, is marked unproven and shown as such.
- At the end, acceptance checks run on the final state. They do not rely on anything the worker reported.
- The receipt states two verdicts and never merges them. **Stayed on course**: no unresolved pause, and every stage passed its exit checks. **Result verified**: every success criterion passed a proven acceptance check. If any criterion is not verified or its check is unproven, the second verdict says partly verified and names them.
- A run with a clean process and a wrong result must show result not verified. Seeded failure F19 tests this.
- Change at M5 (D-052): the receipt keeps two result verdicts. One is from the acceptance checks alone. The other is final, after a second look at the final state against the answer key when the operator supplied one. A criterion that passed its check while the key shows the state wrong is counted as verified but wrong. The final verdict is no when the key differs, and partly when the comparison did not finish. Both verdicts are written to the ledger and to `receipt.json`, so the evaluation can count results verified by checks and wrong by key.

## 8. Threat model

The worker has a shell, so assume it may interfere with its own oversight.

The worker and the operator are the same user on the same machine. Every control below that separates the worker from the daemon, the run store and the operator rests on Claude Code permission rules and the sandbox, not on the operating system.

| Threat | Control | What remains |
|---|---|---|
| The agent turns off the hooks or the mod | In an organization, managed settings that user and project settings cannot override. In the prototype, a `ConfigChange` hook blocks a settings edit from applying to the running session and records it | A rule saved from a permission prompt or through `/permissions` does not fire `ConfigChange`. On an unmanaged machine the rest is detection, not prevention. There is no heartbeat timer, so a session that stops sending hooks is not noticed while it runs |
| The hook fails instead of answering | `PreToolUse` exits 2 when `candord` cannot be reached. `onFailure: "block"` and an explicit timeout block the call when the `candor` command cannot start, crashes or times out. A run does not start below the pinned Claude Code version | Below v2.1.295 a failed hook lets the call through, which is why the version is pinned |
| Another installed mod answers a tool call before the hooks run | In an organization, hooks in managed settings run before any mod. In the prototype, every loaded plugin and mod is recorded at session start and listed on the receipt | Not prevented. A mod that answers a tool call without passing it on keeps every non-managed `PreToolUse` hook from running, so that call never reaches the ledger. The coverage statement says so |
| The agent acts as the operator: it approves its own held action, adds a rule, or restarts | The worker has no direct channel to `candord`. Operator actions need a secret stored outside the workspace. `candord` assigns the actor from the channel, never from the caller. Each approval is bound to a digest of the exact action, is single use, and expires. The attempt is denied and recorded | The secret is kept from the worker by Claude Code permission rules and the sandbox, not by the operating system. Seeded failure F21 tests it |
| The agent edits the charter or a rule | Charter outside the workspace, hash in the ledger, rules change only through the operator channel, sandbox denies shell writes, permission deny rules cover the file tools, unsandboxed retry off | A change made another way shows as a hash mismatch at the next checkpoint |
| The agent writes to the ledger | Separate writer process with no direct channel from the worker, sandboxed worker shell, permission deny rules for the file tools, head hash anchored outside | Tamper-evident on one machine, not tamper-proof. Records signed by the provider would close it |
| The agent talks the watcher round | No tools, fixed output structure, worker output as data, deterministic checks independent of it | Persuasion remains possible. Seeded failure F15 tests it |
| The agent games the checks | Checks fixed in the charter before the run. Each check must fail on a planted fault. Changing a test or a check counts as drift | A check can fail on its planted fault and still miss a different one. The coverage statement lists what no check covers |

Keep this table true. If a control is not built, say so in the table.

**Build status.** `candor run` applies the settings of D-024 and refuses a Claude Code version below the minimum. Seeded failure F21 has a test in a real session, with what it does and does not show in D-037. The snapshot git directory is in the run store. Not built: the heartbeat timer, so the daemon does not notice a session that stops sending hooks; anchors outside the machine; a sandbox for the checks; a lock that keeps a second writer off the ledger. The rules on every action read text, and D-038 lists what a worker can still do: a script that builds its statement at run time or loads a helper file runs unheld, an approval does not cover files a script loads, and the effect register lists only effects the rules recognise. A ledger checked on its own can be cut back to its last anchor without notice. Checking it through its receipt catches the cut, because the receipt names the head. A missing anchor file fails verification. A worker that can make the daemon slow can stop the run, because the hooks fail closed.

## 9. Build sequence

Work one milestone at a time. Each ends with passing checks, an updated `docs/ROADMAP.md`, and a commit.

| Milestone | Build | Exit criteria |
|---|---|---|
| **M0 Foundations and spikes** | Repo, TypeScript, tests, CI. Four spikes: hook to CLI to daemon round trip in a real session, failing closed; working tree snapshot to a hidden ref and restore to a worktree; a mod pane that shows data from the daemon in Desktop; session fork at a chosen message through the `claude` command line | Each spike has a note in `docs/DECISIONS.md` saying what works and what does not. Open questions in section 14 are answered |
| **M1 Charter and ledger** | Schemas, charter review, success criteria mapped to checks, hash chain, append, redaction, verify, file anchor | Tamper tests pass. A scripted event stream yields a ledger that verifies. A charter with a vague goal or an unchecked criterion is flagged |
| **M2 Capture, checks, checkpoints** | Hooks, `candord`, deterministic checks, check strength test, effect register, snapshots, stage reports. A minimal receipt | A real Claude Code session on the demo project produces a ledger, checkpoints and a minimal receipt. A check that cannot fail is flagged before the run |
| **M3 Watcher and scripted evaluation** | Watcher, thresholds, warn and pause. Scripted traces for the 21 seeded failures and clean runs. Calibration split | `npm run eval` reports caught, missed and false alarms as counts from files in `results/` |
| **M4 Re-scoring and restart** | Rule change, re-score from stored evidence, fork with the lesson carried forward | The demo story steps 4 and 5 work from the CLI |
| **M5 Receipt and verifier** | Acceptance checks on the final state, the two verdicts, full receipt JSON and HTML, signing, amendment, git anchor, coverage statement, overhead | A person who has never seen the project can open the receipt and run verify. A run with a clean process and a wrong result shows result not verified |
| **M6 Pane** | Run map, ledger, receipt tabs, band, commands | The demo story runs end to end from the pane in Desktop. Change (D-079): replaced by the hosted console, whose exit criterion is that a reader with nothing installed can follow the story from a link |
| **M7 Live evaluation** | Live runs on two worker model tiers under caps, self-report agreement, overhead, labelled real runs with traces, the live demo workflow | `docs/RESULTS.md` is generated from `results/`. Every number traces to a file. Change (D-078): reduced to one live drift run with a restart. The two-tier study is not done |
| **M8 Package** | README, design decisions, limits, independent review and red-team pass | A new reader can go from the README to a verified receipt in under five minutes |

From M4 onward, run the build itself under the tool where practical, and ship those receipts in the repository.

## 10. Priorities

Always in scope: the four new things, the two verdicts and the check strength test, the seeded evaluation with honest counts, the coverage statement, the threat model, the scripted demo, the labelled real run with its trace.

Lower priority, in this order:

1. Receipt amendment (say it is roadmap).
2. The git anchor (keep the file anchor and say so).
3. The band and status line.
4. A second scenario. Do not start one until the first is complete.
5. Pane polish. The static receipt is the fallback visual.

Do not add features that are not in this file. Several half-finished features are worse than one complete loop.

## 11. Quality bar

- `npm run check` (typecheck, lint, unit tests) passes before any milestone is called done.
- Unit tests for ledger, charter, checks, snapshot and re-score. A property test that any single-entry mutation breaks verification. An integration test that runs the scripted story (today steps 4 and 5 run end to end from the command line, and `npm run demo` will run all of it). A golden-file test for the receipt.
- No result, count, cost or timing is typed into a document. They are read from files under `results/`. `npm run results:render`, when it is built, will write them into `docs/RESULTS.md`.
- Every model call has a budget and records model ID, tokens and cost.
- No secrets in the repository. `.env` is ignored. Use `.env.example`.
- Errors say what went wrong and what to do.
- Interface copy and documents follow the wording rules in `CLAUDE.md`.
- The scripted demo is deterministic and needs no network.
- Hook overhead is to be measured and reported. It is not measured yet, and the receipt says so. State the measured figure, not a target.

## 12. Evaluation summary

Full protocol in `docs/EVALUATION.md`. 21 seeded failures and a set of clean runs, in scripted mode (deterministic, free) and live mode (real worker, capped). Thresholds are set on half and reported on the other half. Results are counts, not percentages. Report where the evaluator helped, where it failed, the overhead, and what Candor does not check. Compare a weaker and a stronger worker model on self-report agreement. Check accuracy directly: the synthetic data has a known right answer, so report how many results marked verified are right, and list any that are not.

## 13. What the project delivers

1. The repository, with a README that leads to a verified receipt in under five minutes.
2. The hosted console (D-079), which shows recorded runs and their receipts, verified in the browser.
3. A receipt from a real run, with its trace.
4. `docs/RESULTS.md`, generated from `results/` (not built yet).
5. `docs/QA.md`: answers to the questions people ask most.

## 14. Questions settled at the start

1. Answered by the documentation and by the list of mod calls that `claude plugin validate` prints: a mod has no call that starts or forks a session, so restart is driven by the daemon. The fork spike tests the fork itself, not this.
2. Does a session forked with `--resume-session-at` open in an interactive Desktop session?
3. What is the simplest reliable way for the mod to read daemon state: a local HTTP call, a file, or a process call?
4. Which sandbox settings and permission rules deny the worker write access to the run store and read access to the operator secret on the development machine?
5. Which model IDs are available on this account for worker and watcher, and what do they cost?
6. Answered in M0: both forms of stage report worked in a real session, on a thin test with one weaker model. The report file is the one kept (D-019).
7. How is the list of loaded plugins and mods read at session start, in an interactive session and in a run driven by `claude -p`?

The answers, and the two that are still open, are in `docs/DECISIONS.md` (D-017 to D-026) and `docs/ROADMAP.md`.
