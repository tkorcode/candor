# From prototype to MVP: technical design

The prototype proves the oversight loop for one operator on one machine, and in a hosted job for one reader at a time. The MVP serves a team running real jobs on real code and data, with a trust boundary that does not rest on permission rules between processes run by the same user. This document covers the architecture, model integration, scaling and the tradeoffs behind each choice. `docs/SPEC.md` and `docs/DECISIONS.md` describe what exists today.

## What carries over unchanged

The charter and its review, the ledger format and `candor verify`, the four drift dimensions and the rule that overall drift is the highest of them, re-scoring from stored evidence, restart as a fork with lineage, and the receipt with two verdicts. These are the product. The MVP changes where they run and who can reach them.

## Architecture

| Plane | Prototype | MVP |
|---|---|---|
| **Execution** | Claude Code on the machine of the operator, sandboxed, as the same user as `candord` | One container or VM per job. The hosted job already does this: separate OS users keep the worker away from Candor, there is no internet, and the API key never enters the container (D-094, D-095). Claude Code runs under managed settings that allow only managed hooks and refuse to run unsandboxed |
| **Capture** | Hooks to a local daemon over a Unix socket, failing closed | The same, with the daemon inside the job boundary for low latency, and every entry copied out to the control plane as it is written. The hosted job already copies each entry out and checks that it links up |
| **Second witness** | None. The ledger is the only record | A model gateway on the only egress path records every request and response. Each tool call the model asked for must match a hook event in the ledger. A mismatch is an event that never reached a hook, which today is listed in the coverage statement as unseen |
| **Evidence** | Ledger, blobs and snapshots in a local run store, with a file anchor | Content-addressed blobs and snapshots in object storage. Ledger heads anchored in storage with a retention lock, or a transparency log, outside the reach of anyone who runs the job |
| **Irreversible actions** | Held, then approved by digest of the command text. A script that builds its command at run time can get past this (D-038, D-083) | An effects broker. The worker requests a typed action (deploy, swap a table, post entries). After approval, the broker runs it with credentials the worker never holds. This closes D-083 by design |
| **Identity and keys** | A local Ed25519 key, with the key id sent by a separate route | Keys in a KMS, signing tied to an organization identity, and a published key id that reviewers can look up. SSO, with roles for operator, reviewer and approver |
| **Review** | `candor` commands and the console | A multi-tenant console, with notifications when a job pauses or holds an action, and receipts reviewers can search |

## Model integration

- **Worker.** Claude Code through the CLI or the Agent SDK, which both support hooks, budgets, resume and session fork. For Managed Agents, Candor needs the same event stream and a way to hold a tool call. Whether its hooks expose both is the first question to settle with the platform team.
- **Watcher.** The Messages API with a structured output schema and no tools. Worker output reaches it as data inside a delimited block, and worker reasoning is never sent. The charter and rubric are the same on every call for a run, so prompt caching cuts most of the repeated input cost.
- **Final acceptance.** Deterministic acceptance checks on the final state, and optionally Outcomes in Managed Agents as a graded check of the finished artifact, recorded in the ledger like any other check.
- **Model choice.** The watcher uses a different tier from the worker where possible. Both model IDs go in the ledger, and the receipt names them.

## Scaling

- **Watcher calls scale with stages, not with tool calls.** A job with hundreds of tool calls has a handful of checkpoints. Deterministic rules run on every action and take no model call.
- **The hook is on the critical path of every tool call,** so the rules stay deterministic and local, and the ledger write is the only work done before an answer. Hook latency is not measured yet, and it is the first number to measure for the MVP.
- **Re-scoring costs one watcher call per earlier checkpoint** on the branch. It runs under the budget of the run and in parallel, and is capped per rule change.
- **Forks are cheap.** Snapshots are git objects, so branches share unchanged content.
- **Tiered watching.** A small model at every stage, and a stronger one only when the small one warns or the stage precedes an irreversible action.

## Tradeoffs

| Choice | Taken | Cost of the alternative |
|---|---|---|
| Hooks or a proxy | Both in the MVP. Hooks see and can hold tool calls before they run. A proxy sees only model traffic | Hooks alone run on the worker machine. A proxy alone cannot stop a tool call |
| Daemon local to the job, or remote | Local for the decision, with every entry copied out | Remote adds a network round trip to every tool call |
| Pause the job, or only warn | The charter sets both levels | Pausing too often burns review time. Warning only lets drift compound |
| One drift number, or dimensions | Four dimensions, with the highest as the overall value | Averaging hides one bad dimension |
| Hold irreversible actions | Always, bound to the exact action | Throughput is lower, but rollback cannot undo an outside effect |
| Watcher sees reasoning | Never | Reading the reasoning invites persuasion, and research shows reasoning monitors can be evaded |

## What the MVP must measure

- Human review minutes per agent hour, against the current process of each pilot partner.
- Catches, misses and false alarms of the watcher on each domain, with a person-labelled sample of verdicts.
- Verified-but-wrong results against known answers. One is the most serious finding there can be.
- Overhead: hook latency, watcher tokens and cost per checkpoint, beside the cost of the work.

## Open questions

- Can Managed Agents expose tool events with the ability to hold a call, so Candor can run there as well as in Claude Code?
- Can the provider sign a session record, so the second witness is the platform itself?
- Which receipt fields do auditors in each regulated domain need, and can they converge on one open format?
