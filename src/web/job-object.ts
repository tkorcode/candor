import { jobSigner } from "../hosted/sign.js";
import type { HostConfig } from "../hosted/host.js";
import { actCc, type Box, type CcJob, createCcJob, downloadCc, finishCc, pollCc, RESTART_WINDOW_MS, startCc, viewCc } from "./cc-job.js";
import type { JobState } from "../hosted/job.js";
import { type JobStore, jobRoute, tick } from "./job-routes.js";

/**
 * One hosted job in a Cloudflare Durable Object (SPEC 4.5). The object holds the job state in its storage and
 * moves the job on with alarms, a few worker turns at a time, so no request has to stay open while the job
 * runs. A job that waits for a person for more than ten minutes is stopped.
 */

interface DurableState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(when: number): Promise<void>;
  };
}

/** The container of a Claude Code job, as a Durable Object stub of src/web/container.ts. */
export interface ContainerStub {
  fetch(request: Request): Promise<Response>;
  destroy(): Promise<void>;
}

export interface JobObjectEnv {
  ANTHROPIC_API_KEY?: string;
  CANDOR_WORKER_MODEL?: string;
  CANDOR_WATCHER_MODEL?: string;
  /** The worker model of a Claude Code job. */
  CANDOR_CLAUDE_CODE_MODEL?: string;
  CANDOR_CONTAINER?: { getByName(name: string): ContainerStub };
  CANDOR_KV?: { put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };
}

/** A Claude Code job gives up when the container cannot be reached this many times in a row. */
const MAX_ERRORS = 8;

const WAIT_LIMIT_MS = 10 * 60 * 1000;

export class CandorJob {
  constructor(
    private readonly state: DurableState,
    private readonly env: JobObjectEnv,
  ) {}

  private config(): HostConfig {
    return { ...(this.env.ANTHROPIC_API_KEY ? { apiKey: this.env.ANTHROPIC_API_KEY } : {}), ...(this.env.CANDOR_WORKER_MODEL ? { workerModel: this.env.CANDOR_WORKER_MODEL } : {}), ...(this.env.CANDOR_WATCHER_MODEL ? { watcherModel: this.env.CANDOR_WATCHER_MODEL } : {}) };
  }

  private store(): JobStore {
    const storage = this.state.storage;
    return {
      load: async () => (await storage.get<JobState>("job")) ?? null,
      save: async (job) => {
        await storage.put("job", job);
        await storage.put("touched", Date.now());
      },
      wake: async () => storage.setAlarm(Date.now() + 50),
    };
  }

  private box(job: CcJob): Box {
    const stub = this.env.CANDOR_CONTAINER?.getByName(job.id);
    if (!stub) throw new Error("Claude Code jobs are not set up on this copy of the site.");
    return {
      fetch: async (path, init) => {
        const res = await stub.fetch(new Request(`http://container${path}`, { method: init?.method ?? "GET", headers: { "content-type": "application/json", "x-candor-controller": job.token }, ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }));
        const text = await res.text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          body = { error: text.slice(0, 300) };
        }
        return { status: res.status, body };
      },
      destroy: () => stub.destroy(),
    };
  }

  private async ccRoute(request: Request, rest: string, id: string): Promise<Response | null> {
    const storage = this.state.storage;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (request.method === "POST" && rest === "/start") {
      const body = (await request.clone().json().catch(() => ({}))) as { worker?: string; input?: Record<string, unknown>; fault?: string };
      if (body.worker !== "claude-code") return null;
      if (!this.env.CANDOR_CONTAINER) return json(503, { error: "Claude Code jobs are not set up on this copy of the site." });
      if ((await storage.get("job")) || (await storage.get("cjob"))) return json(409, { error: "This job has already started." });
      const job = createCcJob(id, body.input ?? {}, this.env.CANDOR_CLAUDE_CODE_MODEL ?? "claude-sonnet-5-5", new Date(), body.fault);
      await storage.put("cjob", job);
      await storage.put("errors", 0);
      await storage.setAlarm(Date.now() + 50);
      return json(200, viewCc(job));
    }
    const job = await storage.get<CcJob>("cjob");
    if (!job) return null;
    if (request.method === "GET" && rest === "") return json(200, viewCc(job));
    if (request.method === "GET" && rest === "/download") return json(200, downloadCc(job));
    if (request.method === "POST" && rest === "/act") {
      const { action } = (await request.json().catch(() => ({}))) as { action?: Record<string, unknown> };
      if (!action || typeof action.kind !== "string") return json(400, { error: "The request names no action." });
      try {
        await actCc(job, this.box(job), action);
      } catch (error) {
        return json(400, { error: (error as Error).message });
      }
      await storage.put("cjob", job);
      await storage.put("touched", Date.now());
      await storage.setAlarm(Date.now() + 500);
      return json(200, viewCc(job));
    }
    return json(404, { error: "No such route." });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/job\/([a-z0-9_]+)(\/.*)?$/);
    if (!match) return new Response("Not found", { status: 404 });
    const cc = await this.ccRoute(request, match[2] ?? "", match[1] ?? "");
    if (cc) return cc;
    return jobRoute(request, match[1] ?? "", match[2] ?? "", this.store(), this.config());
  }

  /** Moves a Claude Code job on: starts the container, copies the ledger, and ends the job. */
  private async ccAlarm(job: CcJob): Promise<void> {
    const storage = this.state.storage;
    // After the restart window, the container of an ended job is destroyed.
    if (job.receipt && job.endedAt && !job.containerGone) {
      if (Date.now() - job.endedAt >= RESTART_WINDOW_MS) {
        await this.box(job).destroy().catch(() => undefined);
        job.containerGone = true;
        await storage.put("cjob", job);
      } else await storage.setAlarm(job.endedAt + RESTART_WINDOW_MS + 1000);
      return;
    }
    try {
      const box = this.box(job);
      if (job.phase === "starting") await startCc(job, box);
      else if (job.phase === "running") await pollCc(job, box, this.env.CANDOR_KV);
      if (job.phase === "ended" && !job.receipt) await finishCc(job, box, await jobSigner());
      if ((job.status === "held" || job.status === "paused") && Date.now() - ((await storage.get<number>("touched")) ?? Date.now()) > WAIT_LIMIT_MS) {
        await actCc(job, box, { kind: "stop" });
        job.statusReason = "The job waited for a decision for more than ten minutes and was stopped.";
      }
      await storage.put("errors", 0);
    } catch (error) {
      const errors = ((await storage.get<number>("errors")) ?? 0) + 1;
      await storage.put("errors", errors);
      // A container takes a while to start, so the first errors are only retried.
      if (errors >= MAX_ERRORS || /does not link/.test((error as Error).message)) {
        job.status = "failed";
        job.phase = "ended";
        job.statusReason = (error as Error).message;
      }
    }
    if (job.status !== "held" && job.status !== "paused") await storage.put("touched", Date.now());
    await storage.put("cjob", job);
    if (!job.receipt && job.status !== "failed") await storage.setAlarm(Date.now() + (job.phase === "starting" ? 5000 : 3000));
    else if (job.receipt && job.endedAt) await storage.setAlarm(job.endedAt + RESTART_WINDOW_MS + 1000);
  }

  async alarm(): Promise<void> {
    const cjob = await this.state.storage.get<CcJob>("cjob");
    if (cjob) return this.ccAlarm(cjob);
    const store = this.store();
    const job = await store.load();
    if (!job) return;
    if (job.status === "held" || job.status === "paused") {
      const touched = (await this.state.storage.get<number>("touched")) ?? Date.now();
      if (Date.now() - touched > WAIT_LIMIT_MS) {
        job.status = "stopped";
        job.statusReason = "The job waited for a decision for more than ten minutes and was stopped.";
        await this.state.storage.put("job", job);
      } else await this.state.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    if (await tick(store, this.config())) await this.state.storage.setAlarm(Date.now() + 50);
  }
}
