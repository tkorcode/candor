import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Charter } from "../charter/schema.js";
import { type Check, makeCopy, type Outcome, removeCopy, runShell, scanPattern } from "./run.js";

/**
 * The check strength test. Before a run, each check is run in a disposable copy of the workspace with
 * a known fault planted, and it must fail there. It is also run on a control copy with no fault, and it
 * must pass there, so a check that fails on everything is not called proven. A check with no fault, one
 * that passes on its fault, one that breaks, and one that also fails on the control are all unproven.
 */

export interface Strength {
  check: string;
  status: "proven" | "unproven";
  reason: string;
  fault: "command" | "built-in" | "none";
  control_exit: number | null;
  fault_exit: number | null;
}

const SAMPLES: Record<string, string> = { email: "fault.person@example.org", ssn: "123-45-6789", phone: "555-123-4567" };

/** Where a built-in fault for a pattern check goes: a file the check covers. */
function faultFile(check: Check): string | null {
  const pattern = check.paths?.[0];
  if (!pattern) return null;
  const name = pattern.replace(/\/\*\*$/, "/candor-fault.txt").replace(/\*\*/g, "candor-fault").replace(/\*/g, "candor-fault");
  return name.includes(".") && !name.endsWith("/") ? name : `${name.replace(/\/$/, "")}.txt`;
}

async function strengthOfCommand(check: Check, workspace: string, pristine: string | null, timeoutMs: number, extra: Record<string, string>): Promise<Strength> {
  const result = (status: Strength["status"], reason: string, controlExit: number | null, faultExit: number | null): Strength => ({
    check: check.id,
    status,
    reason,
    fault: "command",
    control_exit: controlExit,
    fault_exit: faultExit,
  });
  const faultCommand = check.fault as string;
  const control = makeCopy(workspace, pristine);
  let controlExit: number | null = null;
  try {
    const planted = await runShell(faultCommand, control, { ...extra, CANDOR_FAULT_MODE: "control" }, timeoutMs);
    if (planted.exitCode !== 0) return result("unproven", `The fault command did not run cleanly in control mode (exit ${planted.exitCode ?? "none"}). ${planted.output.split("\n")[0] ?? ""}`.trim(), null, null);
    const run = await runShell(check.run ?? "false", control, extra, timeoutMs);
    controlExit = run.exitCode;
    if (run.exitCode !== 0) return result("unproven", `The check does not pass on a copy with no fault (exit ${run.exitCode ?? "none"}), so a failure on the fault shows nothing.`, controlExit, null);
  } finally {
    removeCopy(control);
  }
  const faulty = makeCopy(workspace, pristine);
  try {
    const planted = await runShell(faultCommand, faulty, { ...extra, CANDOR_FAULT_MODE: "plant" }, timeoutMs);
    if (planted.exitCode !== 0) return result("unproven", `The fault command did not run cleanly (exit ${planted.exitCode ?? "none"}). ${planted.output.split("\n")[0] ?? ""}`.trim(), controlExit, null);
    const run = await runShell(check.run ?? "false", faulty, extra, timeoutMs);
    if (run.exitCode === 1) return result("proven", "The check passes with no fault and fails on its planted fault.", controlExit, 1);
    if (run.exitCode === 0) return result("unproven", "The check PASSES on its planted fault, so it cannot catch that fault.", controlExit, 0);
    return result("unproven", `The check broke on its fault (exit ${run.exitCode ?? "none"}) instead of failing cleanly. Exit code 1 means the check failed.`, controlExit, run.exitCode);
  } finally {
    removeCopy(faulty);
  }
}

function strengthOfPattern(check: Check, workspace: string): Strength {
  const base = { check: check.id, fault: "built-in" as const, control_exit: null as number | null, fault_exit: null as number | null };
  const sample = check.deny ? SAMPLES[check.deny] : undefined;
  const file = faultFile(check);
  if (!sample || !file) return { ...base, status: "unproven", reason: "The check has no planted fault, and no built-in fault exists for its pattern. Give it a fault command.", fault: "none" };
  const copy = makeCopy(workspace, null);
  try {
    const clean = scanPattern(copy, check);
    base.control_exit = clean.exitCode;
    if (clean.status !== "passed") return { ...base, status: "unproven", reason: "The check already fails on a copy with no fault." };
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    writeFileSync(join(copy, file), `Contact: ${sample}\n`);
    const faulty = scanPattern(copy, check);
    base.fault_exit = faulty.exitCode;
    return faulty.status === "failed" ? { ...base, status: "proven", reason: `The check finds a planted ${check.deny} value in ${file} and passes without it.` } : { ...base, status: "unproven", reason: "The check does not find a planted value." };
  } finally {
    removeCopy(copy);
  }
}

export async function strengthTest(charter: Charter, workspace: string, pristineChecks: string | null, timeoutMs = 60000, env: Record<string, string> = {}): Promise<Strength[]> {
  const out: Strength[] = [];
  for (const check of charter.checks) {
    if (check.type === "pattern") {
      out.push(strengthOfPattern(check, workspace));
    } else if (!check.fault) {
      out.push({ check: check.id, status: "unproven", reason: "The check has no planted fault, so nothing shows that it can fail.", fault: "none", control_exit: null, fault_exit: null });
    } else out.push(await strengthOfCommand(check, workspace, pristineChecks, timeoutMs, env));
  }
  return out;
}

export type { Outcome };
