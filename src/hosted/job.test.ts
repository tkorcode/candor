import { describe, expect, it } from "vitest";
import { verifyLines } from "../core/ledger/verify.js";
import { checkSignature } from "../core/report/sign.js";
import { addRule, createJob, decideHeld, type JobDeps, type JobState, restartFrom, step } from "./job.js";
import { jobSigner } from "./sign.js";
import { scriptedWatcher } from "./watchers.js";
import { scriptedWorker } from "./workers.js";

const deps = async (): Promise<JobDeps> => ({ worker: scriptedWorker, watcher: scriptedWatcher, watcherModel: "scripted-watcher", watcherPrice: { input: 0, output: 0 }, sign: await jobSigner() });

async function runUntilStill(job: JobState, d: JobDeps, max = 40): Promise<void> {
  for (let i = 0; i < max && job.status === "running"; i += 1) await step(job, d);
}
const entries = (job: JobState) => job.ledger.lines.map((l) => JSON.parse(l));

describe("a hosted job with the scripted worker", () => {
  it("runs the migration, refuses the write to legacy/, warns, holds the deletion, and ends with a signed receipt", async () => {
    const d = await deps();
    const job = createJob("r_test1", {}, { mode: "scripted" });
    await runUntilStill(job, d);
    expect(job.status).toBe("held");
    const refused = entries(job).find((e) => e.type === "tool_intent" && e.body.decision === "deny");
    expect(refused?.body.summary).toBe("write_file legacy/monthly-report.js");
    const warn = entries(job).find((e) => e.type === "drift_score" && e.body.level === "warn");
    expect(warn?.body.checkpoint).toBe("A2");
    expect(entries(job).some((e) => e.type === "check_result" && e.body.check === "watcher_note")).toBe(true);
    await decideHeld(job, d, true);
    await runUntilStill(job, d);
    expect(job.status).toBe("done");
    expect(job.files["src/compat.js"]).toBeUndefined();
    const failed = entries(job).filter((e) => e.type === "check_result" && e.body.status === "failed");
    expect(failed.map((e) => e.body.check)).toEqual([]);
    const r = job.receipt as { verdicts: { result_verified: { verdict: string } }; criteria: { id: string; status: string }[] };
    expect(r.verdicts.result_verified.verdict).toBe("partly");
    expect(r.criteria.find((c) => c.id === "s6")?.status).toBe("not_verified");
    expect(checkSignature(r).ok).toBe(true);
  });

  it("writes a ledger that the verifier of the local product accepts", async () => {
    const d = await deps();
    const job = createJob("r_test2", {}, { mode: "scripted" });
    await runUntilStill(job, d);
    await decideHeld(job, d, true);
    await runUntilStill(job, d);
    const result = verifyLines(job.ledger.lines);
    expect(result).toMatchObject({ ok: true });
  });

  it("scores earlier checkpoints again when a rule is added, keeping both scores", async () => {
    const d = await deps();
    const job = createJob("r_test3", {}, { mode: "scripted" });
    await runUntilStill(job, d);
    await addRule(job, d, { dimension: "goal", text: "Never try to change legacy/, not even to keep it loading." });
    const rescores = entries(job).filter((e) => e.type === "rescore" && e.body.status === "scored");
    const a2 = rescores.find((e) => e.body.checkpoint === "A2");
    expect(a2?.body.first.overall).toBe(0.42);
    expect(a2?.body.overall).toBe(0.62);
    expect(job.charters.at(-1)?.version).toBe(2);
  });

  it("restarts from a checkpoint as a fork, with the reason as a rule, and the new branch leaves legacy/ alone", async () => {
    const d = await deps();
    const job = createJob("r_test4", {}, { mode: "scripted" });
    await runUntilStill(job, d);
    await restartFrom(job, d, "A1", "Do not try to change legacy/. Report that it no longer loads.");
    expect(job.branch).toBe("B");
    await runUntilStill(job, d);
    expect(job.status).toBe("held");
    await decideHeld(job, d, true);
    await runUntilStill(job, d);
    expect(job.status).toBe("done");
    const onB = entries(job).filter((e) => e.branch === "B");
    expect(onB.some((e) => e.type === "tool_intent" && e.body.decision === "deny")).toBe(false);
    expect(onB.filter((e) => e.type === "drift_score" && e.body.level === "warn")).toEqual([]);
    expect(entries(job).find((e) => e.type === "restart")?.body).toMatchObject({ from: "A1", to_branch: "B" });
    expect(job.files["legacy/monthly-report.js"]).toContain("require");
    expect(verifyLines(job.ledger.lines).ok).toBe(true);
  });

  it("pauses when the worker is told to cut a corner and changes a test", async () => {
    const d = await deps();
    const job = createJob("r_test5", {}, { mode: "scripted", seededFault: true });
    await runUntilStill(job, d);
    expect(entries(job).some((e) => e.type === "check_result" && e.body.check === "tests-unchanged" && e.body.status === "failed")).toBe(true);
    expect(job.status).toBe("paused");
  });
});

describe("a hosted job with the model worker", () => {
  // A stand-in for the Messages API that plays the scripted migration as tool_use blocks, and checks on every
  // request that the conversation is one the API accepts: each tool_use answered by a tool_result in the next turn.
  function fakeApi() {
    const problems: string[] = [];
    let turn = 0;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { messages: { role: string; content: unknown }[] };
      req.messages.forEach((m, i) => {
        if (m.role !== "assistant" || !Array.isArray(m.content)) return;
        const ids = (m.content as { type: string; id: string }[]).filter((b) => b.type === "tool_use").map((b) => b.id);
        const next = req.messages[i + 1];
        const answered = Array.isArray(next?.content) ? (next.content as { type: string; tool_use_id?: string }[]).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id) : [];
        for (const id of ids) if (!answered.includes(id)) problems.push(`turn ${turn}: tool_use ${id} has no tool_result in the next message`);
        if (next && next.role !== "user") problems.push(`turn ${turn}: an assistant turn is not followed by a user turn`);
      });
      const { script } = await import("./workers.js");
      const { buildCharter } = await import("./charter.js");
      const step = script(buildCharter({}), false)[turn] ?? { text: "", calls: [{ id: "end", name: "finish", input: { summary: "done" } }] };
      turn += 1;
      const content = [...(step.text ? [{ type: "text", text: step.text }] : []), ...step.calls.map((c) => ({ type: "tool_use", id: `${c.id}-t${turn}`, name: c.name, input: c.input }))];
      return new Response(JSON.stringify({ content, stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 200 } }));
    }) as unknown as typeof fetch;
    return { fetchImpl, problems };
  }

  it("keeps the conversation valid through a warn, a hold, a rule and a restart", async () => {
    const { modelWorker } = await import("./workers.js");
    const api = fakeApi();
    const d: JobDeps = { worker: modelWorker("test-key", "claude-haiku-5-5", api.fetchImpl), watcher: scriptedWatcher, watcherModel: "scripted-watcher", watcherPrice: { input: 0, output: 0 }, sign: await jobSigner() };
    const job = createJob("r_test6", {}, { mode: "live" });
    await runUntilStill(job, d);
    expect(job.status).toBe("held");
    await addRule(job, d, { dimension: "scope", text: "Never try to change legacy/." });
    await restartFrom(job, d, "A2", "Leave legacy/ as it is.");
    await runUntilStill(job, d);
    if (job.status === "held") await decideHeld(job, d, true);
    await runUntilStill(job, d);
    expect(api.problems).toEqual([]);
    expect(job.workerCost).toBeGreaterThan(0);
    expect(verifyLines(job.ledger.lines).ok).toBe(true);
  });
});
