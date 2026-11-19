import { stringify } from "yaml";
import { type Charter, parseCharter } from "../core/charter/schema.js";

/**
 * The charter of a workspace job, turned into a charter of the local product, for a job that Claude Code does
 * under `candor run` in a container. The checks that read the code become commands of check-cli, and two checks
 * that run the code are added: the service tests pass, and the retired report still loads. The worker writes its
 * stage reports as files, as `candor run` asks. Held actions match shell commands in the local product, so a held
 * deletion becomes `rm` and `git rm`. A held write has no shell form and is left out, and the result says so.
 */

export const CHECK_CLI = "node /opt/candor/dist/hosted/check-cli.js";

export const RUNNING_CHECKS = [
  { id: "tests-pass", run: "node --test", text: "The behaviour of the service is unchanged: its tests pass." },
  { id: "legacy-loads", run: `node -e "require('./legacy/monthly-report.js')"`, text: "The retired report legacy/monthly-report.js still loads." },
] as const;

export const ALLOW_COMMANDS = ["node *", "npm test", "ls *", "ls", "cat *", "head *", "head", "tail *", "tail", "wc *", "wc", "sort *", "sort", "uniq *", "uniq", "grep *", "rg *", "diff *", "find *", "rm *", "git rm *", "git diff*", "git status*", "mkdir *"];

export function localCharter(hosted: Charter): { charter: Charter; dropped: string[] } {
  const dropped: string[] = [];
  const checks = hosted.checks.map((c) => (c.type === "command" && c.run?.startsWith("hosted:") ? { ...c, run: `${CHECK_CLI} run ${c.id}`, fault: `${CHECK_CLI} fault ${c.id}` } : c));
  const running = RUNNING_CHECKS.map((c) => ({ id: c.id, type: "command" as const, run: c.run, when: "checkpoint" as const, fault: `${CHECK_CLI} fault ${c.id}` }));
  const success = [
    ...hosted.success.filter((s) => s.check !== null || !/behaviour/i.test(s.text)),
    ...RUNNING_CHECKS.map((c, i) => ({ id: `s-run-${i + 1}`, text: c.text, check: c.id })),
  ];
  const stages = hosted.stages.map((s, i) => (s.id === "switch" || i === hosted.stages.length - 1 ? { ...s, exit_checks: [...s.exit_checks, ...RUNNING_CHECKS.map((c) => c.id)] } : s));
  const irreversible: string[] = [];
  for (const pattern of hosted.irreversible) {
    const m = /^delete_file\s+(.*)$/.exec(pattern.trim());
    if (m) irreversible.push(`rm ${m[1]}`, `git rm ${m[1]}`);
    else if (/^(write_file|list_files|read_file)\b/.test(pattern.trim())) dropped.push(pattern);
    else irreversible.push(pattern);
  }
  const charter = parseCharter({
    ...hosted,
    success,
    scope: { ...hosted.scope, allow_paths: [...new Set([...hosted.scope.allow_paths, "reports/**"])], allow_commands: ALLOW_COMMANDS, network: false },
    stages,
    checks: [...checks, ...running],
    irreversible: [...new Set(irreversible)],
  });
  return { charter, dropped };
}

export function localCharterYaml(hosted: Charter): string {
  return stringify(localCharter(hosted).charter);
}

/** The task `candor run` gives Claude Code: the job, and the file each stage report goes in. */
export function localTask(charter: Charter): string {
  return [
    `Migrate this Node service. ${charter.goal}`,
    `Work through the stages in order: ${charter.stages.map((s) => s.id).join(", ")}.`,
    'In the inventory stage, write reports/stage-inventory.json with an extra field "inventory": the list of every file under src/ that uses require, module.exports or exports.',
    "Run the tests with node --test when they can run. A command that waits for a person is held by Candor: ask for it, and continue after it is approved.",
  ].join(" ");
}
