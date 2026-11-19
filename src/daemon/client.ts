import { request } from "node:http";

export interface DaemonResponse {
  status: number;
  body: Record<string, unknown>;
}

export class DaemonUnreachable extends Error {
  constructor(socket: string, cause: string) {
    super(`candord cannot be reached at ${socket} (${cause}). Start it with: candor daemon`);
    this.name = "DaemonUnreachable";
  }
}

/** One request to candord over its Unix socket. Rejects with DaemonUnreachable on a connection error or timeout. */
export function callDaemon(options: {
  socket: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(
      {
        socketPath: options.socket,
        // A new connection for every request. A reused connection can be closed by a restarted daemon between
        // two requests, and the next write then fails with EPIPE.
        agent: false,
        method: options.method,
        path: options.path,
        headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...options.headers },
        timeout: options.timeoutMs ?? 3000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
          } catch {
            reject(new DaemonUnreachable(options.socket, "the reply was not JSON"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (error) => reject(new DaemonUnreachable(options.socket, error.message)));
    if (payload) req.write(payload);
    req.end();
  });
}
