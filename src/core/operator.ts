import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { operatorKeyPath } from "./paths.js";

/** Creates the operator secret on first use. Reading an existing one fails where a worker session cannot read it. */
export function ensureOperatorKey(home: string): string {
  const file = operatorKeyPath(home);
  if (!existsSync(file)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    chmodSync(home, 0o700);
  }
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new Error("The operator secret cannot be read here. Operator actions must run outside the worker session, in a terminal of your own.");
  }
}
