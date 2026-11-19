// The controller of a Claude Code job container (SPEC 4.5). It runs as root, next to Candor, and the job object
// of the Worker is the only caller. It starts `candor run` on the sample project with the charter from the page,
// passes on the reader's decisions as operator actions, and hands out the ledger, the anchors and the files.
// It also serves a local gateway for the Messages API: Claude Code and the watcher call it with no key, and it
// forwards to a host that the Worker intercepts outside the container, where the key is added.
import { spawn } from "node:child_process";
import { chmodSync, chownSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { join, relative } from "node:path";
import { callDaemon } from "/opt/candor/dist/daemon/client.js";
import { anchorPath, ledgerPath, operatorKeyPath, socketPath } from "/opt/candor/dist/core/paths.js";

// Files Claude Code writes must stay writable by the worker's shell, who shares the project group, and the other way
// round, so both start with umask 002. Candor's own files in its home are made with explicit modes.
process.umask(0o002);
const HOME = process.env.CANDOR_HOME ?? "/var/candor";
const WORK = "/work/invoices";
const BIN = "/opt/candor/bin/candor.js";
const GATEWAY_PORT = 8099;
const UPSTREAM = "anthropic.gateway";
const WORKER = { uid: Number(process.env.CANDOR_WORKER_UID ?? 1002), gid: Number(process.env.CANDOR_WORKER_GID ?? 1003) };

const job = { run: null, phase: "idle", child: null, log: "", model: null, task: null, started: null, token: null, fault: null };
const say = (text) => {
  job.log = (job.log + text).slice(-20000);
};

function share(dir) {
  chownSync(dir, WORKER.uid, WORKER.gid);
  chmodSync(dir, 0o2775);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) share(full);
    else {
      chownSync(full, WORKER.uid, WORKER.gid);
      chmodSync(full, 0o664);
    }
  }
}

function runEnv() {
  return {
    ...process.env,
    ...(job.fault ? { CANDOR_SEEDED_FAULT: job.fault.name, CANDOR_SEEDED_INSTRUCTION: job.fault.instruction } : {}),
    CANDOR_HOME: HOME,
    // Claude Code and the watcher call the local gateway. The key is a placeholder, and the real one is added outside.
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
    ANTHROPIC_API_KEY: "candor-gateway",
    CANDOR_WATCHER_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
  };
}

function candor(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: runEnv(), stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** Starts a long `candor run` or `candor restart`, keeping its output in the log. */
function drive(args) {
  const child = spawn(process.execPath, [BIN, ...args], { env: runEnv(), stdio: ["ignore", "pipe", "pipe"] });
  job.child = child;
  job.phase = "running";
  child.stdout.on("data", (d) => say(String(d)));
  child.stderr.on("data", (d) => say(String(d)));
  child.on("close", (code, signal) => {
    say(`\n[candor ${args[0]} ended with exit ${code}${signal ? `, signal ${signal}` : ""}]\n`);
    if (job.child === child) {
      job.child = null;
      job.phase = "ended";
    }
  });
}

async function start(body) {
  if (job.phase !== "idle") throw new Error("This container has already started a job.");
  const run = String(body.run ?? "");
  if (!/^r_[a-f0-9]{16}$/.test(run)) throw new Error("The run id is not valid.");
  if (typeof body.token !== "string" || body.token.length < 32) throw new Error("The start call needs the token of the job object.");
  // The worker can reach this port from inside the container, so every later call must carry this token, which
  // only the job object and this root process hold.
  job.token = body.token;
  job.run = run;
  job.model = String(body.model ?? "claude-sonnet-5-5");
  job.task = String(body.task ?? "");
  job.fault = body.fault && typeof body.fault.name === "string" ? { name: String(body.fault.name).slice(0, 40), instruction: String(body.fault.instruction ?? "").slice(0, 400) } : null;
  job.phase = "starting";
  job.started = new Date().toISOString();
  mkdirSync(HOME, { recursive: true, mode: 0o711 });
  chmodSync(HOME, 0o711);
  mkdirSync(WORK, { recursive: true });
  cpSync("/opt/candor/sample", WORK, { recursive: true });
  share(WORK);
  writeFileSync(join(HOME, "charter.yaml"), String(body.charter ?? ""), { mode: 0o600 });
  // The reader saw Candor's review of this charter on the page and approved it, so its open items are accepted.
  const review = await candor(["charter", "review", join(HOME, "charter.yaml")]);
  const open = [...review.out.matchAll(/^OPEN\s+(\S+)/gm)].map((m) => m[1]);
  if (open.length) {
    const accepted = await candor(["charter", "review", join(HOME, "charter.yaml"), ...open.flatMap((id) => ["--accept", `${id}=Accepted by the reader, who saw this item in the workspace before approving.`])]);
    say(accepted.out);
  }
  const approved = await candor(["charter", "approve", join(HOME, "charter.yaml"), "--run", run]);
  say(approved.out);
  if (approved.code !== 0) {
    job.phase = "ended";
    throw new Error(`The charter was not approved: ${approved.out.slice(0, 400)}`);
  }
  drive(["run", run, "--workspace", WORK, "--task", job.task, "--model", job.model, "--max-usd", String(Number(body.maxUsd ?? 2)), "--wait-approval", "10"]);
}

async function daemon(method, path, body) {
  const key = readFileSync(operatorKeyPath(HOME), "utf8").trim();
  return callDaemon({ socket: socketPath(HOME), method, path, ...(body ? { body } : {}), headers: { "x-candor-operator": key }, timeoutMs: 300000 });
}

async function act(body) {
  const kind = String(body.kind ?? "");
  if (kind === "approve") {
    const state = (await daemon("GET", "/state")).body;
    const held = (state.held ?? []).find((h) => !h.approved);
    if (!held) throw new Error("Nothing is waiting for approval.");
    return (await daemon("POST", "/operator/approve", { digest: held.digest, minutes: 30 })).body;
  }
  if (kind === "continue") return (await daemon("POST", "/operator/continue", {})).body;
  if (kind === "rule") return (await daemon("POST", "/operator/rule", { text: String(body.text ?? ""), dimension: String(body.dimension ?? "scope"), continue: true })).body;
  if (kind === "stop" || kind === "deny") {
    const reason = kind === "deny" ? "The reader denied the held action and stopped the job." : "The reader stopped the job.";
    await daemon("POST", "/harness/end", { reason }).catch(() => null);
    job.child?.kill("SIGINT");
    return { stopped: true };
  }
  if (kind === "restart") {
    const from = String(body.from ?? "");
    if (!/^[A-Z][0-9]{1,3}$/.test(from)) throw new Error("The checkpoint id is not valid.");
    if (job.child) {
      job.child.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 1500));
    }
    drive(["restart", from, "--run", job.run, "--reason", String(body.reason ?? "Restarted by the reader."), "--model", job.model, "--wait-approval", "10"]);
    return { restarted: from };
  }
  throw new Error(`Unknown action ${kind}.`);
}

function readFiles(root) {
  const out = {};
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) visit(full);
      else if (info.size < 100_000) out[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

function workspaceNow() {
  // After a restart, the newest branch has its own worktree next to the first one.
  const siblings = existsSync("/work") ? readdirSync("/work").filter((n) => n.startsWith(`invoices.${job.run}.`)).sort() : [];
  return siblings.length ? join("/work", siblings.at(-1)) : WORK;
}

async function state(after) {
  const lines = job.run && existsSync(ledgerPath(HOME, job.run)) ? readFileSync(ledgerPath(HOME, job.run), "utf8").split("\n").filter(Boolean) : [];
  const fresh = lines.slice(after);
  const blobs = {};
  for (const line of fresh) for (const m of line.matchAll(/"sha256:([a-f0-9]{64})"/g)) {
    // The ledger keeps long values as blobs beside it, one file per hash.
    const file = join(ledgerPath(HOME, job.run), "..", "blobs", m[1]);
    if (existsSync(file)) blobs[m[1]] = readFileSync(file, "utf8");
  }
  const anchorFile = job.run ? anchorPath(HOME, job.run) : "";
  const anchors = anchorFile && existsSync(anchorFile) ? readFileSync(anchorFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a.run === job.run) : [];
  let daemonState = null;
  if (job.phase === "running") daemonState = await daemon("GET", "/state").then((r) => r.body, () => null);
  return { phase: job.phase, run: job.run, lines: fresh, total: lines.length, blobs, anchors, files: readFiles(workspaceNow()), daemon: daemonState, log: job.log.slice(-4000) };
}

async function receipt() {
  const out = join(HOME, "out");
  const made = await candor(["receipt", job.run, "--out", out, "--label", "live"]);
  if (made.code !== 0) throw new Error(`The receipt was not made: ${made.out.slice(0, 400)}`);
  return JSON.parse(readFileSync(join(out, "receipt.json"), "utf8"));
}

const readBody = (req) => new Promise((resolve) => {
  let text = "";
  req.on("data", (d) => (text += d)).on("end", () => resolve(text));
});
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://controller");
  if (url.pathname !== "/start" && url.pathname !== "/health" && (job.token === null || req.headers["x-candor-controller"] !== job.token)) return send(res, 401, { error: "This call needs the token of the job object." });
  try {
    if (req.method === "POST" && url.pathname === "/start") {
      await start(JSON.parse((await readBody(req)) || "{}"));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/act") return send(res, 200, await act(JSON.parse((await readBody(req)) || "{}")));
    if (req.method === "GET" && url.pathname === "/state") return send(res, 200, await state(Number(url.searchParams.get("after") ?? 0)));
    if (req.method === "GET" && url.pathname === "/receipt") return send(res, 200, await receipt());
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, phase: job.phase });
    send(res, 404, { error: "No such route." });
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(8080, "0.0.0.0");

// The local gateway: only POST /v1/messages and counting tokens, with any key header removed. Outside the container,
// the Worker adds the real key and enforces the limits of the job.
createServer(async (req, res) => {
  const allowed = req.method === "POST" && /^\/v1\/messages(\/count_tokens)?(\?.*)?$/.test(req.url ?? "");
  if (!allowed) return send(res, 403, { type: "error", error: { type: "permission_error", message: "The gateway allows only the Messages API." } });
  const headers = { ...req.headers, host: UPSTREAM };
  delete headers["x-api-key"];
  delete headers.authorization;
  const sent = Date.now();
  const upstream = httpRequest({ host: process.env.CANDOR_GATEWAY_HOST ?? UPSTREAM, port: Number(process.env.CANDOR_GATEWAY_PORT ?? 80), path: req.url, method: "POST", headers }, (up) => {
    if ((up.statusCode ?? 0) >= 400) say(`[gateway] ${String(req.url).split("?")[0]} answered ${up.statusCode} after ${Date.now() - sent} ms\n`);
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", (error) => say(`[gateway] could not reach the API: ${error.message}\n`) || send(res, 502, { type: "error", error: { type: "api_error", message: `The gateway could not reach the API: ${error.message}` } }));
  req.pipe(upstream);
}).listen(GATEWAY_PORT, "127.0.0.1");
