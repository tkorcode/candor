import { realpathSync } from "node:fs";
import { join } from "node:path";
import { operatorKeyPath, receiptKeyPath } from "../paths.js";

/**
 * The settings that `candor run` gives every worker session (D-024, D-012). They are passed with
 * --settings, so they apply to a session Candor starts and to no other.
 *
 * Shell commands run in the sandbox with writes to the Candor home denied and the operator secret
 * unreadable, and a command cannot retry outside the sandbox. The sandbox covers shell commands only,
 * so permission deny rules cover the same paths for the file tools. Both are controls of Claude Code,
 * not of the operating system.
 */

export interface HookSpec {
  event: string;
  timeout: number;
  /** A hook that cannot start, crashes or times out blocks the call. Needs Claude Code v2.1.295 or later. */
  blockOnFailure: boolean;
}

/** The hook events Candor uses. plugin/hooks/hooks.json lists the same set, and a test keeps the two equal. */
export const HOOKS: readonly HookSpec[] = [
  { event: "SessionStart", timeout: 30, blockOnFailure: false },
  { event: "PreToolUse", timeout: 10, blockOnFailure: true },
  { event: "PostToolUse", timeout: 10, blockOnFailure: false },
  { event: "PostToolUseFailure", timeout: 10, blockOnFailure: false },
  { event: "SubagentStart", timeout: 10, blockOnFailure: false },
  { event: "SubagentStop", timeout: 10, blockOnFailure: false },
  { event: "PreCompact", timeout: 10, blockOnFailure: false },
  { event: "ConfigChange", timeout: 10, blockOnFailure: true },
  { event: "Stop", timeout: 10, blockOnFailure: false },
  { event: "SessionEnd", timeout: 5, blockOnFailure: false },
];

export interface WorkerSettingsOptions {
  home: string;
  /** The absolute path of bin/candor.js. */
  candorBin: string;
  /** Linux containers only: the weaker nested sandbox. The default is the real sandbox, and the run fails if it is not available. */
  weakNestedSandbox?: boolean;
  /** More paths the worker must not read, such as the answer key folder. */
  protectedReads?: string[];
  /** In a container with separate users (src/core/run/isolation.ts), the operating system keeps the worker away, so Claude Code's sandbox is off. The permission rules and hooks stay. */
  usersIsolation?: boolean;
}

/** In a permission rule an absolute path starts with a double slash. */
const rulePath = (absolute: string): string => `/${absolute}`;

export function buildWorkerSettings(options: WorkerSettingsOptions): Record<string, unknown> {
  const home = realpathSync(options.home);
  const key = join(home, "operator.key");
  if (key !== operatorKeyPath(home)) throw new Error("The operator key path is not where candor expects it.");
  const hooks: Record<string, unknown> = {};
  for (const spec of HOOKS) {
    hooks[spec.event] = [
      {
        hooks: [
          {
            type: "command",
            command: process.execPath,
            args: [options.candorBin, "hook", spec.event],
            timeout: spec.timeout,
            ...(spec.blockOnFailure ? { onFailure: "block" } : {}),
          },
        ],
      },
    ];
  }
  // The receipt signing key is kept from the worker for the same reason as the operator secret.
  const signingKey = receiptKeyPath(home);
  const extra = (options.protectedReads ?? []).map((path) => realpathSync(path));
  const fileTools = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
  return {
    sandbox: options.usersIsolation ? { enabled: false } : {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      ...(options.weakNestedSandbox ? { enableWeakerNestedSandbox: true } : {}),
      filesystem: { denyWrite: [home], denyRead: [key, signingKey, ...extra] },
    },
    permissions: {
      deny: [...fileTools.map((tool) => `${tool}(${rulePath(home)}/**)`), `Read(${rulePath(key)})`, `Read(${rulePath(signingKey)})`, ...extra.map((path) => `Read(${rulePath(path)}/**)`), `Edit(${rulePath(key)})`, `Edit(${rulePath(signingKey)})`],
    },
    hooks,
  };
}

export const WORKER_TOOLS = ["Bash", "Edit", "Write", "Read", "Glob", "Grep"] as const;
