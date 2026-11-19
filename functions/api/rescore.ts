/**
 * Cloudflare Pages Function for POST /api/rescore. It only maps the platform's context onto the handler in
 * src/web/rescore-endpoint.ts, which holds all the logic and is tested there.
 *
 * Settings for the Pages project (dashboard, Settings):
 * - Compatibility flag `nodejs_compat`, because the watcher code uses node:crypto.
 * - Secret `ANTHROPIC_API_KEY`: a key made only for this site, with a spend limit in the Anthropic Console.
 * - Variable `CANDOR_WATCHER_MODEL`, and optionally `CANDOR_DAILY_USD`, `CANDOR_CALLS_PER_HOUR`, `CANDOR_CALL_USD`.
 * - KV namespace binding `CANDOR_KV`, for the spending limits and the cache.
 */
import { handleRescore, type KvStore, type RescoreEnv } from "../../src/web/rescore-endpoint.js";

interface PagesContext {
  request: Request;
  env: RescoreEnv & { CANDOR_KV?: KvStore; ASSETS: { fetch: (input: Request | string | URL) => Promise<Response> } };
}

export const onRequest = (context: PagesContext): Promise<Response> =>
  handleRescore(context.request, context.env, {
    fetchAsset: (path) => context.env.ASSETS.fetch(new URL(path, context.request.url)),
    ...(context.env.CANDOR_KV ? { kv: context.env.CANDOR_KV } : {}),
  });
