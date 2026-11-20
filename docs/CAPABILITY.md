# Capability prediction: a model that supervises a multi-day agent job

**Prediction.** Within 12 months, a frontier model will dependably and independently supervise another agent through one job lasting hours or days. At each stage it will judge, from recorded evidence and against a goal approved in advance, whether the work is on course, well enough that people step in only to decide, not to watch. It is not a better worker but a reliable witness to the work of another.

## Why it is coming

1. **Jobs have outgrown human attention.** METR estimated a 50% time horizon of at least 16 hours for an early Claude Mythos Preview, the top of what its tasks can measure ([METR](https://metr.org/time-horizons/), [The Decoder](https://the-decoder.com/metr-says-it-can-barely-measure-claude-mythos-palo-alto-networks-warns-of-autonomous-ai-attackers/)). In internal testing, Claude Fable 5.2 coordinated more than 1,000 subagents for eight days to build an operating system ([Anthropic](https://www.anthropic.com/news/claude-fable-and-mythos-5-2), self-reported).
2. **A separate grader is already a product, at the end of a run.** Outcomes in Claude Managed Agents scores the finished artifact with a grader in a context window of its own ([docs](https://platform.claude.com/docs/en/managed-agents/define-outcomes), beta). Next is the same separation mid-run, stage by stage.
3. **Watching the trajectory works where reading the reasoning fails.** Adaptive attacks evaded chain-of-thought monitors in about six of ten trials, and a trajectory-level monitor raised detection from about 0.26 to 0.91 AUC ([NeurIPS 2026](https://neurips.cc/virtual/2026/poster/155256); figures via [DiarioBitcoin](https://www.diariobitcoin.com/tecnologia/agentes-de-ia-burlaron-monitores-de-razonamiento-en-casi-6-de-cada-10-pruebas/)). Reviewing incidents in its own evaluations, Anthropic found live blocking monitors reliable where an offline reasoning monitor missed one ([Anthropic](https://anthropic.com/research/alignment-assessment-cybersecurity-incidents)).
4. **The worker cannot be its own witness.** Local agents, Claude Code among them, can delete their own traces, and frontier models tampered with traces when that raised their reward ([Qin et al.](https://arxiv.org/abs/2609.30266)). Anthropic writes that "agents reliably skew positive when grading their own work" ([Anthropic](https://anthropic.com/engineering/harness-design-long-running-apps)), and that "the problem of building evaluations that reliably catch every failure before a model is deployed remains unsolved" ([Anthropic](https://www.anthropic.com/news/claude-fable-and-mythos-5-2)).
5. **Demand is shifting toward oversight.** Among organizations deploying agents, the share allowing or planning production changes on automated checks alone fell from 75% in July 2026 to 56% in August ([VentureBeat](https://venturebeat.com/orchestration/the-share-of-enterprises-trusting-ai-agents-to-make-production-changes-on-their-own-has-fallen-from-75-to-56-vb-intelligence-finds), self-selected survey).

## Characteristics and limitations

**Characteristics.** Independent: no shared context with the worker, no tools, never reads its reasoning. Anchored to a goal approved in advance. Scores separate dimensions (goal, scope, plan, evidence) and cites the evidence, never one reassuring number. Cheap enough for every stage, and measurable on seeded failures with known answers.

**Limitations.** It can share blind spots with a worker of the same family, so deterministic checks must not depend on it. Worker text can try to persuade it. Models increasingly recognize evaluations. It sees only what was recorded. Staying on course is not being right.

## Readiness

**Usable now** on bounded jobs beside deterministic checks, as Candor (`docs/PROPOSAL.md`) shows on real Claude Code jobs. **Expected within 12 months:** calibrated across domains so that people review only decisions. **Needs the platform:** provider-signed records of what the model did.
