// The few names of Cloudflare's runtime module that @cloudflare/containers uses, for type checking outside Cloudflare.
declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    constructor(ctx: unknown, env: Env);
    protected ctx: unknown;
    protected env: Env;
  }
  export class WorkerEntrypoint<Env = unknown> {
    constructor(ctx: unknown, env: Env);
    protected ctx: unknown;
    protected env: Env;
  }
}
