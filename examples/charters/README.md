# Example charters

Candor is one engine for any long job. Everything specific to a job is in its charter: the goal, the success criteria and the check behind each, the scope, the budget, the stages and what each is for, the drift rules, the warn and pause levels, and the actions held for a person. These charters show the same engine set up for very different work.

| Charter | The job | What is held for a person | How it drifts |
|---|---|---|---|
| `code-migration.yaml` | Move every service of a monorepo to a new HTTP client, with no change to the public API | Pushing the release | Editing tests or API snapshots so they pass; refactoring beyond the migration |
| `security-patch-rollout.yaml` | Upgrade a vulnerable library in every listed service, then deploy each one | Each deploy | Editing application code or configuration; making other upgrades |
| `screening-analysis.yaml` | Rank the compounds of a screening campaign by potency and publish the hits | Publishing to the assay registry | Dropping awkward data points without saying so; changing the endpoint or the fit after seeing results |
| `financial-reconciliation.yaml` | Reconcile the month with the bank statements and post supported adjustments | Posting the entries | Forcing a balance with an adjustment that has no source document |
| `../../demo/charter.yaml` | Migrate and deduplicate a customer table (the runnable demo) | Replacing the table | Repairing records that are not duplicates |

Each one passes `candor charter review` with nothing open: every success criterion has a check, every check has a planted fault it must fail on, every stage has an exit check and says what it is for, and the scope names what the job may change. `src/core/charter/examples.test.ts` keeps it so, and shows that the rule engine applies the scope, network setting and irreversible actions of each charter.

The check scripts and planted faults these charters name belong to the project the job runs in, and are not part of this repository. Only the demo charter comes with its project, from `node demo/make-project.mjs`.

## Writing a charter for your own job

1. Start from the example closest to your job, or draft one: `candor charter new --goal "<what must be true at the end>"`.
2. Write one check per success criterion, as a command that exits 0 when the criterion holds, and one fault command that breaks it in a disposable copy. Candor runs each check against its fault before the run, and a check that does not fail there is marked unproven.
3. Name the paths the job may change and the commands it may run. List the actions that cannot be undone, so they are held for a person.
4. Write the drift rules in plain words, one per dimension, as a person would apply them.
5. Run `candor charter review <file>`. Fix each item, or accept it with a reason that is kept in the record. Then `candor charter approve <file> --run <run id>`.
