# Sources and evidence

The sources behind the design choices and claims in this repository, checked on 14 to 17 November 2026. This field changes quickly, so check the current version of a source before quoting it. Items marked **self-reported** come from the lab or vendor and have no independent review.

## A. How Claude Code works today (read before building)

| Source | Use it for |
|---|---|
| [Best practices](https://code.claude.com/docs/en/best-practices) | How to run this build: short CLAUDE.md, a check to run, Stop hook, review against the spec, unattended runs |
| [Hooks reference](https://code.claude.com/docs/en/hooks) | The 33 events, handler types, how PreToolUse allows or denies, input fields |
| [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview) | What a mod can do, where it draws, trust and version requirements |
| [Mods: draw in the interface](https://code.claude.com/docs/en/plugins/mods/interface) | Panes, band, elements, state |
| [Mods: create](https://code.claude.com/docs/en/plugins/mods/create), [test](https://code.claude.com/docs/en/plugins/mods/test), [reference](https://code.claude.com/docs/en/plugins/mods/reference), [API](https://code.claude.com/docs/en/plugins/mods/api), [events](https://code.claude.com/docs/en/plugins/mods/events) | Building, validating and testing the pane |
| [Skills](https://code.claude.com/docs/en/skills) | Skill file format and frontmatter |
| [Subagents](https://code.claude.com/docs/en/sub-agents) | Reviewer subagents with fresh context |
| [Checkpointing](https://code.claude.com/docs/en/checkpointing) | What native rewind covers and what it does not |
| [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | API key authentication, branding rules |
| [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) | `maxBudgetUsd`, `maxTurns`, `resume`, `forkSession`, `resumeSessionAt`, `outputFormat`, `sandbox` |
| [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | Fork copies the conversation, not the files |
| [Settings reference](https://code.claude.com/docs/en/settings-reference) | Managed settings, deny rules, sandbox filesystem rules |
| [Sandboxing](https://code.claude.com/docs/en/sandboxing) | Denying the worker shell write access to the run store |
| [Desktop application](https://code.claude.com/docs/en/desktop) | Worktree sessions, what differs from the CLI |
| [Headless mode](https://code.claude.com/docs/en/headless) | Scripted runs, `--max-budget-usd`, `--max-turns` |
| [Documentation index](https://code.claude.com/docs/llms.txt) | Finding any other page |

## B. Evidence for the need

| Source | What it supports | Caution |
|---|---|---|
| [Yahoo Tech on Fable 5.2](https://tech.yahoo.com/ai/claude/articles/anthropic-claims-claude-models-solve-155650433.html), [Interesting Engineering](https://interestingengineering.com/ai-robotics/anthropic-claude-fable-5-2-operating-system) | More than 1,000 subagents for eight days. Length has arrived | Self-reported |
| [AGI Tracker on METR horizons](https://agitracker.io/blog/metr-time-horizons-2026/) | About 17 hours at 50% reliability against 3 hours 6 minutes at 80%, for an early Claude Mythos Preview | Secondary source. Find the newest METR figure before quoting |
| [Lindy on Fable 5.2](https://www.lindy.ai/blog/claude-fable-5-2) | The behavioral audit reports fewer false claims of finished work | Secondary source |
| [Claude blog: Managed Agents](https://claude.com/blog/new-in-claude-managed-agents) | Outcomes: a rubric scored by a separate grader in its own context, public beta | This is the closest existing Anthropic feature. Position against it |
| [Pinggy on decision models](https://pinggy.io/blog/best_ai_decision_models/) | Cheap, fast assessment models exist at five providers | Not Anthropic |
| [VentureBeat, October](https://venturebeat.com/orchestration/the-share-of-enterprises-trusting-ai-agents-to-make-production-changes-on-their-own-has-fallen-from-75-to-56-vb-intelligence-finds) | Share of enterprises letting agents change production unreviewed fell from 75% to 56% | Survey |
| [G2 research](https://www.morningstar.com/news/pr-newswire/20261014cg71331/new-g2-research-ai-agents-have-moved-from-pilot-to-production-but-oversight-comes-at-a-cost) | 52% require human quality review before an agent reaches production | Survey, press release |

## C. Evidence for the design

| Source | What it supports |
|---|---|
| [LLM Agents Can Easily Tamper With Their Own Traces](https://arxiv.org/pdf/2609.30266) | Why the ledger and its writer sit outside the worker. Recommends an independent gateway, append only, failing closed |
| [Stress Testing Chain-of-Thought Monitoring Against Covert Misalignment](https://arxiv.org/html/2611.07586v1) | Reasoning monitors evaded about 60% of the time under adaptive concealment. A trajectory-level monitor raised detection from 0.26 to 0.91 AUC. Why the watcher scores stages and trajectories, and why it must be measured |
| [Safe to Resume?](https://arxiv.org/pdf/2608.29381) | 1,735 executions, 67% of checkpoints omitted state needed to resume safely, one approval led to two payments. Why restart is a fork, approvals do not carry over, and effects are registered |
| [Help Net Security on EU AI Act logging](https://www.helpnetsecurity.com/2026/04/16/eu-ai-act-logging-requirements/) | Article 12 requires automatic logs but prescribes no format |
| [IETF draft: agent audit trail](https://datatracker.ietf.org/doc/draft-sharif-agent-audit-trail/) | A hash-chained audit format exists only as an individual draft. No format is final |
| [Tian Pan on earned autonomy](https://tianpan.co/blog/2026/04/17/earned-autonomy-ai-agents-progressive-supervision) | Promotion by thresholds set in advance, documented, reversible. Attention fade as a risk |

## D. What already exists

| Source | What it is |
|---|---|
| [Checkpoints by Entire, review](https://aicoolies.com/reviews/checkpoints-review) | Agent sessions in git with rewind and resume |
| [Help Net Security on Drata](https://www.helpnetsecurity.com/2026/06/10/drata-ai-agent-governance/) | Fleet inventory, per-agent policy on each action, tamper-evident record |
| [Asqav](https://www.asqav.com/docs/claude-code-audit-trail) | Signed receipts per tool call for Claude Code |
| [Tracekit](https://arxiv.org/abs/2609.35659v1) | Open research system with a chained ledger and a policy gate |
| [Actae on durable execution](https://actae.dev/blog/durable-execution-ai-agents-compared/) | How Temporal, DBOS and LangGraph fork and resume |

Products found later, and what they do that Candor does not, are in D-081.
