import { describe, expect, it } from "vitest";
import worker, { type WorkerEnv } from "./worker.js";

const TOKEN = "t".repeat(32);
const assets: WorkerEnv["ASSETS"] = { fetch: async () => new Response("static file") };

describe("the gate of a private trial deployment", () => {
  it("does nothing on the public deployment", async () => {
    const res = await worker.fetch(new Request("https://site.example/workspace.html"), { ASSETS: assets });
    expect(await res.text()).toBe("static file");
  });

  it("refuses everything on a trial deployment with no token set", async () => {
    const res = await worker.fetch(new Request("https://site.example/workspace.html"), { ASSETS: assets, CANDOR_TRIAL: "1" });
    expect(res.status).toBe(503);
  });

  it("asks for the token, and refuses the API without it", async () => {
    const env = { ASSETS: assets, CANDOR_TRIAL: "1", CANDOR_TRIAL_TOKEN: TOKEN };
    const pageRes = await worker.fetch(new Request("https://site.example/workspace.html"), env);
    expect(pageRes.status).toBe(401);
    expect(await pageRes.text()).toContain("Trial token");
    const api = await worker.fetch(new Request("https://site.example/api/job", { method: "POST" }), env);
    expect(api.status).toBe(401);
    const wrong = await worker.fetch(new Request("https://site.example/x", { headers: { "x-candor-trial-token": `${TOKEN}x` } }), env);
    expect(wrong.status).toBe(401);
  });

  it("lets the token through in the header, and sets a cookie from the form", async () => {
    const env = { ASSETS: assets, CANDOR_TRIAL: "1", CANDOR_TRIAL_TOKEN: TOKEN };
    const header = await worker.fetch(new Request("https://site.example/x", { headers: { "x-candor-trial-token": TOKEN } }), env);
    expect(await header.text()).toBe("static file");
    const form = await worker.fetch(new Request("https://site.example/trial", { method: "POST", body: new URLSearchParams({ token: TOKEN }) }), env);
    expect(form.status).toBe(303);
    const set = form.headers.get("set-cookie") ?? "";
    expect(set).toContain("HttpOnly");
    const withCookie = await worker.fetch(new Request("https://site.example/x", { headers: { cookie: set.split(";")[0] ?? "" } }), env);
    expect(await withCookie.text()).toBe("static file");
  });
});
