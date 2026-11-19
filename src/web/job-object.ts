import type { HostConfig } from "../hosted/host.js";
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

export interface JobObjectEnv {
  ANTHROPIC_API_KEY?: string;
  CANDOR_WORKER_MODEL?: string;
  CANDOR_WATCHER_MODEL?: string;
}

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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/job\/([a-z0-9_]+)(\/.*)?$/);
    if (!match) return new Response("Not found", { status: 404 });
    return jobRoute(request, match[1] ?? "", match[2] ?? "", this.store(), this.config());
  }

  async alarm(): Promise<void> {
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
