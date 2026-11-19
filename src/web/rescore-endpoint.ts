import { fetchTransport, judge, type Transport, WatcherUnavailableError } from "../watcher/judge.js";
import { RUBRIC_HASH, RUBRIC_VERSION } from "../watcher/rubric.js";
import { type JudgeInput, judgeInputSchema } from "../watcher/schema.js";

/**
 * The live watcher behind the hosted console: `POST /api/rescore`.
 *
 * A reader of the console picks a checkpoint of a recorded run and writes a drift rule. This handler takes the
 * evidence bundle that the watcher stored with the first score of that checkpoint, adds the reader's rule beside
 * the charter's rules, and asks the real watcher again, with the same rubric and code as candord (R6, D-071).
 *
 * What the reader controls is only the run name, the checkpoint id, a dimension and a rule of at most 300
 * characters. The evidence comes from the files the console itself serves, never from the request, so a reader
 * cannot hand the watcher evidence of their own. The rule sits outside the data block, where the charter's rules
 * are, because the reader plays the operator here.
 *
 * Spending is bounded four ways: a budget for each call, a daily total and a per-address hourly count kept in a
 * key-value store, a cache so the same question is paid for once, and the spend limit of the API key itself.
 * The store is not atomic, so the daily total can overshoot by the calls in flight. The key's own limit is the
 * hard stop.
 */

export interface RescoreEnv {
  ANTHROPIC_API_KEY?: string;
  CANDOR_WATCHER_MODEL?: string;
  /** Total dollars per UTC day across all readers. Default 5. */
  CANDOR_DAILY_USD?: string;
  /** Model calls per reader address per hour. Default 30. Cached answers do not count. */
  CANDOR_CALLS_PER_HOUR?: string;
  /** Most one call may cost, in dollars. Default 0.15. */
  CANDOR_CALL_USD?: string;
}

/** The part of a key-value store this handler needs. Cloudflare KV has this shape. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface RescoreDeps {
  /** Fetches a file the console serves, by its path from the site root, such as /runs/<run>/ledger.jsonl. */
  fetchAsset: (path: string) => Promise<Response>;
  kv?: KvStore;
  /** Left out, the real Messages API is called with the key from the environment. */
  transport?: Transport;
  now?: () => Date;
}

const DIMENSIONS = ["goal", "scope", "plan", "evidence"] as const;
const RUN_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$/;
const CHECKPOINT_ID = /^[A-Z][0-9]{1,4}$/;
const READER_RULE_ID = "reader-1";

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const positive = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface LedgerLine {
  seq: number;
  type: string;
  branch?: string;
  body: Record<string, unknown>;
}

/** The stored score input of the first scored assessment of a checkpoint, and that score. */
async function storedJudgement(run: string, checkpoint: string, fetchAsset: RescoreDeps["fetchAsset"]): Promise<{ input: JudgeInput; score: LedgerLine } | { error: Response }> {
  const res = await fetchAsset(`/runs/${run}/ledger.jsonl`);
  if (!res.ok) return { error: json(404, { error: `No recorded run is named ${run}.` }) };
  const lines = (await res.text()).split("\n").filter((line) => line.length > 0);
  let score: LedgerLine | undefined;
  for (const line of lines) {
    const entry = JSON.parse(line) as LedgerLine;
    if (entry.type === "drift_score" && entry.body.checkpoint === checkpoint && entry.body.status === "scored") {
      score = entry;
      break;
    }
  }
  if (!score) {
    const known = lines.some((line) => {
      const e = JSON.parse(line) as LedgerLine;
      return e.type === "checkpoint" && e.body.id === checkpoint;
    });
    return {
      error: json(404, {
        error: known
          ? `Checkpoint ${checkpoint} was not scored when it was taken, so no evidence is stored for it and it cannot be scored again.`
          : `Run ${run} has no checkpoint ${checkpoint}.`,
      }),
    };
  }
  let text: string | null = null;
  const raw = score.body.bundle_json;
  if (typeof raw === "string") text = raw;
  else if (raw && typeof raw === "object" && typeof (raw as { $blob?: unknown }).$blob === "string") {
    const hex = (raw as { $blob: string }).$blob.replace(/^sha256:/, "");
    if (/^[0-9a-f]{64}$/.test(hex)) {
      const blob = await fetchAsset(`/runs/${run}/blobs/${hex}`);
      if (blob.ok) {
        text = await blob.text();
        // The blob store is content addressed. A file that does not match its name is not used.
        if ((await sha256Hex(text)) !== hex) text = null;
      }
    }
  }
  if (text === null) return { error: json(500, { error: `The stored evidence of checkpoint ${checkpoint} could not be read.` }) };
  const parsed = judgeInputSchema.safeParse(JSON.parse(text));
  if (!parsed.success) return { error: json(500, { error: `The stored evidence of checkpoint ${checkpoint} is not in the form the watcher takes.` }) };
  return { input: parsed.data, score };
}

/** The stored evidence, with the reader's rule added after the charter's rules. Everything else is unchanged. */
export function withReaderRule(stored: JudgeInput, rule: { dimension: (typeof DIMENSIONS)[number]; text: string }): JudgeInput {
  return { ...stored, charter: { ...stored.charter, drift_rules: [...stored.charter.drift_rules, { id: READER_RULE_ID, dimension: rule.dimension, text: rule.text }] } };
}

export async function handleRescore(request: Request, env: RescoreEnv, deps: RescoreDeps): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Use POST with a JSON body: { run, checkpoint, rule: { dimension, text } }." });
  const key = env.ANTHROPIC_API_KEY;
  const model = env.CANDOR_WATCHER_MODEL;
  if (!key || !model) return json(503, { error: "The live watcher is not configured on this site. The recorded scores are still shown." });
  if (!deps.kv) return json(503, { error: "The live watcher has no store for its spending limits, so it does not run." });

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 4096) return json(413, { error: "The request is too large." });
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json(400, { error: "The request body must be JSON: { run, checkpoint, rule: { dimension, text } }." });
  }
  const run = typeof body.run === "string" ? body.run : "";
  const checkpoint = typeof body.checkpoint === "string" ? body.checkpoint : "";
  const rule = (body.rule && typeof body.rule === "object" ? body.rule : {}) as Record<string, unknown>;
  const dimension = typeof rule.dimension === "string" ? rule.dimension : "";
  // Control characters are removed, so the rule stays one line of plain text in the prompt.
  const ruleText = [...(typeof rule.text === "string" ? rule.text : "")].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("").replace(/ {2,}/g, " ").trim();
  if (!RUN_ID.test(run) || run.includes("..")) return json(400, { error: "The run name is not valid." });
  if (!CHECKPOINT_ID.test(checkpoint)) return json(400, { error: "The checkpoint id is not valid. It looks like A3 or B2." });
  if (!(DIMENSIONS as readonly string[]).includes(dimension)) return json(400, { error: "The rule needs a dimension: goal, scope, plan or evidence." });
  if (ruleText.length < 5 || ruleText.length > 300) return json(400, { error: "The rule must be 5 to 300 characters, in words a person could apply." });

  const stored = await storedJudgement(run, checkpoint, deps.fetchAsset);
  if ("error" in stored) return stored.error;
  const input = withReaderRule(stored.input, { dimension: dimension as (typeof DIMENSIONS)[number], text: ruleText });
  const original = {
    seq: stored.score.seq,
    branch: stored.score.branch ?? "A",
    charter_version: stored.score.body.charter_version ?? null,
    dimensions: stored.score.body.dimensions ?? null,
    overall: stored.score.body.overall ?? null,
    level: stored.score.body.level ?? null,
    judge_model: stored.score.body.judge_model ?? null,
  };

  const kv = deps.kv;
  const cacheKey = `cache:${await sha256Hex(JSON.stringify([run, checkpoint, dimension, ruleText, RUBRIC_HASH, model]))}`;
  const cached = await kv.get(cacheKey);
  if (cached !== null) return json(200, { ...(JSON.parse(cached) as Record<string, unknown>), cached: true });

  const now = (deps.now ?? (() => new Date()))();
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13);
  const spendKey = `spend:${day}`;
  const spent = Number((await kv.get(spendKey)) ?? "0") || 0;
  const dailyUsd = positive(env.CANDOR_DAILY_USD, 5);
  if (spent >= dailyUsd) return json(429, { error: "The live watcher has used its budget for today. The recorded scores are still shown. Try again tomorrow (UTC), or run Candor yourself from the repository." });
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rateKey = `rate:${await sha256Hex(address)}:${hour}`;
  const calls = Number((await kv.get(rateKey)) ?? "0") || 0;
  if (calls >= positive(env.CANDOR_CALLS_PER_HOUR, 30)) return json(429, { error: "Too many live assessments from this address in the last hour. Try again later." });
  await kv.put(rateKey, String(calls + 1), { expirationTtl: 3700 });

  const callUsd = Math.min(positive(env.CANDOR_CALL_USD, 0.15), dailyUsd - spent);
  try {
    const result = await judge(input, { model, budgetUsd: callUsd, transport: deps.transport ?? fetchTransport(key), thresholds: input.charter.thresholds });
    await kv.put(spendKey, String(spent + result.usage.cost_usd), { expirationTtl: 172800 });
    const answer = {
      label: "live",
      note: "A live assessment made for this reader. It is not part of the signed record of the run.",
      run,
      checkpoint,
      reader_rule: { id: READER_RULE_ID, dimension, text: ruleText },
      original,
      dimensions: result.score.dimensions,
      overall: result.score.overall,
      level: result.score.level,
      findings: result.score.findings,
      dropped_findings: result.dropped_findings,
      thresholds: input.charter.thresholds,
      judge_model: result.score.judge_model,
      rubric_version: RUBRIC_VERSION,
      rubric_hash: result.rubric_hash,
      evidence_from_seq: stored.score.seq,
      usage: result.usage,
      judged_at: now.toISOString(),
    };
    await kv.put(cacheKey, JSON.stringify(answer), { expirationTtl: 604800 });
    return json(200, { ...answer, cached: false });
  } catch (error) {
    if (error instanceof WatcherUnavailableError) {
      if (error.spent) await kv.put(spendKey, String(spent + error.spent.cost_usd), { expirationTtl: 172800 });
      return json(502, { error: `The watcher did not return a score: ${error.message}`, reason: error.reason });
    }
    return json(502, { error: "The watcher could not be reached. The recorded scores are still shown." });
  }
}
