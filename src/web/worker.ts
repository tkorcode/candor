import type { HostConfig } from "../hosted/host.js";
import { CandorJob, type JobObjectEnv } from "./job-object.js";
import { charterRoute, json } from "./job-routes.js";
import { handleRescore, type KvStore, type RescoreEnv } from "./rescore-endpoint.js";
import { forwardToApi, type GatewayEnv } from "./gateway.js";
import { type TrialEnv, trialGate } from "./trial-gate.js";

/**
 * The Cloudflare Worker behind the hosted console (D-088) and the workspace (SPEC 4.5). Static files come from
 * `site/`. POST /api/rescore is the live watcher of the console. /api/charter/* drafts and reviews a charter.
 * /api/job/* goes to the Durable Object that holds that job. The bindings are in `wrangler.jsonc`, and the API
 * key is a secret set in the Cloudflare dashboard.
 */
export interface WorkerEnv extends RescoreEnv, JobObjectEnv, TrialEnv {
  CANDOR_KV?: KvStore;
  ASSETS: { fetch: (input: Request | string | URL) => Promise<Response> };
  CANDOR_JOBS?: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  /** New jobs per UTC day across all readers. Default 200. */
  CANDOR_JOBS_PER_DAY?: string;
}

export const RESCORE_PATH = "/api/rescore";
export { CandorJob };
export { CandorContainer } from "./container.js";
// Outbound interception of the container needs this export (@cloudflare/containers).
export { ContainerProxy } from "@cloudflare/containers";

const newId = () => `r_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

async function jobRequest(request: Request, env: WorkerEnv, path: string): Promise<Response> {
  if (!env.CANDOR_JOBS) return json(503, { error: "The workspace is not set up on this copy of the site." });
  let target = path;
  if (request.method === "POST" && path === "/api/job") {
    // A new job: one per reader address at a time, and a cap per day.
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (env.CANDOR_KV) {
      const day = new Date().toISOString().slice(0, 10);
      const count = Number((await env.CANDOR_KV.get(`jobs:${day}`)) ?? "0");
      if (count >= Number(env.CANDOR_JOBS_PER_DAY ?? "200")) return json(429, { error: "The workspace has started its jobs for today. Try again tomorrow (UTC)." });
      // A private trial is behind its token, so its runs of the same job are not limited per address.
      const running = env.CANDOR_TRIAL === "1" ? null : await env.CANDOR_KV.get(`job-ip:${ip}`);
      if (running) return json(429, { error: "You started a job less than three minutes ago. Use that one, or try again in a few minutes.", job: running });
      const id = newId();
      await env.CANDOR_KV.put(`jobs:${day}`, String(count + 1), { expirationTtl: 172800 });
      await env.CANDOR_KV.put(`job-ip:${ip}`, id, { expirationTtl: 180 });
      target = `/api/job/${id}/start`;
    } else target = `/api/job/${newId()}/start`;
  }
  const id = target.split("/")[3] ?? "";
  if (!/^r_[a-f0-9]{16}$/.test(id)) return json(404, { error: "That is not a job id." });
  const stub = env.CANDOR_JOBS.get(env.CANDOR_JOBS.idFromName(id));
  return stub.fetch(new Request(new URL(target, request.url), request));
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const closed = await trialGate(request, env);
    if (closed) return closed;
    const path = new URL(request.url).pathname;
    if (path === RESCORE_PATH) {
      return handleRescore(request, env, { fetchAsset: (p) => env.ASSETS.fetch(new URL(p, request.url)), ...(env.CANDOR_KV ? { kv: env.CANDOR_KV } : {}) });
    }
    if (path.startsWith("/api/charter/")) {
      const config: HostConfig = { ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}), ...(env.CANDOR_WATCHER_MODEL ? { watcherModel: env.CANDOR_WATCHER_MODEL } : {}) };
      return (await charterRoute(request, path, config)) ?? json(404, { error: "No such route." });
    }
    // Which workers this copy of the site can run, for the choice on the page.
    if (path === "/api/workers") return json(200, { claude_code: Boolean(env.CANDOR_CONTAINER && env.ANTHROPIC_API_KEY), live: Boolean(env.ANTHROPIC_API_KEY) });
    if (path === "/api/job" || path.startsWith("/api/job/")) return jobRequest(request, env, path);
    // On a private trial only, behind the trial token: the gateway, so a container on another machine can be tested.
    if (env.CANDOR_TRIAL === "1" && path.startsWith("/api/gateway/")) return forwardToApi(request, env, path.slice("/api/gateway".length), "trial");
    // On a private trial only: the hosts containers asked for and were refused.
    if (env.CANDOR_TRIAL === "1" && path === "/api/trial/egress") return json(200, { refused: (await (env.CANDOR_KV as GatewayEnv["CANDOR_KV"])?.list?.({ prefix: "egress:" }))?.keys.map((k) => k.name.slice(7)) ?? [] });
    return env.ASSETS.fetch(request);
  },
};
