// Candor Console. Loads one recorded run, verifies it in the browser, and draws the run map and five views:
// the checkpoint, the drift calculator, the rules, the ledger, and the receipt. Every value comes from the
// run files. Worker text is shown as text only.

import { canonicalJson } from "./canonical.js";
import { clear, download, fmt, h, levelChip, money, s } from "./dom.js";
import { legendItems, renderMap } from "./map.js";
import { buildModel, DIMENSIONS, describe, latestOverall, levelFor, suggestRestart } from "./model.js";
import { verifyAnchors, verifyBlobs, verifyChain, verifyReceiptHead, verifyReceiptSignature } from "./verify.js";

const state = {
  runs: [],
  run: null,
  lines: [],
  anchors: [],
  model: null,
  thresholds: { warn: 0.35, pause: 0.6 },
  selected: null,
  tab: "checkpoint",
  cited: new Set(),
  integrity: null,
  filters: { branch: "all", actor: "all", type: "all", text: "", routine: true },
  open: new Set(),
};
const $ = (id) => document.getElementById(id);
const fetchText = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.text();
};
const ROUTINE = (e) => e.type === "anchor" || e.type === "heartbeat" || e.type === "hook_event" || (e.type === "check_result" && e.body.check === "budget");

// ---- loading ---------------------------------------------------------------------------------------

async function start() {
  try {
    state.runs = JSON.parse(await fetchText("runs/index.json"));
  } catch {
    $("run-line").textContent = "No recorded runs were found. Run node scripts/site-data.mjs to copy them from results/.";
    return;
  }
  const select = $("run-select");
  for (const r of state.runs) select.append(h("option", { value: r.id }, `${r.id}: ${r.title}`));
  select.addEventListener("change", () => {
    location.hash = select.value;
  });
  window.addEventListener("hashchange", () => openRun(location.hash.slice(1)));
  for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener("click", () => showTab(tab.id.replace("tab-", "")));
  $("tabs").addEventListener("keydown", (e) => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      showTab(next.id.replace("tab-", ""));
      next.focus();
    }
  });
  for (const id of ["warn", "pause"]) {
    $(id).addEventListener("input", () => {
      state.thresholds = { warn: Number($("warn").value), pause: Math.max(Number($("pause").value), Number($("warn").value)) };
      drawMap();
      drawView();
    });
  }
  $("reset-thresholds").addEventListener("click", () => {
    state.thresholds = { ...state.model.thresholds };
    syncSliders();
    drawMap();
    drawView();
  });
  await openRun(location.hash.slice(1) || state.runs[0]?.id);
}

async function openRun(id) {
  const meta = state.runs.find((r) => r.id === id) ?? state.runs[0];
  if (!meta) return;
  $("run-select").value = meta.id;
  const base = `runs/${meta.id}`;
  const [ledgerText, anchorsText, receiptText, chartersText, guideText] = await Promise.all([fetchText(`${base}/ledger.jsonl`), fetchText(`${base}/anchors.jsonl`), fetchText(`${base}/receipt.json`), fetchText(`${base}/charters.json`), fetchText("runs/stage-guide.json").catch(() => "[]")]);
  state.run = meta;
  state.lines = ledgerText.split("\n").filter(Boolean);
  state.anchors = anchorsText.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const entries = state.lines.map((l) => JSON.parse(l));
  state.model = buildModel({ entries, charters: JSON.parse(chartersText), receipt: JSON.parse(receiptText), meta, stageGuide: JSON.parse(guideText) });
  state.thresholds = { ...state.model.thresholds };
  syncSliders();
  const suggestion = suggestRestart(state.model, state.thresholds);
  state.selected = suggestion.flagged?.id ?? state.model.lineageOf(state.model.activeBranch).at(-1)?.id ?? null;
  state.cited = new Set();
  state.open = new Set();
  drawHeader();
  drawVerdicts();
  drawMap();
  drawView();
  checkIntegrity();
}

function syncSliders() {
  $("warn").value = state.thresholds.warn;
  $("pause").value = state.thresholds.pause;
  $("warn-out").textContent = state.thresholds.warn.toFixed(2);
  $("pause-out").textContent = state.thresholds.pause.toFixed(2);
}

async function checkIntegrity() {
  const el = $("integrity");
  el.className = "integrity pending";
  el.textContent = "Checking the record in your browser…";
  const m = state.model;
  const chain = await verifyChain(state.lines);
  const anchors = verifyAnchors(state.anchors, m.entries);
  const blobs = await verifyBlobs(m.entries, async (hex) => {
    try {
      return await fetchText(`runs/${state.run.id}/blobs/${hex}`);
    } catch {
      return null;
    }
  });
  const signature = await verifyReceiptSignature(m.receipt);
  const head = verifyReceiptHead(m.receipt, m.entries);
  state.integrity = { chain, anchors, blobs, signature, head };
  const ok = chain.ok && anchors.ok && blobs.ok && head.ok && signature.ok;
  el.className = `integrity ${ok ? "ok" : signature.unsupported && chain.ok ? "pending" : "bad"}`;
  el.textContent = ok
    ? `Checked in your browser: ${chain.entries} entries link up and match their hashes, ${anchors.anchors} anchors match, ${blobs.blobs} stored blobs match their names, and the receipt signature is valid (key ${signature.keyId.slice(0, 19)}…). Tamper-evident, not tamper-proof.`
    : `Problem found: ${[chain, anchors, blobs, head, signature].find((r) => !r.ok)?.reason}`;
  if (state.tab === "ledger" || state.tab === "receipt") drawView();
}

// ---- header, verdicts, map --------------------------------------------------------------------------

function drawHeader() {
  const m = state.model;
  const line = clear($("run-line"));
  line.append(
    h("span", { class: `chip ${state.run.label === "live" ? "live" : ""}` }, state.run.label),
    h("span", {}, state.run.title),
    h("span", { class: "chip" }, `started ${state.run.started.slice(0, 16).replace("T", " ")} UTC`),
    m.models.worker.length ? h("span", { class: "chip" }, `worker ${m.models.worker.join(", ")}`) : null,
    m.models.watcher.length ? h("span", { class: "chip" }, `watcher ${m.models.watcher.join(", ")}`) : null,
    h("span", { class: "chip" }, `cost ${money(m.cost.worker + m.cost.watcher)}`),
  );
}

function drawVerdicts() {
  const v = state.model.receipt.verdicts;
  const card = (label, verdict, extra) =>
    h("div", { class: "verdict" }, h("div", { class: "label" }, label), h("div", { class: "word" }, verdict.verdict === "yes" ? "Yes" : verdict.verdict === "no" ? "No" : verdict.verdict === "partly" ? "Partly" : verdict.verdict), h("ul", {}, (verdict.reasons ?? []).map((r) => h("li", {}, r))), extra ?? null);
  clear($("verdicts")).append(
    card("Stayed on course", v.stayed_on_course, v.stayed_on_course.not_judged ? h("p", { class: "note" }, v.stayed_on_course.not_judged) : null),
    card("Result verified", v.result_verified, v.result_verified_by_checks ? h("p", { class: "note" }, `From the acceptance checks alone: ${v.result_verified_by_checks.verdict}. The two verdicts are never merged into one score.`) : null),
  );
}

function drawMap() {
  const m = state.model;
  $("warn-out").textContent = state.thresholds.warn.toFixed(2);
  $("pause-out").textContent = state.thresholds.pause.toFixed(2);
  const suggestion = suggestRestart(m, state.thresholds);
  const box = clear($("suggestion"));
  box.className = `suggestion ${suggestion.kind}`;
  box.append(h("strong", {}, suggestion.kind === "suggested" ? `Suggested restart point: ${suggestion.checkpoint.id}. ` : "Restart point: "), suggestion.text);
  if (suggestion.kind === "suggested") box.append(" ", h("button", { class: "link", type: "button", onclick: () => select(suggestion.checkpoint.id) }, `Open ${suggestion.checkpoint.id}`));
  renderMap($("map"), m, { thresholds: state.thresholds, selected: state.selected, suggestion, onSelect: select });
  const legend = clear($("legend"));
  for (const [color, label, hollow] of legendItems()) legend.append(h("li", {}, h("span", { class: "swatch", style: hollow ? `border-color:${color}` : `background:${color}` }), label));
  legend.append(h("li", {}, "square: record only, after an irreversible action"), h("li", {}, "outlined bar: scored again after a rule change"));
}

function select(id) {
  state.selected = id;
  drawMap();
  if (state.tab !== "checkpoint" && state.tab !== "drift") showTab("checkpoint");
  else drawView();
}

function showTab(tab) {
  state.tab = tab;
  for (const t of document.querySelectorAll('[role="tab"]')) {
    const on = t.id === `tab-${tab}`;
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
  }
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${tab}`;
  drawView();
}

function drawView() {
  const views = { checkpoint: viewCheckpoint, drift: viewDrift, rules: viewRules, ledger: viewLedger, receipt: viewReceipt };
  const el = clear($(`view-${state.tab}`));
  views[state.tab](el);
}

const goToEntries = (seqs) => {
  state.cited = new Set(seqs);
  state.filters = { ...state.filters, routine: false, branch: "all", actor: "all", type: "all", text: "" };
  showTab("ledger");
  requestAnimationFrame(() => document.querySelector("tr.cited")?.scrollIntoView({ block: "center" }));
};

// ---- checkpoint -------------------------------------------------------------------------------------

function viewCheckpoint(el) {
  const m = state.model;
  const cp = m.byId.get(state.selected);
  if (!cp) return el.append(h("p", {}, "Select a checkpoint on the run map."));
  const stage = cp.stage ? m.stageOf(cp.stage) : null;
  const report = m.reportFor(cp);
  const window = m.windowOf(cp);
  const actions = window.filter((e) => e.type === "tool_intent");
  const count = (d) => actions.filter((a) => a.body.decision === d).length;
  const latest = latestOverall(cp);
  const level = levelFor(latest, state.thresholds);

  el.append(
    h("h2", {}, `${cp.id}: ${stage?.title ?? cp.trigger.replaceAll("_", " ")} `, levelChip(level), " ", h("span", { class: "chip" }, `branch ${cp.branch}`), " ", h("span", { class: "chip" }, cp.safety.replaceAll("_", " "))),
    h("p", { class: "purpose" }, stage?.description ?? (cp.stage ? `Stage ${cp.stage}.` : `This checkpoint was taken because of: ${cp.trigger.replaceAll("_", " ")}.`), stage?.descriptionFromGuide ? h("span", { class: "note" }, " (From the current demo charter. The charter of this run had no stage descriptions yet.)") : null),
  );

  const says = h("div", { class: "box" }, h("h3", {}, "The worker says"));
  if (report) {
    says.append(
      h("p", {}, report.body.summary ?? `Stage ${report.body.stage} reported ${report.body.done ? "done" : "not done"}.`),
      h("dl", { class: "kv" }, h("dt", {}, "Reported done"), h("dd", {}, report.body.done ? "yes" : "no"), h("dt", {}, "Its confidence"), h("dd", {}, report.body.confidence ?? "not given"), h("dt", {}, "Deviations it named"), h("dd", {}, (report.body.deviations ?? []).length ? report.body.deviations.join("; ") : "none")),
      h("p", { class: "note" }, "This is the claim of the worker. It counts only where the evidence beside it supports it."),
    );
  } else says.append(h("p", { class: "note" }, "No stage report was written in this stretch."));

  const found = h("div", { class: "box" }, h("h3", {}, "Candor found"));
  const checks = cp.checks.map((c) => h("li", {}, `${c.body.check}: ${c.body.status}`, c.body.strength ? ` (check ${c.body.strength} against a planted fault)` : ""));
  const finding = cp.latest?.body.findings?.[0];
  found.append(
    h("dl", { class: "kv" },
      h("dt", {}, "Exit checks"), h("dd", {}, checks.length ? h("ul", { class: "plain" }, checks) : "none at this checkpoint"),
      h("dt", {}, "Drift"), h("dd", {}, latest === null ? `not scored (${cp.firstRecord?.body.message ?? cp.firstRecord?.body.reason ?? "no score"})` : `${fmt(latest)}, `, latest === null ? null : levelChip(level), finding ? ` ${finding.summary.length > 180 ? `${finding.summary.slice(0, 180)}…` : finding.summary}` : ""),
      h("dt", {}, "Actions"), h("dd", {}, `${count("allow")} allowed, ${count("deny")} denied, ${count("hold")} held for the operator`),
      h("dt", {}, "Files changed"), h("dd", {}, cp.changedPaths.length ? cp.changedPaths.slice(0, 8).join(", ") + (cp.changedCount > 8 ? `, and ${cp.changedCount - 8} more` : "") : "none"),
    ),
    latest !== null ? h("button", { class: "link", type: "button", onclick: () => showTab("drift") }, "Open the drift calculator for this checkpoint") : null,
  );

  const happened = h("div", { class: "box" }, h("h3", {}, "What happened in this stretch"));
  const notable = window.filter((e) => !ROUTINE(e) && e.type !== "tool_result");
  happened.append(notable.length ? h("ul", { class: "plain" }, notable.slice(0, 14).map((e) => h("li", {}, h("span", { class: "mono" }, `#${e.seq} `), describe(e)))) : h("p", { class: "note" }, "Nothing was recorded between this checkpoint and the one before it."));
  if (notable.length > 14) happened.append(h("button", { class: "link", type: "button", onclick: () => goToEntries(notable.map((e) => e.seq)) }, `See all ${notable.length} entries in the ledger`));

  const restart = h("div", { class: "box" }, h("h3", {}, "Restart from here"));
  if (cp.safety === "safe_to_restart") {
    restart.append(
      h("p", {}, "A restart starts a new branch from the files of this checkpoint and forks the conversation of the worker at this point. The old branch is kept. The reason becomes a rule on the new branch, and approvals do not carry over."),
      h("p", { class: "note" }, "The operator runs this outside the worker session, with the operator secret:"),
      h("pre", { class: "raw" }, `candor restart ${cp.id} --reason "<what went wrong and what to do instead>"`),
    );
  } else restart.append(h("p", {}, "This checkpoint is record only: an irreversible action happened on its branch before it, and a restart cannot undo it. Restart from an earlier checkpoint."));

  el.append(h("div", { class: "cols" }, says, found), h("div", { class: "cols", style: "margin-top:16px" }, happened, restart), h("p", { class: "note" }, `Entry #${cp.seq}, taken ${cp.ts.replace("T", " ").slice(0, 19)} UTC${cp.parent ? `, after ${cp.parent}` : ""}.`));
}

// ---- drift calculator ---------------------------------------------------------------------------------

function viewDrift(el) {
  const m = state.model;
  const cp = m.byId.get(state.selected);
  if (!cp) return el.append(h("p", {}, "Select a checkpoint on the run map."));
  el.append(h("h2", {}, `Drift at ${cp.id}`), h("p", { class: "purpose" }, "A separate Claude model with no tools scores four dimensions from 0 (on course) to 1 (off course), against the charter of the job. The overall drift is the largest of the four, so one bad dimension is not averaged away."));
  const reading = cp.latest;
  if (!reading) {
    el.append(h("p", {}, `This checkpoint was not scored: ${cp.firstRecord?.body.message ?? "no score was recorded."}`));
    el.append(trend(m));
    return;
  }
  const b = reading.body;
  const t = state.thresholds;
  const dims = h("div", { class: "dims" });
  for (const d of DIMENSIONS) {
    const v = b.dimensions?.[d] ?? 0;
    const lvl = levelFor(v, t);
    dims.append(
      h("div", { class: "dim" },
        h("span", {}, d),
        h("span", { class: "track", role: "img", "aria-label": `${d} ${v}` }, h("span", { class: "fill", style: `width:${Math.round(v * 100)}%;background:var(--${lvl === "ok" ? "ok" : lvl}-mark)` }), h("span", { class: "tick", style: `left:${t.warn * 100}%` }), h("span", { class: "tick", style: `left:${t.pause * 100}%` })),
        h("span", { class: "mono" }, fmt(v)),
      ),
    );
  }
  const values = DIMENSIONS.map((d) => `${d} ${fmt(b.dimensions?.[d] ?? 0)}`).join(", ");
  const overall = b.overall;
  const lvl = levelFor(overall, t);
  el.append(
    h("h3", {}, `${reading.type === "rescore" ? `Latest reading: scored again under charter version ${b.charter_version}` : "The reading at this checkpoint"} `, levelChip(lvl)),
    dims,
    h("div", { class: "arith" }, `overall = max(${values}) = ${fmt(overall)}   →   ${overall >= t.pause ? `at or above pause ${t.pause}` : overall >= t.warn ? `at or above warn ${t.warn}, below pause ${t.pause}` : `below warn ${t.warn}`}   →   ${lvl === "ok" ? "on course" : lvl}`),
  );

  const findings = b.findings ?? [];
  const charter = m.charterByVersion.get(b.charter_version ?? 1) ?? m.latestCharter;
  el.append(h("h3", {}, "Findings"));
  if (!findings.length) el.append(h("p", { class: "note" }, "No dimension was above 0.2, so the watcher gave no finding."));
  for (const f of findings) {
    const rule = charter?.drift_rules.find((r) => r.id === f.rule);
    el.append(h("div", { class: "finding" }, h("strong", {}, `${f.rule}${rule ? ` (${rule.dimension})` : ""}, ${f.severity}: `), f.summary, rule ? h("div", { class: "note" }, `Rule: ${rule.text}`) : null, h("div", {}, "Evidence: ", (f.entries ?? []).flatMap((n, i) => [i ? ", " : "", h("button", { class: "link mono", type: "button", onclick: () => goToEntries(f.entries) }, `#${n}`)]))));
  }

  // Every reading of this checkpoint, first and after each rule change. None is replaced.
  const rows = [cp.first, ...cp.rescores].filter(Boolean);
  el.append(
    h("h3", {}, "Every reading of this checkpoint"),
    h("div", { class: "tablewrap" },
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Reading"), h("th", {}, "Charter version"), h("th", { class: "num" }, "Overall"), h("th", {}, "Level"), h("th", {}, "Watcher"), h("th", { class: "num" }, "Cost"), h("th", {}, "Entry"))),
        h("tbody", {}, rows.map((r, i) => h("tr", {}, h("td", {}, i === 0 ? "first score" : r.body.status === "scored" ? "scored again" : "not scored again"), h("td", {}, String(r.body.charter_version ?? 1)), h("td", { class: "num" }, fmt(r.body.overall)), h("td", {}, r.body.level ? levelChip(levelFor(r.body.overall, t)) : r.body.reason ?? ""), h("td", {}, r.body.judge_model ?? ""), h("td", { class: "num" }, money(r.body.usage?.cost_usd)), h("td", {}, h("button", { class: "link mono", type: "button", onclick: () => goToEntries([r.seq]) }, `#${r.seq}`))))),
      ),
    ),
  );

  el.append(trend(m), evidenceBox(cp), liveJudge(cp), h("p", { class: "note" }, `Judge ${b.judge_model}, rubric version ${b.rubric_version}, ${b.usage?.input_tokens ?? 0} input and ${b.usage?.output_tokens ?? 0} output tokens, ${money(b.usage?.cost_usd)}.`));
}

/** Drift along the lineage of the active branch, with the warn and pause lines. */
function trend(m) {
  const line = m.lineageOf(m.activeBranch);
  const W = Math.max(320, line.length * 64);
  const H = 150;
  const x = (i) => 40 + i * ((W - 60) / Math.max(1, line.length - 1));
  const y = (v) => H - 26 - v * (H - 46);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `Drift over the run on branch ${m.activeBranch}` });
  for (const [name, v, c] of [["warn", state.thresholds.warn, "var(--warn-mark)"], ["pause", state.thresholds.pause, "var(--pause-mark)"]]) svg.append(s("line", { x1: 30, x2: W - 10, y1: y(v), y2: y(v), class: "thr", stroke: c }), s("text", { x: 2, y: y(v) + 3, class: "thr-label" }, name));
  const pts = line.map((c, i) => ({ c, i, v: latestOverall(c) })).filter((p) => p.v !== null);
  if (pts.length > 1) svg.append(s("polyline", { points: pts.map((p) => `${x(p.i)},${y(p.v)}`).join(" "), fill: "none", stroke: "currentColor", "stroke-width": 1.5, opacity: 0.6 }));
  line.forEach((c, i) => {
    const v = latestOverall(c);
    const lvl = levelFor(v, state.thresholds);
    svg.append(
      v === null ? s("circle", { cx: x(i), cy: y(0), r: 4, fill: "var(--surface)", stroke: "var(--none)", "stroke-width": 1.5 }) : s("circle", { cx: x(i), cy: y(v), r: c.id === state.selected ? 6 : 4.5, fill: `var(--${lvl === "ok" ? "ok" : lvl}-mark)` }, s("title", {}, `${c.id}: ${v}`)),
      s("text", { x: x(i), y: H - 8, "text-anchor": "middle", class: "cp-id" }, c.id),
    );
  });
  return h("div", {}, h("h3", {}, `Drift over the run, branch ${m.activeBranch} and the checkpoints it was forked from`), h("div", { class: "map-scroll" }, svg));
}

function evidenceBox(cp) {
  const box = h("details", { class: "box", style: "margin-top:16px" }, h("summary", {}, "The evidence the watcher saw at this checkpoint"));
  box.addEventListener("toggle", async () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = "1";
    const raw = cp.first?.body.bundle_json;
    let text = typeof raw === "string" ? raw : null;
    if (!text && raw?.$blob) text = await fetchText(`runs/${state.run.id}/blobs/${raw.$blob.replace("sha256:", "")}`).catch(() => null);
    if (!text) return box.append(h("p", { class: "note" }, "The stored evidence could not be read."));
    const bundle = JSON.parse(text);
    box.append(
      h("p", { class: "note" }, "This is the exact input stored with the first score. Worker text sat inside a data block that the watcher is told never to follow. The reasoning of the worker is never sent."),
      h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Entry"), h("th", {}, "Type"), h("th", {}, "Actor"), h("th", {}, "What the watcher read"))), h("tbody", {}, bundle.evidence.map((r) => h("tr", {}, h("td", { class: "mono" }, `#${r.seq}`), h("td", {}, r.type), h("td", {}, r.actor), h("td", {}, r.body.length > 400 ? `${r.body.slice(0, 400)}…` : r.body)))))),
    );
  });
  return box;
}

function liveJudge(cp) {
  const box = h("div", { class: "box", style: "margin-top:16px" }, h("h3", {}, "Ask the watcher again, with a rule of your own"));
  if (!cp.first) {
    box.append(h("p", { class: "note" }, "This checkpoint has no stored evidence, so it cannot be scored again."));
    return box;
  }
  const dim = h("select", { id: "judge-dimension", "aria-label": "Dimension of the rule" }, DIMENSIONS.map((d) => h("option", { value: d }, d)));
  dim.value = "scope";
  const text = h("input", { type: "text", id: "judge-rule", maxlength: 300, placeholder: "For example: Do not modify records that are not duplicates.", "aria-label": "Your rule" });
  const out = h("div", { class: "result", role: "status" });
  const button = h("button", { class: "btn primary", type: "button" }, "Score again");
  button.addEventListener("click", async () => {
    clear(out).append(h("p", { class: "note" }, "Asking the watcher…"));
    button.disabled = true;
    try {
      const res = await fetch("api/rescore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: state.run.id, checkpoint: cp.id, rule: { dimension: dim.value, text: text.value } }) });
      const body = await res.json().catch(() => ({}));
      clear(out);
      if (!res.ok) return out.append(h("p", {}, res.status === 404 && !body.error ? "The live watcher is not available on this copy of the site." : body.error ?? `The watcher answered ${res.status}.`));
      out.append(
        h("p", {}, h("span", { class: "chip live" }, "live"), ` Scored ${fmt(body.overall)} `, levelChip(levelFor(body.overall, state.thresholds)), ` with your rule, against ${fmt(body.original?.overall)} recorded at the time.${body.cached ? " This answer was given to the same question before." : ""}`),
        h("div", { class: "arith" }, DIMENSIONS.map((d) => `${d} ${fmt(body.dimensions?.[d] ?? 0)}`).join(", ")),
        (body.findings ?? []).map((f) => h("div", { class: "finding" }, h("strong", {}, `${f.rule}, ${f.severity}: `), f.summary)),
        h("p", { class: "note" }, `${body.note} Judge ${body.judge_model}, ${money(body.usage?.cost_usd)}.`),
      );
    } catch {
      clear(out).append(h("p", {}, "The live watcher is not available on this copy of the site. The recorded scores above are unchanged."));
    } finally {
      button.disabled = false;
    }
  });
  box.append(h("p", { class: "note" }, "The real watcher reads the same stored evidence again, with your rule beside the rules of the charter. The answer is labelled live and is not added to the signed record."), h("div", { class: "form-row" }, dim, text, button), out);
  return box;
}

// ---- rules --------------------------------------------------------------------------------------------

function viewRules(el) {
  const m = state.model;
  const c = m.latestCharter;
  el.append(h("h2", {}, `The charter in force: ${c.id}, version ${c.version}`), h("p", { class: "purpose" }, `Goal: ${c.goal}`), h("p", { class: "note" }, "The charter is the only part of Candor written for this job. The same engine runs any job whose charter names its scope, its stages, its checks and its drift rules."));

  const table = (head, rows) => h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((x) => h("th", {}, x)))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((x) => h("td", {}, x)))))));
  el.append(
    h("h3", {}, "Checked by fixed code before every tool call"),
    table(["Rule", "Setting", "When it fails"], [
      ["Paths the job may change", c.scope.allow_paths.join(", ") || "none", "denied"],
      ["Paths it may never change", c.scope.deny_paths.join(", ") || "none", "denied"],
      ["Commands it may run", c.scope.allow_commands.join(" | "), "denied"],
      ["Network", c.scope.network ? "allowed" : "not allowed", "denied"],
      ["Budget for the whole run, across branches", `${c.budget.max_cost_usd} dollars, ${c.budget.max_turns} turns, ${c.budget.max_minutes} minutes`, "denied"],
      ["Irreversible actions", c.irreversible.join(" | "), "held until the operator approves that exact action, once"],
    ]),
  );

  const findingsFor = (id) => m.entries.filter((e) => (e.type === "drift_score" || e.type === "rescore") && (e.body.findings ?? []).some((f) => f.rule === id)).length;
  const versionOf = (id) => m.charters.find((x) => x.drift_rules.some((r) => r.id === id))?.version ?? 1;
  el.append(
    h("h3", {}, "Scored by the watcher at every checkpoint"),
    table(["Rule", "Dimension", "Text", "Origin", "Since version", "Findings"], c.drift_rules.map((r) => [h("span", { class: "mono" }, r.id), r.dimension, r.text, r.source === "generated" ? "drafted with the charter" : r.source === "restart" ? "lesson of a restart" : "added by the operator", String(versionOf(r.id)), String(findingsFor(r.id))])),
    h("p", { class: "note" }, `Thresholds: warn at ${c.thresholds.warn}, pause at ${c.thresholds.pause}. A pause denies every tool call until a person continues, adds a rule or restarts.`),
  );

  const strength = new Map(m.entries.filter((e) => e.type === "check_strength").map((e) => [e.body.check, e.body.status]));
  el.append(
    h("h3", {}, "Stages and the checks each must pass"),
    table(["Stage", "What it is for", "Exit checks, and whether each failed on its planted fault"], c.stages.map((st) => [st.title, m.stageOf(st.id)?.description ?? st.description ?? "", st.exit_checks.map((id) => `${id} (${strength.get(id) ?? "not tested"})`).join(", ") || "none"])),
  );

  el.append(h("h3", {}, "How the charter changed during the run"));
  if (!m.ruleChanges.length) el.append(h("p", { class: "note" }, "No rule was added during this run."));
  else el.append(table(["Version", "Rule added", "Reason", "Entry"], m.ruleChanges.map((e) => [`${e.body.from_version} to ${e.body.version}`, `${e.body.rule?.id} (${e.body.rule?.dimension}): ${e.body.rule?.text}`, e.body.reason ?? "", h("button", { class: "link mono", type: "button", onclick: () => goToEntries([e.seq]) }, `#${e.seq}`)])));
}

// ---- ledger -------------------------------------------------------------------------------------------

function viewLedger(el) {
  const m = state.model;
  const f = state.filters;
  const integrity = state.integrity;
  el.append(h("h2", {}, "Ledger"), h("p", { class: "purpose" }, "Every hook event, decision, check, score, rule change and restart, in order. Each entry holds the hash of the one before it, so a change to any entry breaks every later hash. Only the daemon writes it, and it never edits or deletes an entry."));
  if (integrity) el.append(h("p", { class: `integrity ${integrity.chain.ok && integrity.anchors.ok ? "ok" : "bad"}` }, integrity.chain.ok ? `Chain intact: ${integrity.chain.entries} entries. ${integrity.anchors.anchors} anchors match. Checked in your browser.` : integrity.chain.reason));

  const opt = (values, current) => values.map((v) => h("option", { value: v, selected: v === current ? true : null }, v));
  const branchSel = h("select", { "aria-label": "Branch" }, opt(["all", ...m.branches.keys()], f.branch));
  const actorSel = h("select", { "aria-label": "Actor" }, opt(["all", "worker", "candord", "watcher", "operator"], f.actor));
  const typeSel = h("select", { "aria-label": "Entry type" }, opt(["all", ...new Set(m.entries.map((e) => e.type))].sort(), f.type));
  const search = h("input", { type: "text", value: f.text, placeholder: "Search the entries", "aria-label": "Search" });
  const routine = h("input", { type: "checkbox", checked: f.routine ? true : null });
  const update = () => {
    state.filters = { branch: branchSel.value, actor: actorSel.value, type: typeSel.value, text: search.value, routine: routine.checked };
    state.cited = new Set();
    drawView();
  };
  for (const c of [branchSel, actorSel, typeSel, routine]) c.addEventListener("change", update);
  search.addEventListener("change", update);

  const rows = m.entries.filter((e) => (f.branch === "all" || (e.branch ?? "A") === f.branch) && (f.actor === "all" || e.actor === f.actor) && (f.type === "all" || e.type === f.type) && (!f.routine || !ROUTINE(e)) && (!f.text || `${describe(e)} ${JSON.stringify(e.body)}`.toLowerCase().includes(f.text.toLowerCase())));
  const csv = () => ["seq,ts,branch,actor,type,description,hash", ...rows.map((e) => [e.seq, e.ts, e.branch ?? "A", e.actor, e.type, describe(e), e.hash].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","))].join("\n");
  el.append(
    h("div", { class: "filters" }, h("label", {}, "Branch ", branchSel), h("label", {}, "Actor ", actorSel), h("label", {}, "Type ", typeSel), search, h("label", {}, routine, " hide routine entries"),
      h("button", { class: "btn", type: "button", onclick: () => download(`${state.run.id}-ledger.csv`, csv(), "text/csv") }, "Export CSV"),
      h("button", { class: "btn", type: "button", onclick: () => download(`${state.run.id}-ledger.json`, JSON.stringify(rows, null, 1), "application/json") }, "Export JSON")),
    h("p", { class: "note" }, `${rows.length} of ${m.entries.length} entries shown. Select a row to see the raw entry.`),
  );
  const body = h("tbody");
  for (const e of rows) {
    const tr = h("tr", { class: `row${state.cited.has(e.seq) ? " cited" : ""}`, tabindex: 0 }, h("td", { class: "num mono" }, String(e.seq)), h("td", { class: "mono" }, e.ts.slice(11, 19)), h("td", {}, e.branch ?? "A"), h("td", {}, e.actor), h("td", {}, e.type), h("td", {}, describe(e)), h("td", { class: "mono" }, e.hash.slice(7, 15)));
    const toggle = () => {
      if (state.open.has(e.seq)) state.open.delete(e.seq);
      else state.open.add(e.seq);
      drawView();
    };
    tr.addEventListener("click", toggle);
    tr.addEventListener("keydown", (k) => k.key === "Enter" && toggle());
    body.append(tr);
    if (state.open.has(e.seq)) body.append(h("tr", {}, h("td", { colspan: 7 }, h("pre", { class: "raw" }, JSON.stringify(e, null, 2)))));
  }
  el.append(h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["#", "Time UTC", "Branch", "Actor", "Type", "What happened", "Hash"].map((x) => h("th", {}, x)))), body)));

  // Registers a compliance owner asks for.
  const reg = (title, list, render, empty) => [h("h3", {}, title), list.length ? h("ul", { class: "plain" }, list.map((e) => h("li", {}, h("button", { class: "link mono", type: "button", onclick: () => goToEntries([e.seq]) }, `#${e.seq}`), " ", render(e)))) : h("p", { class: "note" }, empty)];
  el.append(
    h("h2", { style: "margin-top:22px" }, "Registers"),
    ...reg("Held actions and operator approvals", [...m.held, ...m.approvals].sort((a, b) => a.seq - b.seq), (e) => (e.type === "tool_intent" ? `Held: ${e.body.summary}` : `Approved once, for the exact action ${String(e.body.action_digest).slice(7, 19)}, until ${e.body.expires_at}`), "No action was held."),
    ...reg("Effects that left the workspace or cannot be undone", m.effects, (e) => describe(e), "No effect was recorded."),
    ...reg("Rule changes and restarts", [...m.ruleChanges, ...m.restarts].sort((a, b) => a.seq - b.seq), (e) => describe(e), "None."),
    ...reg("Operator actions refused because they came without the secret", m.refused, (e) => describe(e), "None. No request reached the operator channel without the secret."),
    ...reg("Sessions, with the Claude Code version and what was loaded", m.sessions, (e) => describe(e), "None."),
  );

  // The tamper test: change one entry in memory and run the same check again.
  const seqInput = h("input", { type: "text", id: "tamper-seq", value: "40", "aria-label": "Entry to change", style: "width:6rem" });
  const out = h("div", { class: "result", role: "status" });
  const tamper = async () => {
    const n = Number(seqInput.value);
    if (!Number.isInteger(n) || n < 1 || n > state.lines.length) return clear(out).append(h("p", {}, `Give an entry number from 1 to ${state.lines.length}.`));
    const copy = [...state.lines];
    const entry = JSON.parse(copy[n - 1]);
    entry.body = { ...entry.body, changed_by_reader: true };
    copy[n - 1] = canonicalJson(entry);
    const result = await verifyChain(copy);
    clear(out).append(h("p", { class: `integrity ${result.ok ? "ok" : "bad"}` }, result.ok ? "The chain still verifies." : `Detected: first bad entry ${result.firstBadSeq}. ${result.reason}`), h("p", { class: "note" }, "Only the copy in this page was changed. The files of the run are untouched."));
  };
  el.append(h("h2", { style: "margin-top:22px" }, "Try to tamper with it"), h("p", { class: "note" }, "Change one entry in memory, then check the chain again with the same code as above."), h("div", { class: "form-row" }, h("label", {}, "Entry ", seqInput), h("button", { class: "btn", type: "button", onclick: tamper }, "Change it and check again")), out);
}

// ---- receipt ------------------------------------------------------------------------------------------

function viewReceipt(el) {
  const r = state.model.receipt;
  const sig = state.integrity?.signature;
  el.append(h("h2", {}, "Trust receipt"), h("p", { class: "purpose" }, "The document a reviewer who was not there approves from. It is signed with Ed25519, and it gives two verdicts that are never merged: whether the job stayed on course, and whether its result was verified."));
  const table = (head, rows) => h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((x) => h("th", {}, x)))), h("tbody", {}, rows.map((row) => h("tr", {}, row.map((x) => h("td", {}, x)))))));
  el.append(
    h("h3", {}, "Each success criterion, with its check"),
    table(["Criterion", "Check", "Check strength", "Outcome"], (r.criteria ?? []).map((c) => [c.text, c.check ?? "no check", c.strength ?? "", c.outcome_text ?? c.status])),
    h("h3", {}, "Corrections"),
    (r.corrections ?? []).length ? h("ul", { class: "plain" }, r.corrections.map((c) => h("li", {}, c.detail))) : h("p", { class: "note" }, "No restart was recorded."),
    h("h3", {}, "What this run did not check"),
    h("ul", { class: "plain" }, (r.coverage ?? []).map((c) => h("li", {}, c))),
    h("h3", {}, "Limits"),
    h("ul", { class: "plain" }, (r.limits ?? []).map((c) => h("li", {}, c))),
    h("h3", {}, "Integrity"),
    h("p", { class: `integrity ${sig?.ok ? "ok" : "bad"}` }, sig ? (sig.ok ? `The signature is valid. Key id ${sig.keyId}. Checked in your browser.` : sig.reason) : "Checking…"),
    h("p", { class: "note" }, "On your own machine, in the folder of the receipt, the same checks run with:"),
    h("pre", { class: "raw" }, r.integrity?.command ?? "candor verify receipt.json --key-id <id>"),
    h("p", { class: "note" }, "A pass shows the receipt was not changed after it was signed and the record was not changed after it was anchored. It does not show that every event was recorded, that a tool did what it reported, or that the result is right."),
  );

  const area = h("textarea", { rows: 6, style: "width:100%", placeholder: "Paste a receipt.json here", "aria-label": "Receipt to verify" });
  const out = h("div", { class: "result", role: "status" });
  const check = async () => {
    let parsed;
    try {
      parsed = JSON.parse(area.value);
    } catch {
      return clear(out).append(h("p", {}, "That is not JSON."));
    }
    const result = await verifyReceiptSignature(parsed);
    clear(out).append(h("p", { class: `integrity ${result.ok ? "ok" : "bad"}` }, result.ok ? `Valid signature, key id ${result.keyId}. Compare the key id with the one the issuer gave you.` : result.reason));
  };
  el.append(
    h("h3", {}, "Verify a receipt somewhere else"),
    h("p", { class: "note" }, "Paste any receipt. Change one character first, and the check fails."),
    h("div", { class: "form-row" }, h("button", { class: "btn", type: "button", onclick: () => (area.value = JSON.stringify(r, null, 1)) }, "Paste the receipt of this run"), h("button", { class: "btn primary", type: "button", onclick: check }, "Verify")),
    area,
    out,
  );
}

start();
