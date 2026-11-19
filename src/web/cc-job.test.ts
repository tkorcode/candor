import { describe, expect, it } from "vitest";
import { checkSignature } from "../core/report/sign.js";
import { HostedLedger } from "../hosted/ledger.js";
import { jobSigner } from "../hosted/sign.js";
import { type Box, createCcJob, finishCc, pollCc, startCc, takeLines, viewCc } from "./cc-job.js";

const RUN = "r_0123456789abcdef";

/** A ledger written the way the local product writes it, to stand for the one in the container. */
function containerLedger() {
  const ledger = HostedLedger.create(RUN, () => new Date("2026-11-19T20:00:00Z"));
  ledger.append({ type: "run_start", actor: "candord", body: { charter_hash: `sha256:${"a".repeat(64)}`, charter_version: 1 } });
  ledger.append({ type: "tool_intent", actor: "worker", body: { tool: "Bash", summary: "Bash: cd src", decision: "deny", reason: "The command cd src does not match allow_commands of the charter.", input_digest: `sha256:${"b".repeat(64)}` } });
  return ledger;
}

function fakeBox(lines: () => string[], extra: Partial<Record<string, unknown>> = {}): Box & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (path) => {
      calls.push(path);
      if (path === "/start") return { status: 200, body: { ok: true } };
      if (path.startsWith("/state")) {
        const after = Number(new URL(`http://x${path}`).searchParams.get("after") ?? 0);
        return { status: 200, body: { phase: "running", lines: lines().slice(after), blobs: {}, anchors: [], files: { "src/index.js": "export {};\n" }, daemon: { held: [], paused: false }, log: "", ...extra } };
      }
      return { status: 404, body: { error: "no" } };
    },
    destroy: async () => undefined,
  };
}

describe("a Claude Code job in the workspace", () => {
  it("copies each ledger entry out of the container after checking that it links up", async () => {
    const ledger = containerLedger();
    const job = createCcJob(RUN, {}, "claude-sonnet-5-5");
    const box = fakeBox(() => ledger.state.lines);
    await startCc(job, box);
    expect(box.calls[0]).toBe("/start");
    await pollCc(job, box);
    expect(job.lines).toHaveLength(2);
    ledger.append({ type: "run_end", actor: "candord", body: { reason: "worker finished" } });
    await pollCc(job, box);
    expect(job.lines).toHaveLength(3);
    expect(viewCc(job).entries.map((e) => e.type)).toEqual(["run_start", "tool_intent", "run_end"]);
  });

  it("refuses an entry that was changed, or one that does not follow the copy it keeps", () => {
    const ledger = containerLedger();
    const job = createCcJob(RUN, {}, "claude-sonnet-5-5");
    takeLines(job, ledger.state.lines.slice(0, 1));
    const forged = (ledger.state.lines[1] ?? "").replace("deny", "allow");
    expect(() => takeLines(job, [forged])).toThrow(/does not link/);
    expect(job.lines).toHaveLength(1);
    expect(() => takeLines(job, ledger.state.lines.slice(0, 1))).toThrow(/does not link/);
  });

  it("shows what waits for the reader: a held action first, then a pause", async () => {
    const ledger = containerLedger();
    const job = createCcJob(RUN, {}, "claude-sonnet-5-5");
    job.phase = "running";
    await pollCc(job, fakeBox(() => ledger.state.lines, { daemon: { held: [{ digest: "sha256:1", summary: "Bash: rm src/compat.js", tool: "Bash", approved: false }], paused: false } }));
    expect(job.status).toBe("held");
    expect(viewCc(job).pending?.summary).toBe("Bash: rm src/compat.js");
    await pollCc(job, fakeBox(() => ledger.state.lines, { daemon: { held: [], paused: true, pause_reason: "The watcher paused the run at A2." } }));
    expect(job.status).toBe("paused");
    expect(job.statusReason).toContain("A2");
  });

  it("signs the receipt with its own key, only when its head is in the copy it keeps", async () => {
    const ledger = containerLedger();
    const job = createCcJob(RUN, {}, "claude-sonnet-5-5");
    takeLines(job, ledger.state.lines);
    const head = ledger.head();
    const receiptBox = (h: string): Box => ({ fetch: async (p) => (p === "/receipt" ? { status: 200, body: { verdicts: {}, integrity: { head: h, head_seq: head.seq }, signature: { alg: "ed25519", value: "theirs" } } } : { status: 200, body: { lines: [] } }), destroy: async () => undefined });
    await expect(finishCc(job, receiptBox(`sha256:${"0".repeat(64)}`), await jobSigner())).rejects.toThrow(/not in the copy/);
    await finishCc(job, receiptBox(head.hash), await jobSigner());
    expect(job.status).toBe("done");
    expect(checkSignature(job.receipt as Record<string, unknown>).ok).toBe(true);
    expect((job.receipt as { signed_by: string }).signed_by).toMatch(/job object/);
  });
});
