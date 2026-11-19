// A stand-in for the `cloudflare:workers` module, which exists only inside Cloudflare's runtime, so the tests can
// load code that imports @cloudflare/containers. Nothing here runs a container.
export class DurableObject {
  constructor(
    readonly ctx: unknown,
    readonly env: unknown,
  ) {}
}
export class WorkerEntrypoint {
  constructor(
    readonly ctx: unknown,
    readonly env: unknown,
  ) {}
}
