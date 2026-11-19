#!/usr/bin/env node
// Serves site/ on http://localhost:8787 to preview the console and the workspace. The workspace routes run the
// hosted job from dist/ (run `npm run build` first) with the scripted worker and watcher, unless
// ANTHROPIC_API_KEY is set. The live watcher of the console needs the hosted site.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../site", import.meta.url)));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jsonl": "text/plain; charset=utf-8" };
const port = Number(process.env.PORT ?? 8787);
const built = existsSync(fileURLToPath(new URL("../dist/web/job-routes.js", import.meta.url)));
const routes = built ? await import("../dist/web/job-routes.js") : null;
const config = process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {};
const jobs = new Map();

function storeFor(id) {
  return {
    load: async () => (jobs.has(id) ? structuredClone(jobs.get(id)) : null),
    save: async (job) => void jobs.set(id, structuredClone(job)),
    // On a laptop a timer stands in for the alarm of the Durable Object.
    wake: async () => {
      const run = async () => {
        if (await routes.tick(storeFor(id), config)) setTimeout(run, 250);
      };
      setTimeout(run, 250);
    },
  };
}

async function api(req, res, path) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
  let response = await routes.charterRoute(request, path, config);
  if (!response && (path === "/api/job" || path.startsWith("/api/job/"))) {
    const id = path === "/api/job" ? `r_${Math.random().toString(16).slice(2, 10).padEnd(16, "0")}` : path.split("/")[3];
    const rest = path === "/api/job" ? "/start" : path.slice(`/api/job/${id}`.length);
    response = await routes.jobRoute(request, id, rest, storeFor(id), config);
  }
  response ??= new Response(JSON.stringify({ error: "No such route." }), { status: 404 });
  res.writeHead(response.status, { "content-type": "application/json" }).end(await response.text());
}

createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/"));
  if (path.startsWith("/api/")) {
    if (!routes) return res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "Run npm run build first." }));
    return void api(req, res, path).catch((e) => res.writeHead(500).end(String(e)));
  }
  const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Candor Console at http://localhost:${port}, workspace at http://localhost:${port}/workspace.html${built ? "" : " (run npm run build for the workspace)"}`));
