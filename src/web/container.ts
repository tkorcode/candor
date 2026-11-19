import { Container, type OutboundHandlerContext } from "@cloudflare/containers";
import { forwardToApi, type GatewayEnv } from "./gateway.js";

/**
 * The container of a Claude Code job in the workspace (SPEC 4.5, container/Dockerfile). One container per job,
 * named by the job id, and destroyed when the job ends. It has no internet. Its only way out is the host
 * `anthropic.gateway`, which the handler below answers outside the container: it adds the API key and allows only
 * the Messages API, the models of the job and a number of calls per job. Every other host is refused at once.
 */
export class CandorContainer extends Container<GatewayEnv> {
  override defaultPort = 8080;
  override sleepAfter = "20m";
  override enableInternet = false;
}

// The handlers are assigned here, not declared as static fields: @cloudflare/containers registers them through a
// static setter, and a static field would define a property on this class instead, so the setter would never run,
// no handler would be registered, and every call out of the container would be refused with status 520.
CandorContainer.outboundByHost = {
  "anthropic.gateway": (request: Request, env: GatewayEnv, ctx: OutboundHandlerContext) => forwardToApi(request, env, new URL(request.url).pathname, `container:${ctx.containerId}`),
};
CandorContainer.outbound = async (request: Request, env: GatewayEnv) => {
  const host = new URL(request.url).hostname.slice(0, 100);
  await env.CANDOR_KV?.put(`egress:${host}`, new Date().toISOString(), { expirationTtl: 86400 }).catch(() => undefined);
  return new Response(`The container of a Candor job may not reach ${host}.`, { status: 403 });
};
