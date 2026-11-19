import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { type Charter, CharterInvalid, parseCharter } from "./schema.js";

export function loadCharterFile(path: string): Charter {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`The charter file ${path} cannot be read. Check the path, or create a draft with: candor charter new --goal "<text>" --out ${path}`);
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new CharterInvalid([`The file is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`]);
  }
  return parseCharter(raw);
}

/** Writes a draft. It refuses to overwrite a file, so a draft never replaces work the operator did. */
export function writeCharterFile(path: string, charter: Charter): void {
  try {
    writeFileSync(path, stringify(charter, { lineWidth: 100 }), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${path} already exists. Choose another name with --out, or delete the file if you want a fresh draft.`);
    throw error;
  }
}
