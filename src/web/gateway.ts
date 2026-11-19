/**
 * The gateway to the Messages API for a Claude Code job container (SPEC 4.5). The container never holds the API key.
 * Claude Code and the watcher inside it call a local gateway with no key, which forwards to a host the Worker
 * intercepts, and this function adds the key outside the container. It allows only POST /v1/messages and
 * count_tokens, only the models of the job, and a number of calls per job.
 */

export interface GatewayEnv {
  ANTHROPIC_API_KEY?: string;
  CANDOR_KV?: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>; list?(options: { prefix: string }): Promise<{ keys: { name: string }[] }> };
}

export const GATEWAY_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"];
/** Calls one job may make through the gateway, the worker and the watcher together. */
export const CALLS_PER_JOB = 600;

const error = (status: number, message: string) => new Response(JSON.stringify({ type: "error", error: { type: status === 429 ? "rate_limit_error" : "permission_error", message } }), { status, headers: { "content-type": "application/json" } });

export async function forwardToApi(request: Request, env: GatewayEnv, path: string, jobKey: string): Promise<Response> {
  if (request.method !== "POST" || !/^\/v1\/messages(\/count_tokens)?$/.test(path)) return error(403, "The gateway allows only the Messages API.");
  if (!env.ANTHROPIC_API_KEY) return error(503, "The gateway has no API key.");
  const text = await request.text();
  if (text.length > 4_000_000) return error(413, "The request is too large.");
  let model = "";
  try {
    model = String((JSON.parse(text) as { model?: unknown }).model ?? "");
  } catch {
    return error(400, "The request is not JSON.");
  }
  if (!GATEWAY_MODELS.some((m) => model === m || model.startsWith(`${m}-`) || model.startsWith(`${m}[`))) return error(403, `The model ${model.slice(0, 60)} is not allowed here.`);
  if (env.CANDOR_KV && !path.endsWith("count_tokens")) {
    const key = `gateway:${jobKey}`;
    const used = Number((await env.CANDOR_KV.get(key)) ?? "0");
    if (used >= CALLS_PER_JOB) return error(429, `This job has made its ${CALLS_PER_JOB} calls to the API.`);
    await env.CANDOR_KV.put(key, String(used + 1), { expirationTtl: 172800 });
  }
  const headers = new Headers();
  for (const name of ["content-type", "anthropic-version", "anthropic-beta", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-api-key", env.ANTHROPIC_API_KEY);
  const upstream = await fetch(`https://api.anthropic.com${path}`, { method: "POST", headers, body: text });
  return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
}
