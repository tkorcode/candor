// Candor Console. Loads one recorded run, verifies it in the browser, and shows the story of the run, the run
// map, and five views of the selected checkpoint: the checkpoint, its drift, the rules, the ledger and the
// receipt. Every value comes from the run files. Worker text is shown as text only.

import { canonicalJson } from "./canonical.js";
import { clear, download, fmt, h, money, s } from "./dom.js";
import { renderMap } from "./map.js";
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
  guide: [],
};
const $ = (id) => document.getElementById(id);
const fetchText = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.text();
};
const ROUTINE = (e) => e.type === "anchor" || e.type === "heartbeat" || e.type === "hook_event" || (e.type === "check_result" && e.body.check === "budget");
const short = (text, n) => (text && text.length > n ? `${text.slice(0, n - 1)}…` : (text ?? ""));
const firstSentences = (text, n) => (text ?? "").split(/(?<=\.)\s+/).slice(0, n).join(" ");
const levelWord = (level) => (level === "ok" ? "on course" : level);

const QUESTION = { goal: "Does the work serve the goal?", scope: "Does it stay inside the scope?", plan: "Does it follow the plan?", evidence: "Are its claims backed by the record?" };
const HEADLINE = { goal: "The work drifted from the goal", scope: "The work went outside its scope", plan: "The plan was not followed", evidence: "A claim is not backed by evidence" };

const icon = (name, size = 18) => {
  const paths = {
    check: [s("path", { d: "M20 6 9 17l-5-5" })],
    partly: [s("circle", { cx: 12, cy: 12, r: 9 }), s("path", { d: "M12 7v6M12 16.5v.5" })],
    cross: [s("path", { d: "M18 6 6 18M6 6l12 12" })],
  };
  return s("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, paths[name]);
};
const chipFor = (level, value) => h("span", { class: `chip ${level === "not scored" ? "none" : level}` }, value === null || value === undefined ? levelWord(level) : `${levelWord(level)} ${fmt(value)}`);

// ---- loading ---------------------------------------------------------------------------------------

async function start() {
  try {
    state.runs = JSON.parse(await fetchText("runs/index.json"));
  } catch {
    $("run-title").textContent = "No recorded runs were found.";
    $("run-meta").textContent = "Run node scripts/site-data.mjs to copy them from results/.";
    return;
  }
  const select = $("run-select");
  for (const r of state.runs) select.append(h("option", { value: r.id }, r.title.replace(/^Live run: /, "").replace(/ \(run [^)]+\)$/, "")));
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
  $("integrity").addEventListener("click", () => {
    const d = $("integrity-detail");
    d.hidden = !d.hidden;
    $("integrity").setAttribute("aria-expanded", d.hidden ? "false" : "true");
  });
  let resize = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resize);
    resize = requestAnimationFrame(() => state.model && drawMap());
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
  state.guide = JSON.parse(guideText);
  const entries = state.lines.map((l) => JSON.parse(l));
  state.model = buildModel({ entries, charters: JSON.parse(chartersText), receipt: JSON.parse(receiptText), meta, stageGuide: state.guide });
  state.thresholds = { ...state.model.thresholds };
  const suggestion = suggestRestart(state.model, state.thresholds);
  state.selected = suggestion.flagged?.id ?? state.model.lineageOf(state.model.activeBranch).at(-1)?.id ?? null;
  state.tab = "checkpoint";
  state.cited = new Set();
  state.open = new Set();
  drawHeader();
  drawVerdicts();
  drawStory();
  drawMap();
  drawDetail();
  checkIntegrity();
}

/** The plain name of the step a checkpoint closes. */
function stageTitle(cp) {
  const m = state.model;
  if (cp.stage) return m.stageOf(cp.stage)?.title ?? state.guide.find((g) => g.id === cp.stage)?.title ?? cp.stage;
  if (cp.trigger === "before_irreversible") return "Before the migration";
  if (cp.trigger === "final") return "End of the run";
  if (cp.trigger === "restart") return "Restart point";
  return cp.trigger.replaceAll("_", " ");
}

async function checkIntegrity() {
  const el = $("integrity");
  el.className = "integrity pending";
  el.textContent = "Checking the record…";
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
  clear(el).append(icon(ok ? "check" : "cross", 16), ok ? "Record verified in your browser" : "Problem found in the record");
  el.className = `integrity ${ok ? "ok" : signature.unsupported && chain.ok ? "pending" : "bad"}`;
  $("integrity-detail").textContent = ok
    ? `${chain.entries} ledger entries link up and match their hashes, ${anchors.anchors} anchors kept outside the run folder match, ${blobs.blobs} stored blobs match their names, and the receipt signature is valid (key ${signature.keyId.slice(0, 19)}…). Tamper-evident, not tamper-proof.`
    : ([chain, anchors, blobs, head, signature].find((r) => !r.ok)?.reason ?? "");
  if (state.tab === "ledger" || state.tab === "receipt") drawView();
}

// ---- header, verdicts, story --------------------------------------------------------------------------

function drawHeader() {
  const m = state.model;
  $("run-title").textContent = m.latestCharter?.goal ?? state.run.title;
  const meta = clear($("run-meta"));
  meta.append(
    h("span", { class: state.run.label === "live" ? "live" : "" }, state.run.label === "live" ? "Live run" : "Scripted run"),
    h("span", {}, `recorded ${state.run.started.slice(0, 10)}`),
    m.models.worker.length ? h("span", {}, `worker ${m.models.worker.join(", ")}`) : null,
    m.models.watcher.length ? h("span", {}, `watcher ${m.models.watcher.join(", ")}`) : null,
    h("span", {}, money(m.cost.worker + m.cost.watcher)),
  );
}

function drawVerdicts() {
  const v = state.model.receipt.verdicts;
  const tone = (verdict) => (verdict === "yes" ? "ok" : verdict === "partly" ? "warn" : "pause");
  const word = (verdict) => (verdict === "yes" ? "Yes" : verdict === "no" ? "No" : verdict === "partly" ? "Partly" : verdict);
  const card = (question, verdict, why) =>
    h("div", { class: `verdict ${tone(verdict.verdict)}` }, h("div", { class: "icon" }, icon(verdict.verdict === "yes" ? "check" : verdict.verdict === "partly" ? "partly" : "cross", 20)), h("div", {}, h("div", { class: "q" }, question), h("div", { class: "a" }, word(verdict.verdict)), h("p", { class: "why" }, why)));
  const criteria = state.model.receipt.criteria ?? [];
  const verified = criteria.filter((c) => c.status === "verified").length;
  const unchecked = criteria.filter((c) => c.status !== "verified").map((c) => c.text);
  clear($("verdicts")).append(
    card("Did the job stay on course?", v.stayed_on_course, v.stayed_on_course.verdict === "yes" ? "No pause was left open, and every stage passed its exit checks." : firstSentences(v.stayed_on_course.reasons?.[0], 1)),
    card("Was the result verified?", v.result_verified, criteria.length ? `${verified} of ${criteria.length} success criteria passed a proven check.${unchecked.length ? ` Not verified: ${unchecked.map((t) => short(t, 60)).join("; ")}` : ""}` : firstSentences(v.result_verified.reasons?.[0], 1)),
  );
}

/** The moments of the run, in order, from the ledger: what a person would tell you happened. */
function storyItems() {
  const m = state.model;
  const items = [];
  const firstCp = m.checkpoints[0];
  if (firstCp) items.push({ seq: firstCp.seq, tone: "", title: "The job starts", detail: `${stageTitle(firstCp)}, on branch ${firstCp.branch}`, target: firstCp.id });
  for (const r of m.ruleChanges.filter((e) => e.body.source !== "restart")) {
    const before = [...m.checkpoints].reverse().find((c) => c.seq < r.seq);
    items.push({ seq: r.seq, tone: "accent", title: "A rule is added", detail: short(r.body.rule?.text, 60), target: before?.id, tab: "rules" });
  }
  for (const r of m.restarts) {
    const first = m.checkpoints.find((c) => c.branch === r.body.to_branch);
    items.push({ seq: r.seq, tone: "accent", title: `Restart from ${r.body.from}`, detail: `Branch ${r.body.to_branch}, with the reason as a rule`, target: first?.id ?? r.body.from });
  }
  const flagged = m.lineageOf(m.activeBranch).find((c) => {
    const o = latestOverall(c);
    return o !== null && o >= state.thresholds.warn;
  });
  if (flagged) {
    const level = levelFor(latestOverall(flagged), state.thresholds);
    items.push({ seq: flagged.seq, tone: level, title: level === "pause" ? "The watcher pauses the job" : "The watcher warns", detail: `${flagged.id}, ${stageTitle(flagged)}, ${fmt(latestOverall(flagged))}`, target: flagged.id });
  }
  for (const a of m.approvals) {
    const cp = [...m.checkpoints].reverse().find((c) => c.seq < a.seq && c.trigger === "before_irreversible") ?? [...m.checkpoints].reverse().find((c) => c.seq < a.seq);
    items.push({ seq: a.seq, tone: "", title: "A step waits for a person", detail: "Held, then approved by the operator", target: cp?.id });
  }
  const last = m.checkpoints.at(-1);
  const v = m.receipt.verdicts;
  if (last) items.push({ seq: Number.MAX_SAFE_INTEGER, tone: "", title: "The trust receipt", detail: `On course ${v.stayed_on_course.verdict}, verified ${v.result_verified.verdict}`, target: last.id, tab: "receipt" });
  return items.sort((a, b) => a.seq - b.seq);
}

function drawStory() {
  const nav = clear($("story"));
  storyItems().forEach((it, i) => {
    const current = it.target === state.selected && (it.tab ?? "checkpoint") === state.tab;
    nav.append(
      h("button", { type: "button", "aria-current": current ? "true" : "false", onclick: () => {
        state.selected = it.target ?? state.selected;
        state.tab = it.tab ?? "checkpoint";
        drawStory();
        drawMap();
        drawDetail();
        $("detail-head").scrollIntoView({ behavior: "smooth", block: "start" });
      } }, h("span", { class: `n ${it.tone}` }, String(i + 1)), h("span", {}, h("div", { class: "t" }, it.title), h("div", { class: "d" }, it.detail))),
    );
  });
}

// ---- map ------------------------------------------------------------------------------------------------

function drawMap() {
  const m = state.model;
  const suggestion = suggestRestart(m, state.thresholds);
  const box = clear($("suggestion"));
  box.className = `suggestion ${suggestion.kind}`;
  box.append(h("span", {}, h("strong", {}, suggestion.kind === "suggested" ? `Suggested restart point: ${suggestion.checkpoint.id}. ` : "Restart point. "), suggestion.text));
  if (suggestion.kind === "suggested") box.append(h("button", { class: "link", type: "button", onclick: () => select(suggestion.checkpoint.id) }, `Open ${suggestion.checkpoint.id}`));
  renderMap($("map"), m, { thresholds: state.thresholds, selected: state.selected, suggestion, onSelect: select, stageTitle });
  const legend = clear($("legend"));
  const sw = (cls, color) => h("span", { class: `swatch ${cls}`, style: color ? `background:${color}` : "" });
  const glyph = (d, color) => s("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: color, "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, d.map((p) => (p.startsWith("rect") ? s("rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }) : s("path", { d: p }))));
  legend.append(
    h("li", {}, sw("", "var(--ok-mark)"), "on course"),
    h("li", {}, sw("", "var(--warn-mark)"), "warn"),
    h("li", {}, sw("", "var(--pause-mark)"), "pause"),
    h("li", {}, h("span", { class: "swatch-dash", "aria-hidden": "true" }, "–"), "not scored"),
    h("li", {}, sw("ring"), "can restart here"),
    h("li", {}, sw("square"), "record only"),
    h("li", {}, glyph(["rect", "M8 11V7a4 4 0 0 1 8 0v4"], "var(--fg)"), "waits for a person"),
    h("li", {}, sw("", "var(--fg)"), "scored again"),
  );
}

function select(id) {
  state.selected = id;
  if (state.tab !== "checkpoint" && state.tab !== "drift") state.tab = "checkpoint";
  drawStory();
  drawMap();
  drawDetail();
}

// ---- the selected checkpoint --------------------------------------------------------------------------

function drawDetail() {
  const m = state.model;
  const cp = m.byId.get(state.selected);
  const head = clear($("detail-head"));
  if (cp) {
    const latest = latestOverall(cp);
    const level = levelFor(latest, state.thresholds);
    head.append(
      h("h2", {}, `${cp.id} · ${stageTitle(cp)}`),
      chipFor(level, latest),
      h("span", { class: `chip ${cp.safety === "safe_to_restart" ? "accent" : "none"}` }, cp.safety === "safe_to_restart" ? "can restart here" : "record only"),
      h("span", { class: "chip" }, `branch ${cp.branch}`),
    );
  }
  for (const t of document.querySelectorAll('[role="tab"]')) {
    const on = t.id === `tab-${state.tab}`;
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
  }
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${state.tab}`;
  drawView();
}

function showTab(tab) {
  state.tab = tab;
  drawStory();
  drawDetail();
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
const entryLinks = (seqs) => (seqs ?? []).flatMap((n, i) => [i ? " " : "", h("button", { class: "link mono", type: "button", onclick: () => goToEntries(seqs) }, `#${n}`)]);

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
  const finding = cp.latest?.body.findings?.[0];
  const charter = m.charterByVersion.get(cp.latest?.body.charter_version ?? 1) ?? m.latestCharter;
  const dimension = finding ? (charter?.drift_rules.find((r) => r.id === finding.rule)?.dimension ?? null) : null;

  if (level === "warn" || level === "pause") {
    el.append(
      h("div", { class: `alert ${level}` },
        h("h3", {}, dimension ? HEADLINE[dimension] : `Drift reached ${level}`),
        finding ? h("p", {}, firstSentences(finding.summary, 2)) : null,
        h("p", { class: "did" }, level === "pause" ? "Every tool call waited until a person continued, added a rule or restarted." : "Candor sent the worker a note. A warn does not stop the job.", " ", h("button", { class: "link", type: "button", onclick: () => showTab("drift") }, "Why this score")),
      ),
    );
  } else if (stage?.description) el.append(h("p", { class: "sum" }, stage.description));

  const says = h("div", { class: "box" }, h("h3", {}, "The worker reported"));
  if (report) {
    says.append(h("p", {}, report.body.summary ?? `Stage ${report.body.stage} ${report.body.done ? "done" : "not done"}.`));
    const dev = report.body.deviations ?? [];
    if (dev.length) says.append(h("div", { class: "note" }, "Deviations it named"), h("ul", { class: "plain" }, dev.map((d) => h("li", {}, d))));
  } else says.append(h("p", { class: "note" }, "No stage report in this stretch."));

  const found = h("div", { class: "box" }, h("h3", {}, "Candor checked"));
  found.append(
    h("dl", { class: "facts" },
      h("dt", {}, "Exit checks"), h("dd", {}, cp.checks.length ? cp.checks.map((c) => h("div", {}, h("span", { class: `state ${c.body.status === "passed" ? "ok" : "bad"}` }, icon(c.body.status === "passed" ? "check" : "cross", 14), c.body.check), c.body.strength ? h("span", { class: "note" }, ` · ${c.body.strength}`) : "")) : "none here"),
      h("dt", {}, "Drift"), h("dd", {}, latest === null ? `not scored${cp.firstRecord?.body.reason === "no_new_work" ? ", no new work" : ""}` : chipFor(level, latest)),
      h("dt", {}, "Tool calls"), h("dd", {}, `${count("allow")} allowed, ${count("deny")} refused, ${count("hold")} held`),
      h("dt", {}, "Files changed"), h("dd", {}, cp.changedPaths.length ? cp.changedPaths.slice(0, 6).join(", ") + (cp.changedCount > 6 ? ` and ${cp.changedCount - 6} more` : "") : "none"),
    ),
  );
  el.append(h("div", { class: "cols" }, says, found));

  const notable = window.filter((e) => !ROUTINE(e) && e.type !== "tool_result");
  const activity = h("details", { class: "more" }, h("summary", {}, `What happened in this stretch (${notable.length} entries)`));
  activity.append(notable.length ? h("ul", { class: "plain" }, notable.slice(0, 20).map((e) => h("li", {}, h("span", { class: "mono note" }, `#${e.seq} `), describe(e)))) : h("p", { class: "note" }, "Nothing was recorded here."));
  if (notable.length > 20) activity.append(h("button", { class: "link", type: "button", onclick: () => goToEntries(notable.map((e) => e.seq)) }, `All ${notable.length} in the ledger`));

  const restart = h("div", { class: "box wide" }, h("h3", {}, cp.safety === "safe_to_restart" ? "Restart from here" : "Record only"));
  if (cp.safety === "safe_to_restart") {
    restart.append(
      h("p", {}, "Opens a new branch from the files of this checkpoint and forks the worker conversation here. The reason becomes a rule, and the old branch is kept. Only the operator can restart, on the machine running the job."),
      h("pre", { class: "cmd" }, `candor restart ${cp.id} --reason "<what went wrong>"`),
    );
  } else restart.append(h("p", {}, "An action that cannot be undone happened before this point, so a restart has to start from an earlier checkpoint."));

  el.append(restart, activity);
}

// ---- drift ---------------------------------------------------------------------------------------------

function viewDrift(el) {
  const m = state.model;
  const cp = m.byId.get(state.selected);
  if (!cp) return el.append(h("p", {}, "Select a checkpoint on the run map."));
  const reading = cp.latest;
  if (!reading) {
    el.append(h("p", {}, `${cp.id} was not scored${cp.firstRecord?.body.reason === "no_new_work" ? ", because there was no new work since the last checkpoint" : ""}.`), trend(m));
    return;
  }
  const b = reading.body;
  const t = state.thresholds;
  const lvl = levelFor(b.overall, t);
  const charter = m.charterByVersion.get(b.charter_version ?? 1) ?? m.latestCharter;
  el.append(h("p", { class: "sum" }, `A separate Claude model with no tools scores four questions from 0 (on course) to 1 (off course). The highest is the drift: ${fmt(b.overall)}, ${levelWord(lvl)}.${reading.type === "rescore" ? ` This is the reading after the rules changed, charter version ${b.charter_version}.` : ""}`));

  const dims = h("div", { class: "dims" });
  const findings = b.findings ?? [];
  for (const d of DIMENSIONS) {
    const v = b.dimensions?.[d] ?? 0;
    const dl = levelFor(v, t);
    const own = findings.filter((f) => charter?.drift_rules.find((r) => r.id === f.rule)?.dimension === d);
    const open = own.length > 0 || dl !== "ok";
    const row = h("div", { class: `dim${open ? " flagged" : ""}` },
      h("div", { class: "dim-row" },
        h("div", {}, h("div", { class: "dim-name" }, d[0].toUpperCase() + d.slice(1)), h("div", { class: "dim-q" }, QUESTION[d])),
        h("span", { class: "track", role: "img", "aria-label": `${d} ${v}` }, h("span", { class: "fill", style: `width:${Math.round(v * 100)}%;background:var(--${dl === "ok" ? "ok" : dl}-mark)` }), h("span", { class: "tick", style: `left:${t.warn * 100}%` }), h("span", { class: "tick", style: `left:${t.pause * 100}%` })),
        h("span", { class: "dim-v" }, fmt(v)),
      ),
    );
    for (const f of own) {
      const rule = charter?.drift_rules.find((r) => r.id === f.rule);
      row.append(h("div", { class: "dim-body" },
        h("div", {}, h("div", { class: "k" }, "The rule"), rule?.text ?? f.rule),
        h("div", {}, h("div", { class: "k" }, "What the watcher found"), f.summary),
        h("div", {}, h("div", { class: "k" }, "In the record"), entryLinks(f.entries)),
      ));
    }
    dims.append(row);
  }
  el.append(dims);

  const whatif = h("details", { class: "more" }, h("summary", {}, "What if the warn and pause levels were different?"));
  const warn = h("input", { type: "range", min: 0.05, max: 0.95, step: 0.05, value: t.warn, "aria-label": "Warn level" });
  const pause = h("input", { type: "range", min: 0.1, max: 1, step: 0.05, value: t.pause, "aria-label": "Pause level" });
  const out = h("span", { class: "mono" }, `warn ${t.warn}, pause ${t.pause}`);
  const apply = () => {
    state.thresholds = { warn: Number(warn.value), pause: Math.max(Number(pause.value), Number(warn.value)) };
    drawStory();
    drawMap();
    drawDetail();
  };
  warn.addEventListener("change", apply);
  pause.addEventListener("change", apply);
  whatif.append(h("div", { class: "whatif" }, h("label", {}, "Warn ", warn), h("label", {}, "Pause ", pause), out, h("button", { class: "link", type: "button", onclick: () => { state.thresholds = { ...m.thresholds }; apply(); } }, "Back to the charter values")), h("p", { class: "note" }, "This changes only what you see. The run used the levels of its charter."));
  if (state.thresholds.warn !== m.thresholds.warn || state.thresholds.pause !== m.thresholds.pause) whatif.open = true;

  const rows = [cp.first, ...cp.rescores].filter(Boolean);
  const readings = h("details", { class: "more" }, h("summary", {}, `Every reading of ${cp.id} (${rows.length})`),
    h("div", { class: "tablewrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Reading"), h("th", {}, "Charter"), h("th", { class: "num" }, "Drift"), h("th", {}, "Watcher"), h("th", { class: "num" }, "Cost"), h("th", {}, "Entry"))),
      h("tbody", {}, rows.map((r, i) => h("tr", {}, h("td", {}, i === 0 ? "first score" : r.body.status === "scored" ? "scored again" : "not scored again"), h("td", {}, `v${r.body.charter_version ?? 1}`), h("td", { class: "num" }, fmt(r.body.overall)), h("td", {}, r.body.judge_model ?? ""), h("td", { class: "num" }, money(r.body.usage?.cost_usd)), h("td", {}, h("button", { class: "link mono", type: "button", onclick: () => goToEntries([r.seq]) }, `#${r.seq}`))))),
    )));
  const over = h("details", { class: "more" }, h("summary", {}, "Drift over the whole run"), trend(m));
  el.append(liveWatcher(cp), whatif, readings, over, evidenceBox(cp));
}

/** Drift along the lineage of the active branch, with the warn and pause lines. */
function trend(m) {
  const line = m.lineageOf(m.activeBranch);
  const W = Math.max(320, line.length * 72);
  const H = 160;
  const x = (i) => 44 + i * ((W - 64) / Math.max(1, line.length - 1));
  const y = (v) => H - 28 - v * (H - 48);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `Drift over the run on branch ${m.activeBranch}` });
  for (const [name, v, c] of [["warn", state.thresholds.warn, "var(--warn-mark)"], ["pause", state.thresholds.pause, "var(--pause-mark)"]]) svg.append(s("line", { x1: 36, x2: W - 10, y1: y(v), y2: y(v), stroke: c, "stroke-dasharray": "3 4" }), s("text", { x: 0, y: y(v) + 4, class: "cp-stage" }, name));
  const pts = line.map((c, i) => ({ c, i, v: latestOverall(c) })).filter((p) => p.v !== null);
  if (pts.length > 1) svg.append(s("polyline", { points: pts.map((p) => `${x(p.i)},${y(p.v)}`).join(" "), fill: "none", stroke: "var(--muted)", "stroke-width": 1.5 }));
  line.forEach((c, i) => {
    const v = latestOverall(c);
    const lvl = levelFor(v, state.thresholds);
    svg.append(
      v === null ? s("circle", { cx: x(i), cy: y(0), r: 4, fill: "var(--surface)", stroke: "var(--none)", "stroke-width": 1.5 }) : s("circle", { cx: x(i), cy: y(v), r: c.id === state.selected ? 6.5 : 5, fill: `var(--${lvl === "ok" ? "ok" : lvl}-mark)` }, s("title", {}, `${c.id}: ${v}`)),
      s("text", { x: x(i), y: H - 8, "text-anchor": "middle", class: "cp-id" }, c.id),
    );
  });
  return h("div", { class: "map-scroll" }, svg);
}

function evidenceBox(cp) {
  const box = h("details", { class: "more" }, h("summary", {}, "The evidence the watcher read"));
  box.addEventListener("toggle", async () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = "1";
    const raw = cp.first?.body.bundle_json;
    let text = typeof raw === "string" ? raw : null;
    if (!text && raw?.$blob) text = await fetchText(`runs/${state.run.id}/blobs/${raw.$blob.replace("sha256:", "")}`).catch(() => null);
    if (!text) return box.append(h("p", { class: "note" }, "The stored evidence could not be read."));
    const bundle = JSON.parse(text);
    box.append(
      h("p", { class: "note" }, "Stored with the first score. Worker text sat in a data block the watcher is told never to follow, and the reasoning of the worker was never sent."),
      h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Entry"), h("th", {}, "Type"), h("th", {}, "What the watcher read"))), h("tbody", {}, bundle.evidence.map((r) => h("tr", {}, h("td", { class: "mono" }, `#${r.seq}`), h("td", {}, r.type), h("td", {}, short(r.body, 320))))))),
    );
  });
  return box;
}

function liveWatcher(cp) {
  const box = h("div", { class: "box", style: "margin-top:4px" }, h("h3", {}, "Ask the watcher again, with your own rule"));
  if (!cp.first) {
    box.append(h("p", { class: "note" }, "This checkpoint has no stored evidence, so it cannot be scored again."));
    return box;
  }
  const dim = h("select", { "aria-label": "Dimension of the rule" }, DIMENSIONS.map((d) => h("option", { value: d }, d)));
  dim.value = "scope";
  const text = h("input", { type: "text", maxlength: 300, placeholder: "Do not modify records that are not duplicates.", "aria-label": "Your rule" });
  const out = h("div", { class: "result", role: "status" });
  const button = h("button", { class: "btn primary", type: "button" }, "Score again, live");
  button.addEventListener("click", async () => {
    clear(out).append(h("p", { class: "note" }, "Asking the watcher…"));
    button.disabled = true;
    try {
      const res = await fetch("api/rescore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: state.run.id, checkpoint: cp.id, rule: { dimension: dim.value, text: text.value || text.placeholder } }) });
      const body = await res.json().catch(() => ({}));
      clear(out);
      if (!res.ok) return out.append(h("p", {}, res.status === 404 && !body.error ? "The live watcher is not available on this copy of the site." : body.error ?? `The watcher answered ${res.status}.`));
      const lvl = levelFor(body.overall, state.thresholds);
      out.append(
        h("p", {}, h("span", { class: "chip accent" }, "live"), " ", chipFor(lvl, body.overall), ` with your rule, against ${fmt(body.original?.overall)} recorded at the time.${body.cached ? " The same question was asked before." : ""}`),
        h("p", { class: "note mono" }, DIMENSIONS.map((d) => `${d} ${fmt(body.dimensions?.[d] ?? 0)}`).join(" · ")),
        (body.findings ?? []).map((f) => h("p", {}, h("strong", {}, `${f.rule}: `), f.summary)),
        h("p", { class: "note" }, `${body.note} ${body.judge_model}, ${money(body.usage?.cost_usd)}.`),
      );
    } catch {
      clear(out).append(h("p", {}, "The live watcher is not available on this copy of the site."));
    } finally {
      button.disabled = false;
    }
  });
  box.append(h("p", { class: "note" }, "The real watcher reads the same stored evidence again with your rule added. Its answer is labelled live and never changes the signed record."), h("div", { class: "form-row" }, dim, text, button), out);
  return box;
}

// ---- rules --------------------------------------------------------------------------------------------

function viewRules(el) {
  const m = state.model;
  const c = m.latestCharter;
  const table = (head, rows) => h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((x) => h("th", {}, x)))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((x) => h("td", {}, x)))))));
  el.append(h("p", { class: "sum" }, `The charter is the only part written for this job. Version ${c.version} is in force.`));

  el.append(h("h3", {}, "How the rules changed during the run"));
  if (!m.ruleChanges.length) el.append(h("p", { class: "note" }, "No rule was added."));
  else {
    const rescored = (v) =>
      m.checkpoints
        .flatMap((cp) => cp.rescores.filter((r) => r.body.charter_version === v && r.body.status === "scored").map((r) => `${cp.id} ${fmt(cp.first?.body.overall)} → ${fmt(r.body.overall)}`))
        .join(", ") || "none";
    el.append(
      table(
        ["Version", "Rule added", "Why", "Scored again", "Entry"],
        m.ruleChanges.map((e) => [`v${e.body.from_version} → v${e.body.version}`, e.body.rule?.text ?? "", e.body.source === "restart" ? "the lesson of a restart" : "added by the operator", rescored(e.body.version), h("button", { class: "link mono", type: "button", onclick: () => goToEntries([e.seq]) }, `#${e.seq}`)]),
      ),
    );
  }

  const findingsFor = (id) => m.entries.filter((e) => (e.type === "drift_score" || e.type === "rescore") && (e.body.findings ?? []).some((f) => f.rule === id)).length;
  el.append(h("h3", {}, "What the watcher scores against"), table(["Dimension", "Rule", "Findings"], c.drift_rules.map((r) => [r.dimension, r.text, String(findingsFor(r.id))])));

  el.append(
    h("h3", {}, "Checked before every tool call"),
    table(["Rule", "Setting"], [
      ["May change", c.scope.allow_paths.join(", ") || "nothing"],
      ["May never change", c.scope.deny_paths.join(", ") || "nothing"],
      ["May run", c.scope.allow_commands.join(" | ") || "nothing"],
      ["Network", c.scope.network ? "allowed" : "not allowed"],
      ["Budget", `${c.budget.max_cost_usd} dollars, ${c.budget.max_turns} turns, ${c.budget.max_minutes} minutes, across branches`],
      ["Held for a person", `${c.irreversible.join(" | ")}, until the operator approves that exact action once`],
      ["Warn and pause", `warn at ${c.thresholds.warn}, pause at ${c.thresholds.pause}. A pause stops every tool call until a person continues, adds a rule or restarts`],
    ]),
  );
  const strength = new Map(m.entries.filter((e) => e.type === "check_strength").map((e) => [e.body.check, e.body.status]));
  el.append(h("details", { class: "more" }, h("summary", {}, "Stages and their exit checks"), table(["Stage", "Exit checks"], c.stages.map((st) => [st.title, st.exit_checks.map((id) => `${id} (${strength.get(id) ?? "not tested"})`).join(", ") || "none"]))));
}

// ---- ledger -------------------------------------------------------------------------------------------

function viewLedger(el) {
  const m = state.model;
  const f = state.filters;
  const integrity = state.integrity;
  el.append(h("p", { class: "sum" }, "Every event, decision, score, rule change and restart, in order. Each entry holds the hash of the one before, and only the daemon writes it."));
  if (integrity) el.append(h("p", {}, h("span", { class: `state ${integrity.chain.ok && integrity.anchors.ok ? "ok" : "bad"}` }, icon(integrity.chain.ok ? "check" : "cross", 16), integrity.chain.ok ? `Chain intact, ${integrity.chain.entries} entries, ${integrity.anchors.anchors} anchors match` : integrity.chain.reason)));

  const opt = (values, current) => values.map((v) => h("option", { value: v, selected: v === current ? true : null }, v));
  const branchSel = h("select", { "aria-label": "Branch" }, opt(["all", ...m.branches.keys()], f.branch));
  const actorSel = h("select", { "aria-label": "Actor" }, opt(["all", "worker", "candord", "watcher", "operator"], f.actor));
  const typeSel = h("select", { "aria-label": "Entry type" }, opt(["all", ...new Set(m.entries.map((e) => e.type))].sort(), f.type));
  const search = h("input", { type: "text", value: f.text, placeholder: "Search", "aria-label": "Search" });
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
    h("div", { class: "filters" }, h("label", {}, "Branch ", branchSel), h("label", {}, "Actor ", actorSel), h("label", {}, "Type ", typeSel), search, h("label", {}, routine, " hide routine"),
      h("button", { class: "btn", type: "button", onclick: () => download(`${state.run.id}-ledger.csv`, csv(), "text/csv") }, "CSV"),
      h("button", { class: "btn", type: "button", onclick: () => download(`${state.run.id}-ledger.json`, JSON.stringify(rows, null, 1), "application/json") }, "JSON")),
    h("p", { class: "note" }, `${rows.length} of ${m.entries.length} entries. Select a row for the raw entry.`),
  );
  const body = h("tbody");
  for (const e of rows) {
    const tr = h("tr", { class: `row${state.cited.has(e.seq) ? " cited" : ""}`, tabindex: 0 }, h("td", { class: "num mono" }, String(e.seq)), h("td", { class: "mono" }, e.ts.slice(11, 19)), h("td", {}, e.branch ?? "A"), h("td", {}, e.actor), h("td", {}, describe(e)), h("td", { class: "mono" }, e.hash.slice(7, 15)));
    const toggle = () => {
      if (state.open.has(e.seq)) state.open.delete(e.seq);
      else state.open.add(e.seq);
      drawView();
    };
    tr.addEventListener("click", toggle);
    tr.addEventListener("keydown", (k) => k.key === "Enter" && toggle());
    body.append(tr);
    if (state.open.has(e.seq)) body.append(h("tr", {}, h("td", { colspan: 6 }, h("pre", { class: "raw" }, JSON.stringify(e, null, 2)))));
  }
  el.append(h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["#", "Time UTC", "Branch", "Actor", "What happened", "Hash"].map((x) => h("th", {}, x)))), body)));

  const reg = (title, list, render, empty) => h("details", { class: "more" }, h("summary", {}, `${title} (${list.length})`), list.length ? h("ul", { class: "plain" }, list.map((e) => h("li", {}, h("button", { class: "link mono", type: "button", onclick: () => goToEntries([e.seq]) }, `#${e.seq}`), " ", render(e)))) : h("p", { class: "note" }, empty));
  el.append(
    h("h3", {}, "Registers for a compliance owner"),
    reg("Held actions and approvals", [...m.held, ...m.approvals].sort((a, b) => a.seq - b.seq), (e) => (e.type === "tool_intent" ? `Held: ${e.body.summary}` : `Approved once, for that exact action, until ${e.body.expires_at}`), "No action was held."),
    reg("Effects outside the workspace", m.effects, (e) => describe(e), "None recorded."),
    reg("Rule changes and restarts", [...m.ruleChanges, ...m.restarts].sort((a, b) => a.seq - b.seq), (e) => describe(e), "None."),
    reg("Operator actions refused for lack of the secret", m.refused, (e) => describe(e), "None."),
    reg("Sessions and what was loaded", m.sessions, (e) => describe(e), "None."),
  );

  const seqInput = h("input", { type: "text", value: "40", "aria-label": "Entry to change", style: "width:6rem" });
  const out = h("div", { class: "result", role: "status" });
  const tamper = async () => {
    const n = Number(seqInput.value);
    if (!Number.isInteger(n) || n < 1 || n > state.lines.length) return clear(out).append(h("p", {}, `Give an entry from 1 to ${state.lines.length}.`));
    const copy = [...state.lines];
    const entry = JSON.parse(copy[n - 1]);
    entry.body = { ...entry.body, changed_by_reader: true };
    copy[n - 1] = canonicalJson(entry);
    const result = await verifyChain(copy);
    clear(out).append(h("p", {}, h("span", { class: `state ${result.ok ? "ok" : "bad"}` }, icon(result.ok ? "check" : "cross", 16), result.ok ? "The chain still verifies." : `Caught at entry ${result.firstBadSeq}. ${result.reason}`)), h("p", { class: "note" }, "Only the copy in this page was changed."));
  };
  el.append(h("h3", {}, "Try to tamper with it"), h("div", { class: "form-row" }, h("label", {}, "Change entry ", seqInput), h("button", { class: "btn", type: "button", onclick: tamper }, "and check again")), out);
}

// ---- receipt ------------------------------------------------------------------------------------------

function viewReceipt(el) {
  const r = state.model.receipt;
  const sig = state.integrity?.signature;
  const table = (head, rows) => h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((x) => h("th", {}, x)))), h("tbody", {}, rows.map((row) => h("tr", {}, row.map((x) => h("td", {}, x)))))));
  el.append(
    h("p", { class: "sum" }, "The document a reviewer who was not there approves from. Signed with Ed25519. Its two verdicts are at the top of this page."),
    h("h3", {}, "Each success criterion"),
    table(["Criterion", "Check", "Outcome"], (r.criteria ?? []).map((c) => [c.text, c.check ? `${c.check}${c.strength ? ` (${c.strength})` : ""}` : "no check", h("span", { class: `state ${c.status === "verified" ? "ok" : "bad"}` }, icon(c.status === "verified" ? "check" : "partly", 14), c.status === "verified" ? "verified" : "not verified")])),
  );
  if ((r.corrections ?? []).length) el.append(h("h3", {}, "Corrections"), h("ul", { class: "plain" }, r.corrections.map((c) => h("li", {}, c.detail))));
  const coverage = r.coverage ?? [];
  el.append(
    h("h3", {}, "What this run did not check"),
    h("ul", { class: "plain" }, coverage.slice(0, 4).map((c) => h("li", {}, c))),
    coverage.length > 4 ? h("details", { class: "more" }, h("summary", {}, `${coverage.length - 4} more`), h("ul", { class: "plain" }, coverage.slice(4).map((c) => h("li", {}, c)))) : null,
    h("details", { class: "more" }, h("summary", {}, "Limits of this receipt"), h("ul", { class: "plain" }, (r.limits ?? []).map((c) => h("li", {}, c)))),
    h("h3", {}, "Check it"),
    h("p", {}, sig ? h("span", { class: `state ${sig.ok ? "ok" : "bad"}` }, icon(sig.ok ? "check" : "cross", 16), sig.ok ? "Signature valid, checked in your browser" : sig.reason) : "Checking…"),
    h("pre", { class: "cmd" }, r.integrity?.command ?? "candor verify receipt.json --key-id <id>"),
    h("p", { class: "note" }, "Run that in the folder of the receipt to check it on your own machine."),
  );
  const area = h("textarea", { rows: 5, style: "width:100%", placeholder: "Paste a receipt.json here", "aria-label": "Receipt to verify" });
  const out = h("div", { class: "result", role: "status" });
  const check = async () => {
    let parsed;
    try {
      parsed = JSON.parse(area.value);
    } catch {
      return clear(out).append(h("p", {}, "That is not JSON."));
    }
    const result = await verifyReceiptSignature(parsed);
    clear(out).append(h("p", {}, h("span", { class: `state ${result.ok ? "ok" : "bad"}` }, icon(result.ok ? "check" : "cross", 16), result.ok ? `Valid signature, key ${result.keyId.slice(0, 19)}…` : result.reason)));
  };
  el.append(
    h("details", { class: "more" }, h("summary", {}, "Verify a receipt here, or change one character and watch it fail"),
      h("div", { class: "form-row" }, h("button", { class: "btn", type: "button", onclick: () => (area.value = JSON.stringify(r, null, 1)) }, "Paste this receipt"), h("button", { class: "btn primary", type: "button", onclick: check }, "Verify")),
      area, out),
  );
}

start();
