import { handleRescore, type KvStore, type RescoreEnv } from "./rescore-endpoint.js";

/**
 * The Cloudflare Worker behind the hosted console (D-088). The console in `site/` is served as static assets.
 * One route runs code: POST /api/rescore, the live watcher, whose logic and limits are in `rescore-endpoint.ts`.
 * Everything else is a static file. The bindings and settings are in `wrangler.jsonc`, and the API key is a
 * secret set in the Cloudflare dashboard.
 */
export interface WorkerEnv extends RescoreEnv {
  CANDOR_KV?: KvStore;
  ASSETS: { fetch: (input: Request | string | URL) => Promise<Response> };
}

export const RESCORE_PATH = "/api/rescore";

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (new URL(request.url).pathname !== RESCORE_PATH) return env.ASSETS.fetch(request);
    return handleRescore(request, env, {
      fetchAsset: (path) => env.ASSETS.fetch(new URL(path, request.url)),
      ...(env.CANDOR_KV ? { kv: env.CANDOR_KV } : {}),
    });
  },
};
