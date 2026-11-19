import { existsSync } from "node:fs";
import { approveCharterFile, reviewCharterFile } from "../core/charter/approve.js";
import { draftCharter } from "../core/charter/draft.js";
import { writeCharterFile } from "../core/charter/file.js";
import { ensureOperatorKey } from "../core/operator.js";

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** Every --accept id=reason pair. The reason may contain equals signs. */
function acceptances(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  args.forEach((arg, index) => {
    if (arg !== "--accept") return;
    const pair = args[index + 1] ?? "";
    const cut = pair.indexOf("=");
    if (cut <= 0) throw new Error('Use --accept <item id>="<reason>", for example --accept unchecked_criterion:s3="No check exists yet."');
    out[pair.slice(0, cut)] = pair.slice(cut + 1);
  });
  return out;
}

export const CHARTER_USAGE = `  candor charter new --goal "<text>" [--out <file>]
                                    Draft a charter. Default file: charter.yaml
  candor charter review <file> [--accept <item id>="<reason>"]...
                                    Challenge the draft. List what is vague, unchecked or unproven
  candor charter approve <file> [--run <id>]
                                    Write the charter hash as the first entry of a new run
`;

export function runCharter(home: string, args: string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "new": {
      const goal = option(rest, "--goal");
      if (!goal) {
        process.stderr.write('Usage: candor charter new --goal "<what the job must achieve>" [--out <file>]\n');
        return 2;
      }
      const out = option(rest, "--out") ?? "charter.yaml";
      writeCharterFile(out, draftCharter(goal));
      process.stdout.write(`Wrote a draft charter to ${out}.\nNext: edit it, then run: candor charter review ${out}\n`);
      return 0;
    }
    case "review": {
      const file = rest[0];
      if (!file || file.startsWith("--")) {
        process.stderr.write('Usage: candor charter review <file> [--accept <item id>="<reason>"]...\n');
        return 2;
      }
      if (!existsSync(file)) throw new Error(`The charter file ${file} does not exist. Create one with: candor charter new --goal "<text>"`);
      const { record, open } = reviewCharterFile(home, file, acceptances(rest));
      for (const item of record.items) {
        const state = item.resolution === null ? "OPEN    " : item.resolution.status === "fixed" ? "fixed   " : "accepted";
        process.stdout.write(`${state} ${item.id}\n         ${item.message}${item.resolution?.status === "accepted" ? `\n         Reason given: ${item.resolution.reason}` : ""}\n`);
      }
      if (record.items.length === 0) process.stdout.write("The review found nothing to challenge. That means the rules found nothing, not that the charter is right.\n");
      process.stdout.write(open.length === 0 ? `\nNo open items. Next: candor charter approve ${file}\n` : `\n${open.length} open item${open.length === 1 ? "" : "s"}. Fix the charter, or accept one with: candor charter review ${file} --accept <item id>="<reason>"\n`);
      return open.length === 0 ? 0 : 1;
    }
    case "approve": {
      const file = rest[0];
      if (!file || file.startsWith("--")) {
        process.stderr.write("Usage: candor charter approve <file> [--run <id>]\n");
        return 2;
      }
      // Approval is an operator action. It needs the operator secret, which a worker session cannot read (D-024).
      ensureOperatorKey(home);
      const approval = approveCharterFile(home, file, { run: option(rest, "--run") });
      process.stdout.write(`Approved. Run ${approval.run} starts with the charter hash ${approval.charterHash}.\nLedger: ${approval.ledger}\nCheck it with: candor verify ${approval.run}\n`);
      return 0;
    }
    default:
      process.stderr.write(`Usage:\n${CHARTER_USAGE}`);
      return 2;
  }
}
