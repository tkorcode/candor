import { describe, expect, it } from "vitest";
import worker, { RESCORE_PATH, type WorkerEnv } from "./worker.js";

/** The Worker sends the live watcher route to its handler and every other request to the static files. */
describe("the Cloudflare Worker of the console", () => {
  const seen: string[] = [];
  const env: WorkerEnv = {
    ASSETS: {
      fetch: async (input) => {
        seen.push(new URL(input instanceof Request ? input.url : input).pathname);
        return new Response("static file");
      },
    },
  };

  it("serves every path other than the live watcher from the static files", async () => {
    const res = await worker.fetch(new Request("https://console.example/runs/r_m4live/ledger.jsonl"), env);
    expect(await res.text()).toBe("static file");
    expect(seen.at(-1)).toBe("/runs/r_m4live/ledger.jsonl");
  });

  it("sends the live watcher route to its handler, which refuses to run with no key or store", async () => {
    const count = seen.length;
    const res = await worker.fetch(new Request(`https://console.example${RESCORE_PATH}`, { method: "POST", body: "{}" }), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not configured") });
    expect(seen.length).toBe(count);
  });

  it("answers a GET on the live watcher route from the handler, not from the static files", async () => {
    const res = await worker.fetch(new Request(`https://console.example${RESCORE_PATH}`), env);
    expect(res.status).toBe(405);
  });
});
