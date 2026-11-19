// The run model: everything the console shows, derived from the ledger entries and the charter
// versions of one recorded run. No value is typed in. A screen reads this model, and the model reads
// only the raw files.

export const DIMENSIONS = ["goal", "scope", "plan", "evidence"];

const str = (v) => (typeof v === "string" ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The level a score reaches under a pair of thresholds. The overall value is the largest dimension. */
export function levelFor(overall, thresholds) {
  if (overall === null) return "not scored";
  if (overall >= thresholds.pause) return "pause";
  if (overall >= thresholds.warn) return "warn";
  return "ok";
}

export function buildModel({ entries, charters, receipt, meta, stageGuide = [] }) {
  const charterByVersion = new Map(charters.map((c) => [c.version, c]));
  const firstCharter = charters.find((c) => c.version === 1) ?? charters[0];
  const latestCharter = [...charters].sort((a, b) => b.version - a.version)[0];
  const thresholds = latestCharter?.thresholds ?? firstCharter?.thresholds ?? { warn: 0.35, pause: 0.6 };

  // Branches: A is the root. A restart entry, written on the new branch, names where it came from.
  const branches = new Map([["A", { id: "A", from: null, fromSeq: 0, reason: null, restartSeq: null, superseded: false }]]);
  const restarts = entries.filter((e) => e.type === "restart");
  for (const r of restarts) {
    const id = str(r.body.to_branch) ?? r.branch;
    branches.set(id, { id, from: str(r.body.from), fromBranch: str(r.body.from_branch), fromSeq: num(r.body.from_seq) ?? 0, reason: str(r.body.reason), instruction: str(r.body.instruction), restartSeq: r.seq, superseded: false });
    const old = branches.get(str(r.body.from_branch) ?? "A");
    if (old) old.superseded = true;
  }
  const activeBranch = restarts.length > 0 ? (str(restarts.at(-1).body.to_branch) ?? restarts.at(-1).branch) : "A";
  for (const b of branches.values()) if (b.id !== activeBranch) b.superseded = true;

  // Checkpoints, with their first score, every re-score, and what the stage reported and checked.
  const checkpoints = entries
    .filter((e) => e.type === "checkpoint")
    .map((e) => ({
      id: str(e.body.id),
      seq: e.seq,
      branch: e.branch ?? "A",
      parent: str(e.body.parent),
      stage: str(e.body.stage),
      trigger: str(e.body.trigger) ?? "unknown",
      safety: str(e.body.safety) ?? "unknown",
      changedPaths: Array.isArray(e.body.changed_paths) ? e.body.changed_paths : [],
      changedCount: num(e.body.changed_count) ?? 0,
      ts: e.ts,
      entry: e,
    }));
  const byId = new Map(checkpoints.map((c) => [c.id, c]));

  for (const cp of checkpoints) {
    const scores = entries.filter((e) => e.type === "drift_score" && e.body.checkpoint === cp.id);
    cp.first = scores.find((e) => e.body.status === "scored") ?? null;
    cp.firstRecord = scores[0] ?? null;
    cp.rescores = entries.filter((e) => e.type === "rescore" && e.body.checkpoint === cp.id);
    const lastRescore = [...cp.rescores].reverse().find((e) => e.body.status === "scored") ?? null;
    cp.latest = lastRescore ?? cp.first;
    // The exit checks of the stage, run by the daemon on the snapshot of this checkpoint. Notes and budget lines are not checks.
    cp.checks = entries.filter((e) => e.type === "check_result" && e.body.checkpoint === cp.id && typeof e.body.status === "string");
  }

  // Columns: a checkpoint sits one column right of its parent, so a branch starts beside its fork point.
  const column = new Map();
  const colOf = (cp) => {
    if (column.has(cp.id)) return column.get(cp.id);
    const parent = cp.parent ? byId.get(cp.parent) : null;
    const c = parent ? colOf(parent) + 1 : 0;
    column.set(cp.id, c);
    return c;
  };
  for (const cp of checkpoints) cp.column = colOf(cp);

  // The lineage of a branch: its own checkpoints, and those of its ancestors up to each fork point.
  const lineageOf = (branchId) => {
    const out = [];
    let b = branches.get(branchId);
    let limit = Number.POSITIVE_INFINITY;
    const seen = new Set();
    while (b && !seen.has(b.id)) {
      seen.add(b.id);
      out.unshift(...checkpoints.filter((c) => c.branch === b.id && c.seq <= limit));
      if (!b.from) break;
      const fork = byId.get(b.from);
      if (!fork) break;
      limit = fork.seq;
      b = branches.get(fork.branch);
    }
    return out;
  };

  // The entries between a checkpoint and the one before it on its lineage: what the stage did.
  const windowOf = (cp) => {
    const line = lineageOf(cp.branch);
    const index = line.findIndex((c) => c.id === cp.id);
    const before = index > 0 ? line[index - 1] : null;
    const from = before ? before.seq : 0;
    return entries.filter((e) => e.seq > from && e.seq < cp.seq && (e.branch ?? "A") === cp.branch);
  };

  // What a stage is for: from the charter of the run, or, for a run recorded before stages had descriptions,
  // from the current demo charter, marked as such.
  const stageOf = (id) => {
    const own = (firstCharter?.stages ?? []).find((s) => s.id === id) ?? null;
    if (!own || own.description) return own;
    const guide = stageGuide.find((s) => s.id === id);
    return guide?.description ? { ...own, description: guide.description, descriptionFromGuide: true } : own;
  };
  const reportFor = (cp) => [...windowOf(cp)].reverse().find((e) => e.type === "stage_report" && e.body.accepted === true) ?? null;

  const ruleChanges = entries.filter((e) => e.type === "rule_change");
  const held = entries.filter((e) => e.type === "tool_intent" && e.body.decision === "hold");
  const approvals = entries.filter((e) => e.type === "human_action" && e.actor === "operator" && e.body.action === "approve" && e.body.accepted === true);
  const refused = entries.filter((e) => e.type === "human_action" && e.actor === "worker" && e.body.accepted === false);
  const effects = entries.filter((e) => e.type === "effect");
  const sessions = entries.filter((e) => e.type === "session_start");
  const usage = entries.filter((e) => e.type === "check_result" && e.body.check === "budget" && e.body.event === "usage");
  const judged = entries.filter((e) => (e.type === "drift_score" || e.type === "rescore") && e.body.status === "scored");
  const models = {
    worker: [...new Set(usage.map((e) => str(e.body.model)).filter(Boolean))],
    watcher: [...new Set(judged.map((e) => str(e.body.judge_model)).filter(Boolean))],
  };
  const cost = {
    worker: usage.reduce((s, e) => s + (num(e.body.cost_usd) ?? 0), 0),
    watcher: judged.reduce((s, e) => s + (num(e.body.usage?.cost_usd) ?? 0), 0),
    watcherCalls: judged.length,
    watcherTokens: judged.reduce((s, e) => s + (num(e.body.usage?.input_tokens) ?? 0) + (num(e.body.usage?.output_tokens) ?? 0), 0),
  };

  return {
    meta,
    entries,
    receipt,
    charters,
    charterByVersion,
    latestCharter,
    firstCharter,
    thresholds,
    branches,
    activeBranch,
    checkpoints,
    byId,
    lineageOf,
    windowOf,
    stageOf,
    reportFor,
    restarts,
    ruleChanges,
    held,
    approvals,
    refused,
    effects,
    sessions,
    models,
    cost,
  };
}

/** The overall drift of a checkpoint, latest reading first (a re-score if there is one), or null. */
export const latestOverall = (cp) => num(cp.latest?.body.overall);

/**
 * The suggested restart point (D-080). On the lineage of the active branch, find the first checkpoint whose latest
 * score reaches warn. The suggestion is the latest checkpoint before it that was scored below warn and is safe to
 * restart from. With no checkpoint at warn there is nothing to correct, and with no scored checkpoint there is no
 * basis, and the answer says which.
 */
export function suggestRestart(model, thresholds) {
  const line = model.lineageOf(model.activeBranch);
  const judgedLine = line.filter((c) => latestOverall(c) !== null);
  if (judgedLine.length === 0) return { kind: "no_basis", text: "No checkpoint on this branch was scored, so there is no drift to suggest a restart from." };
  const firstFlag = line.findIndex((c) => {
    const o = latestOverall(c);
    return o !== null && o >= thresholds.warn;
  });
  if (firstFlag < 0) return { kind: "on_course", text: "No checkpoint on this branch reached the warn level. There is nothing to restart from." };
  const flagged = line[firstFlag];
  for (let i = firstFlag - 1; i >= 0; i -= 1) {
    const c = line[i];
    const o = latestOverall(c);
    if (o !== null && o < thresholds.warn && c.safety === "safe_to_restart") {
      return { kind: "suggested", checkpoint: c, flagged, text: `Drift first reached ${levelFor(latestOverall(flagged), thresholds)} at ${flagged.id}. The last checkpoint before it that was scored on course and can be restarted from is ${c.id}.` };
    }
  }
  return { kind: "none_safe", flagged, text: `Drift first reached ${levelFor(latestOverall(flagged), thresholds)} at ${flagged.id}, and no checkpoint before it was scored on course and can be restarted from.` };
}

/** One entry in plain words, for the ledger view. */
export function describe(entry) {
  const b = entry.body ?? {};
  const s = (v) => (typeof v === "string" ? v : "");
  switch (entry.type) {
    case "charter_approved":
      return `The charter ${s(b.charter_id)} version ${b.version} was approved. Its hash is the first entry of the record.`;
    case "charter_review":
      return `The charter review was recorded, with ${Array.isArray(b.items) ? b.items.length : 0} items and how each was resolved.`;
    case "run_start":
      return b.hosted ? `The job started in the workspace, ${b.mode === "live" ? "with a Claude model and file tools" : "scripted"}. Nothing in it runs the code of the project.` : "The run started. The check scripts and the workspace were captured before the worker began.";
    case "session_start":
      return `A worker session started${b.model ? ` on ${s(b.model)}` : ""}${b.claude_code_version ? `, Claude Code ${s(b.claude_code_version)}` : ""}.`;
    case "tool_intent":
      return `${b.decision === "allow" ? "Allowed" : b.decision === "hold" ? "Held for the operator" : "Denied"}: ${s(b.summary) || s(b.tool)}${b.rule ? ` (rule: ${s(b.rule)})` : ""}.`;
    case "tool_result":
      return `${s(b.tool) || "A tool"} ${b.failed ? "failed" : "finished"}${b.output_excerpt ? `: ${s(b.output_excerpt).slice(0, 140)}` : "."}`;
    case "stage_report":
      return b.accepted === false ? `A stage report was refused: ${s(b.reason)}` : `The worker reported stage ${s(b.stage)} ${b.done ? "done" : "not done"}${b.summary ? `: ${s(b.summary).slice(0, 160)}` : "."}`;
    case "checkpoint":
      return `Checkpoint ${s(b.id)} taken (${s(b.trigger).replaceAll("_", " ")}), ${s(b.safety).replaceAll("_", " ")}. The head hash was anchored.`;
    case "check_result":
      if (b.check === "budget") return b.event === "usage" ? `Spend reported: ${b.cost_usd} dollars, ${b.turns} turns.` : "A stretch of work started.";
      if (b.check === "watcher_note") return "A watcher warning was delivered to the worker.";
      return `Check ${s(b.check)}${b.stage ? ` (stage ${s(b.stage)})` : ""}: ${s(b.status) || (b.ok === false ? "failed" : "ok")}${b.reason ? `. ${s(b.reason).slice(0, 140)}` : "."}`;
    case "drift_score":
      return b.status === "scored" ? `The watcher scored ${s(b.checkpoint)}: drift ${b.overall}, level ${s(b.level)}.` : `Checkpoint ${s(b.checkpoint)} was not scored: ${s(b.message) || s(b.reason)}`;
    case "rescore":
      return b.status === "scored" ? `${s(b.checkpoint)} scored again under charter version ${b.charter_version}: drift ${b.overall}, level ${s(b.level)}. The first score is kept.` : `${s(b.checkpoint)} was not scored again: ${s(b.message) || s(b.reason)}`;
    case "rule_change":
      return `Rule ${s(b.rule?.id)} added (${s(b.rule?.dimension)}): ${s(b.rule?.text)} Charter version ${b.from_version} to ${b.version}.`;
    case "restart":
      return `Restart from ${s(b.from)} onto branch ${s(b.to_branch)}. Reason: ${s(b.reason)}`;
    case "human_action":
      return entry.actor === "operator" ? `The operator chose ${s(b.action)}${b.accepted ? "" : " (refused)"}${b.summary ? `: ${s(b.summary)}` : ""}.` : `An operator action (${s(b.action)}) arrived without the secret and was refused.`;
    case "effect":
      return `${b.irreversible ? "Irreversible effect" : "Effect"}: ${s(b.summary)}${b.performed ? ", performed" : ""}${b.blocked ? ", blocked" : ""}.`;
    case "acceptance_result":
      return `Acceptance on the final state, ${s(b.criterion)}: ${s(b.status)}.`;
    case "check_strength":
      return `Check ${s(b.check)} is ${s(b.status)} against its planted fault.`;
    case "anchor":
      return `The head hash at entry ${b.anchored_seq ?? ""} was copied outside the run folder.`;
    case "heartbeat":
      return b.recovered ? "The daemon came back after a gap." : "The daemon started.";
    case "hook_event":
      return `Hook event: ${s(b.event)}.`;
    case "run_end":
      return "The run ended. The acceptance checks ran on the final state.";
    case "config_change":
      return `A settings change from ${s(b.source)} was ${b.blocked ? "blocked" : "allowed"}.`;
    default:
      return entry.type;
  }
}
