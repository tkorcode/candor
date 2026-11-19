import { describe, expect, it } from "vitest";
import { verifyLines } from "../core/ledger/verify.js";
import { CandorJob } from "./job-object.js";
import worker, { type WorkerEnv } from "./worker.js";

/**
 * The workspace through the Worker and the real Durable Object class, with an in-memory stand-in for the
 * storage and the alarms of Cloudflare. No API key, so the job runs with the scripted worker and watcher.
 */
function fakeNamespace() {
  const objects = new Map<string, { obj: CandorJob; alarm: number | null }>();
  const make = (name: string) => {
    const data = new Map<string, unknown>();
    const slot: { obj: CandorJob; alarm: number | null } = { obj: undefined as unknown as CandorJob, alarm: null };
    const storage = {
      get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
      put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
      setAlarm: async (when: number) => {
        slot.alarm = when;
      },
    };
    slot.obj = new CandorJob({ storage }, {});
    objects.set(name, slot);
    return slot;
  };
  return {
    ns: { idFromName: (name: string) => name, get: (id: unknown) => ({ fetch: (r: Request) => (objects.get(String(id)) ?? make(String(id))).obj.fetch(r) }) },
    /** Runs the alarms of every object until none is set. */
    async drain(max = 80) {
      for (let i = 0; i < max; i += 1) {
        const due = [...objects.values()].filter((s) => s.alarm !== null);
        if (!due.length) return;
        for (const s of due) {
          s.alarm = null;
          await s.obj.alarm();
        }
      }
    },
    objects,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: the test reads JSON answers of the routes.
type Json = Record<string, any>;

describe("the workspace through the Worker", () => {
  it("drafts a charter, starts a job, holds the deletion, takes an approval, and ends with a receipt", async () => {
    const fake = fakeNamespace();
    const env: WorkerEnv = { ASSETS: { fetch: async () => new Response("static") }, CANDOR_JOBS: fake.ns };
    const call = async (path: string, body?: unknown) => (await worker.fetch(new Request(`https://w.example${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), env)).json() as Promise<Json>;

    const drafted = await call("/api/charter/draft", { goal: "Move the invoices service to ES modules." });
    expect(drafted.drafted_by).toBe("defaults");
    expect(drafted.charter.stages.length).toBe(5);

    const started = await call("/api/job", { input: drafted.input });
    expect(started.id).toMatch(/^r_[a-f0-9]{16}$/);
    expect(started.mode).toBe("scripted");
    await fake.drain();
    const held = await call(`/api/job/${started.id}`);
    expect(held.status).toBe("held");
    expect(held.pending).toMatchObject({ tool: "delete_file", path: "src/compat.js" });

    await call(`/api/job/${started.id}/act`, { action: { kind: "approve" } });
    await fake.drain();
    const done = await call(`/api/job/${started.id}`);
    expect(done.status).toBe("done");
    expect(done.receipt.signature.alg).toBe("ed25519");
    const bundle = await call(`/api/job/${started.id}/download`);
    expect(verifyLines(String(bundle["ledger.jsonl"]).split("\n").filter(Boolean)).ok).toBe(true);
  });

  it("refuses a path that is not a job id", async () => {
    const fake = fakeNamespace();
    const env: WorkerEnv = { ASSETS: { fetch: async () => new Response("static") }, CANDOR_JOBS: fake.ns };
    const res = await worker.fetch(new Request("https://w.example/api/job/not-a-job-id"), env);
    expect(res.status).toBe(404);
  });
});
