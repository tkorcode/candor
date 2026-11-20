# Sources and evidence

The sources behind the design choices and claims in this repository, checked on 14 to 17 November 2026 and checked again on 19 November 2026. This field changes quickly, so check the current version of a source before quoting it. Items marked **self-reported** come from the lab or vendor and have no independent review. Items marked **secondary** report on a primary source that was not read directly.

## A. How Claude Code works today (read before building)

| Source | Use it for |
|---|---|
| [Best practices](https://code.claude.com/docs/en/best-practices) | How to run this build: short CLAUDE.md, a check to run, Stop hook, review against the spec, unattended runs |
| [Hooks reference](https://code.claude.com/docs/en/hooks) | The 33 events, handler types, how PreToolUse allows or denies, `onFailure` (v2.1.295 or later), `ConfigChange`, input fields |
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
| [Anthropic: Claude Fable and Mythos 5.2](https://www.anthropic.com/news/claude-fable-and-mythos-5-2) (9 November 2026) | In internal testing Fable 5.2 coordinated more than 1,000 subagents for eight days to build an operating system. The behavioral audit found fewer false claims of finished work in Mythos 5.2. Anthropic writes that building evaluations that reliably catch every failure before deployment "remains unsolved" | Self-reported. The page does not say how the operating system was checked or what oversight the run had |
| [Interesting Engineering on Fable 5.2](https://interestingengineering.com/ai-robotics/anthropic-claude-fable-5-2-operating-system) | The same operating system result, reported independently of Anthropic | Secondary |
| [METR time horizons](https://metr.org/time-horizons/), [The Decoder on METR and Mythos](https://the-decoder.com/metr-says-it-can-barely-measure-claude-mythos-palo-alto-networks-warns-of-autonomous-ai-attackers/) | A 50% time horizon of at least 16 hours for an early Claude Mythos Preview (95% CI 8.5 to 55 hours) | METR says measurements above 16 hours are unreliable with its current task suite, and its page is no longer updated. No 80% figure for this model was found in a primary source |
| [Claude docs: Outcomes in Managed Agents](https://platform.claude.com/docs/en/managed-agents/define-outcomes) | A grader in a separate context window scores the finished artifact against a rubric, and the agent revises until it passes or runs out of iterations | Beta. Grades the finished artifact, not the run. This is the closest existing Anthropic feature. Position against it |
| [Anthropic: harness design for long-running apps](https://anthropic.com/engineering/harness-design-long-running-apps) | "Agents reliably skew positive when grading their own work", and a separate evaluator tuned to be skeptical | |
| [VentureBeat, October](https://venturebeat.com/orchestration/the-share-of-enterprises-trusting-ai-agents-to-make-production-changes-on-their-own-has-fallen-from-75-to-56-vb-intelligence-finds) | Among respondents at organizations that deploy autonomous agents, the share that allow or plan to allow production changes on automated evaluation alone fell from 75% in July 2026 to 56% in August 2026 | Self-selected survey of VentureBeat readers. The August wave had 140 respondents |

## C. Evidence for the design

| Source | What it supports |
|---|---|
| [LLM Agents Can Easily Tamper With Their Own Traces](https://arxiv.org/abs/2609.30266) (Qin et al., September 2026) | Local agents, Claude Code among them, can delete their own traces, and frontier models tampered with traces under reward pressure in a constructed setting. Recommends an independent recorder, an append-only log, and failing closed. Why the ledger and its writer sit outside the worker |
| [Stress Testing Chain-of-Thought Monitoring Against Covert Misalignment](https://neurips.cc/virtual/2026/poster/155256) (NeurIPS 2026) | Bayesian trajectory monitoring reaches 0.91 AUC (stated in the abstract). Adaptive attacks evaded reasoning monitors about 60% of the time, against a baseline AUC of about 0.26, as reported by [DiarioBitcoin](https://www.diariobitcoin.com/tecnologia/agentes-de-ia-burlaron-monitores-de-razonamiento-en-casi-6-de-cada-10-pruebas/) (secondary). Why the watcher scores stages and trajectories, and why it must be measured |
| [Anthropic: alignment assessment of cybersecurity incidents](https://anthropic.com/research/alignment-assessment-cybersecurity-incidents) (September 2026) | Live blocking monitors caught the harmful behaviors reliably, while an offline reasoning monitor missed one incident. Why the watcher acts during the run |
| [Safe to Resume?](https://arxiv.org/pdf/2608.29381) (Wu et al., August 2026) | Across 1,735 executions over five checkpoint and restore systems, incomplete coverage of internal state occurred in 67.2% of executions. A demonstrated attack on LangGraph turned one approval into two payments. Why restart is a fork, approvals do not carry over, and effects are registered |
| [Help Net Security on EU AI Act logging](https://www.helpnetsecurity.com/2026/04/16/eu-ai-act-logging-requirements/) | Article 12 requires automatic logs for high-risk systems but prescribes no format. The dates in this April article are out of date: see section E |
| [IETF draft: agent audit trail](https://datatracker.ietf.org/doc/draft-sharif-agent-audit-trail/) | A hash-chained audit format exists only as an individual draft with no formal standing. No format is final |
| [Tian Pan on earned autonomy](https://tianpan.co/blog/2026/04/17/earned-autonomy-ai-agents-progressive-supervision) | Promotion by thresholds set in advance, documented, with rollback triggers. Attention fade as a risk |

## D. What already exists

| Source | What it is |
|---|---|
| [Checkpoints by Entire, review](https://aicoolies.com/reviews/checkpoints-review) | Agent sessions in git with rewind and resume. No scoring against a goal |
| [Help Net Security on Drata](https://www.helpnetsecurity.com/2026/06/10/drata-ai-agent-governance/) | Fleet inventory, a policy for each agent checked on each action, drift from expected behavior flagged, tamper-evident record |
| [LangSmith online evaluations](https://docs.langchain.com/langsmith/online-evaluations-llm-as-judge), [Arize online evaluators](https://arize.com/docs/ax/concepts/evaluators/online-llm-as-judge) | A model judge scores production traces. Scores attach to traces and do not pause the running agent |
| [Asqav compliance receipts draft](https://datatracker.ietf.org/doc/html/draft-marques-asqav-compliance-receipts-07) | Signed receipts for each agent action, as an individual IETF draft |
| [Tracekit](https://arxiv.org/abs/2609.35659) | Open research system under the MIT licence: a signer the agent cannot reach decides each tool call (allow, deny or hold), signs a hash-chained record, exports bundles that verify offline, and compares what was asked with what ran. The closest design found. It does not score drift per stage against a charter, re-score history or restart with lineage |
| [Actae on durable execution](https://actae.dev/blog/durable-execution-ai-agents-compared/) | How Temporal, DBOS and LangGraph fork and resume |

Products found later, and what they do that Candor does not, are in D-081.

## E. Regulation named in `docs/PROPOSAL.md`

Candor does not make a job compliant. These are the record-keeping requirements the proposal points to.

| Source | What it requires |
|---|---|
| [45 CFR 164.312](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.312) | HIPAA Security Rule. Paragraph (b) requires audit controls that record and examine activity in systems that contain or use electronic protected health information |
| [21 CFR 11.10](https://www.ecfr.gov/current/title-21/chapter-I/subchapter-A/part-11/subpart-B/section-11.10) | FDA rules for electronic records. Paragraph (e) requires secure, computer-generated, time-stamped audit trails |
| [2 CFR 200.334](https://www.law.cornell.edu/cfr/text/2/200.334) | Recipients of federal awards must retain records, generally for three years |
| [EU AI Act Article 12](https://artificialintelligenceact.eu/article/12/) | High-risk AI systems must allow automatic recording of events over their lifetime |
| [Orrick on the Digital Omnibus](https://www.orrick.com/en/Insights/2026/07/EU-AI-Act-Update-Digital-Omnibus-Finalizes-8-Compliance-Changes) (July 2026) | The final Omnibus moved Annex III high-risk obligations from 2 August 2026 to 2 December 2027, and Annex I to 2 August 2028 |
