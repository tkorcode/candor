import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiRequest } from "../watcher/judge.js";
import { seqsIn, stubTransport } from "../watcher/stub.js";
import { handleRescore, type KvStore, type RescoreEnv } from "./rescore-endpoint.js";

/** The recorded live restart run stands in for the files the console serves. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runFolder = join(root, "results", "runs", "2026-11-18-rule-change-and-restart", "receipt");
const RUN = "r_m4live";

const fetchAsset = async (path: string): Promise<Response> => {
  const prefix = `/runs/${RUN}/`;
  if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
  const file = join(runFolder, path.slice(prefix.length));
  return existsSync(file) ? new Response(readFileSync(file, "utf8")) : new Response("not found", { status: 404 });
};

class MemoryKv implements KvStore {
  data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
}

const env: RescoreEnv = { ANTHROPIC_API_KEY: "test-key-not-used", CANDOR_WATCHER_MODEL: "claude-opus-5-5" };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://console.example/api/rescore", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const ask = { run: RUN, checkpoint: "A1", rule: { dimension: "scope", text: "Do not change rows that are not duplicates." } };

describe("the live judge endpoint of the hosted console", () => {
  let kv: MemoryKv;
  let calls: ApiRequest[];
  const transport = stubTransport((request) => {
    calls.push(request);
    return { dimensions: { goal: 0.1, scope: 0.7, plan: 0.1, evidence: 0.1 }, findings: [{ rule: "reader-1", severity: "high", summary: "Rows outside the plan.", entries: [seqsIn(request).at(-1)] }] };
  });
  beforeEach(() => {
    kv = new MemoryKv();
    calls = [];
  });

  it("judges the stored evidence of the checkpoint again with the reader's rule, and labels the answer live", async () => {
    const res = await handleRescore(post(ask), env, { fetchAsset, kv, transport });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ label: "live", checkpoint: "A1", overall: 0.7, level: "pause", reader_rule: { id: "reader-1", dimension: "scope" }, cached: false });
    expect((body.original as Record<string, unknown>).level).toBe("ok");
    expect(body.findings).toEqual([expect.objectContaining({ rule: "reader-1" })]);

    // The request holds the reader's rule with the charter's rules, outside the data block, and no tools.
    const request = calls[0] as ApiRequest;
    expect(request).not.toHaveProperty("tools");
    const text = request.messages[0]?.content ?? "";
    const dataStart = text.indexOf("BEGIN-DATA-");
    expect(text.indexOf("reader-1 [scope] Do not change rows that are not duplicates.")).toBeGreaterThan(-1);
    expect(text.indexOf("reader-1 [scope]")).toBeLessThan(dataStart);
    // The evidence is exactly the stored bundle of the first score.
    const ledger = readFileSync(join(runFolder, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { seq: number; type: string; body: Record<string, unknown> });
    const first = ledger.find((e) => e.type === "drift_score" && e.body.checkpoint === "A1" && e.body.status === "scored");
    expect(body.evidence_from_seq).toBe(first?.seq);
  });

  it("answers the same question from its cache, without a second model call", async () => {
    await handleRescore(post(ask), env, { fetchAsset, kv, transport });
    const again = await handleRescore(post(ask), env, { fetchAsset, kv, transport });
    expect(((await again.json()) as Record<string, unknown>).cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("stops at the daily budget and at the hourly count per address, before any model call", async () => {
    await kv.put(`spend:${new Date().toISOString().slice(0, 10)}`, "5");
    const broke = await handleRescore(post(ask), env, { fetchAsset, kv, transport });
    expect(broke.status).toBe(429);
    expect(calls).toHaveLength(0);

    const fresh = new MemoryKv();
    const limited: RescoreEnv = { ...env, CANDOR_CALLS_PER_HOUR: "1" };
    const first = await handleRescore(post(ask, { "cf-connecting-ip": "203.0.113.9" }), limited, { fetchAsset, kv: fresh, transport });
    expect(first.status).toBe(200);
    const second = await handleRescore(post({ ...ask, rule: { dimension: "goal", text: "Serve the migration only." } }, { "cf-connecting-ip": "203.0.113.9" }), limited, { fetchAsset, kv: fresh, transport });
    expect(second.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it("adds what each call cost to the daily total", async () => {
    await handleRescore(post(ask), env, { fetchAsset, kv, transport });
    const spent = Number(await kv.get(`spend:${new Date().toISOString().slice(0, 10)}`));
    // 1000 input and 200 output tokens of the stand-in, at the price of the model.
    expect(spent).toBeCloseTo(0.008, 6);
  });

  it("refuses bad input with a clear reason, and makes no call", async () => {
    const cases: [unknown, number][] = [
      [{ ...ask, run: "../etc" }, 400],
      [{ ...ask, checkpoint: "A1; drop" }, 400],
      [{ ...ask, rule: { dimension: "mood", text: "A fine rule." } }, 400],
      [{ ...ask, rule: { dimension: "scope", text: "no" } }, 400],
      [{ ...ask, rule: { dimension: "scope", text: "x".repeat(301) } }, 400],
      [{ ...ask, run: "r_unknown" }, 404],
      [{ ...ask, checkpoint: "Z9" }, 404],
    ];
    for (const [body, status] of cases) {
      const res = await handleRescore(post(body), env, { fetchAsset, kv, transport });
      expect(res.status).toBe(status);
      expect(typeof ((await res.json()) as Record<string, unknown>).error).toBe("string");
    }
    expect((await handleRescore(new Request("https://console.example/api/rescore"), env, { fetchAsset, kv, transport })).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it("does not run without its key, its model or its store", async () => {
    expect((await handleRescore(post(ask), {}, { fetchAsset, kv, transport })).status).toBe(503);
    expect((await handleRescore(post(ask), { ANTHROPIC_API_KEY: "k" }, { fetchAsset, kv, transport })).status).toBe(503);
    expect((await handleRescore(post(ask), env, { fetchAsset, transport })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("reads a large stored bundle from the blob store, and refuses a blob whose content does not match its name", async () => {
    // A2 of this run keeps its bundle in the blob store. A1 keeps it inline.
    const fromBlob = await handleRescore(post({ ...ask, checkpoint: "A2" }), env, { fetchAsset, kv, transport });
    expect(fromBlob.status).toBe(200);
    expect(calls).toHaveLength(1);

    const tampered = async (path: string): Promise<Response> => (path.includes("/blobs/") ? new Response('{"charter":{}}') : fetchAsset(path));
    const res = await handleRescore(post({ ...ask, checkpoint: "B2" }), env, { fetchAsset: tampered, kv, transport });
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(1);
  });
});
