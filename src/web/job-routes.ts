import type { CharterInput } from "../hosted/charter.js";
import { type Action, act, advance, download, draft, type HostConfig, review, start, view } from "../hosted/host.js";
import type { JobState } from "../hosted/job.js";

/**
 * The HTTP routes of the hosted job, for any host that can store one job state: the Durable Object in
 * production (job-object.ts) and the local server in scripts/. The page talks only to these routes.
 */

export const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export interface JobStore {
  load(): Promise<JobState | null>;
  save(job: JobState): Promise<void>;
  /** Asks the host to keep the job moving: an alarm in the Durable Object, a timer on a laptop. */
  wake(): Promise<void>;
}

const MAX_BODY = 20_000;
async function body<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("The request is too large.");
  return (text ? JSON.parse(text) : {}) as T;
}

/** Routes that need no job: drafting and reviewing a charter. */
export async function charterRoute(request: Request, path: string, config: HostConfig): Promise<Response | null> {
  try {
    if (request.method === "POST" && path === "/api/charter/draft") {
      const { goal, worker, plain } = await body<{ goal?: string; worker?: string; plain?: boolean }>(request);
      if (typeof goal !== "string" || goal.trim().length < 5) return json(400, { error: "Describe what the job should do, in a sentence." });
      return json(200, await draft(goal, config, { worker, plain: plain === true }));
    }
    if (request.method === "POST" && path === "/api/charter/review") {
      const { input, worker } = await body<{ input?: CharterInput; worker?: string }>(request);
      return json(200, review(input ?? {}, worker));
    }
  } catch (error) {
    return json(400, { error: (error as Error).message });
  }
  return null;
}

/** Routes on one job. `rest` is the path after /api/job/<id>. */
export async function jobRoute(request: Request, id: string, rest: string, store: JobStore, config: HostConfig): Promise<Response> {
  try {
    if (request.method === "POST" && rest === "/start") {
      if (await store.load()) return json(409, { error: "This job has already started." });
      const { input, live, seededFault, fault } = await body<{ input?: CharterInput; live?: boolean; seededFault?: boolean; fault?: string }>(request);
      const job = start(id, input ?? {}, config, { live: live !== false, seededFault: seededFault === true, fault });
      await store.save(job);
      await store.wake();
      return json(200, view(job));
    }
    const job = await store.load();
    if (!job) return json(404, { error: "There is no job with this id. Jobs are kept for a day." });
    if (request.method === "GET" && rest === "") return json(200, view(job));
    if (request.method === "GET" && rest === "/download") return json(200, download(job));
    if (request.method === "POST" && rest === "/act") {
      const { action } = await body<{ action?: Action }>(request);
      if (!action || typeof action.kind !== "string") return json(400, { error: "The request names no action." });
      await act(job, config, action);
      await store.save(job);
      await store.wake();
      return json(200, view(job));
    }
    return json(404, { error: "No such route." });
  } catch (error) {
    return json(400, { error: (error as Error).message });
  }
}

/** One slice of work: a few worker turns, then save. The host calls it again while the job runs. */
export async function tick(store: JobStore, config: HostConfig): Promise<boolean> {
  const job = await store.load();
  if (job?.status !== "running") return false;
  await advance(job, config);
  await store.save(job);
  return job.status === "running";
}
