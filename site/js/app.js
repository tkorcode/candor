// Candor Console. Loads one recorded run, verifies it in the browser, and shows the verdicts, the run map with
// what happened, and four views: the selected checkpoint and why it scored what it did, the rules, the ledger
// and the receipt. Every value comes from the run files. Worker text is shown as text only.

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
  live: null,
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
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.("#cp-menu")) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
  let resize = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resize);
    resize = requestAnimationFrame(() => state.model && drawMap());
  });
  // The live watcher exists only where the endpoint is deployed. It answers a GET with 405, a static copy with 404.
  fetch("api/rescore", { method: "GET" })
    .then((r) => r.status === 405)
    .catch(() => false)
    .then((live) => {
      state.live = live;
      if (state.model && state.tab === "checkpoint") drawView();
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
  drawMap();
  drawDetail();
  checkIntegrity();
}

/** The plain name of the step a checkpoint closes. */
function stageTitle(cp) {
  const m = state.model;
  if (cp.stage) return m.stageOf(cp.stage)?.title ?? state.guide.find((g) => g.id === cp.stage)?.title ?? cp.stage;
  if (cp.trigger === "before_irreversible") return "Before the migration";
  if (cp.trigger === "final") return m.branches.get(cp.branch)?.superseded ? `End of branch ${cp.branch}` : "End of the run";
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

// ---- header and verdicts ------------------------------------------------------------------------------

function drawHeader() {
  const m = state.model;
  $("run-title").textContent = m.latestCharter?.goal ?? state.run.title;
  const meta = clear($("run-meta"));
  meta.append(
    h("span", { class: state.run.label === "live" ? "live" : "" }, state.run.label === "live" ? "Live run" : "Scripted run"),
    h("span", {}, `recorded ${state.run.started.slice(0, 10)}`),
    m.models.worker.length ? h("span", {}, `worker ${m.models.worker.join(", ")}`) : null,
    m.models.watcher.length ? h("span", {}, `watcher ${m.models.watcher.join(", ")}`) : null,
  );
}

function drawVerdicts() {
  const v = state.model.receipt.verdicts;
  const tone = (verdict) => (verdict === "yes" ? "ok" : verdict === "partly" ? "warn" : "pause");
  const word = (verdict) => (verdict === "yes" ? "Yes" : verdict === "no" ? "No" : verdict === "partly" ? "Partly" : verdict);
  const row = (label, verdict, why) =>
    h("div", { class: `verdict ${tone(verdict.verdict)}` }, h("span", { class: "icon" }, icon(verdict.verdict === "yes" ? "check" : verdict.verdict === "partly" ? "partly" : "cross", 14)), h("span", { class: "q" }, label), h("span", { class: "a" }, word(verdict.verdict)), h("span", { class: "why" }, why));
  const criteria = state.model.receipt.criteria ?? [];
  const verified = criteria.filter((c) => c.status === "verified").length;
  clear($("verdicts")).append(
    row("Stayed on course", v.stayed_on_course, v.stayed_on_course.verdict === "yes" ? "No pause left open, every stage passed its checks" : firstSentences(v.stayed_on_course.reasons?.[0], 1)),
    row("Result verified", v.result_verified, criteria.length ? `${verified} of ${criteria.length} success criteria proven` : firstSentences(v.result_verified.reasons?.[0], 1)),
  );
}

// ---- map ------------------------------------------------------------------------------------------------

const noteSent = (cp) => state.model.entries.some((e) => e.type === "check_result" && e.body.check === "watcher_note" && e.body.checkpoint === cp.id && e.body.event === "delivered");
const list = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** What the run map shows, in a few plain sentences built from the ledger, in the order it happened. */
function mapCaption() {
  const m = state.model;
  const parts = [];
  const stagesOf = (branch) => new Set(m.checkpoints.filter((c) => c.branch === branch && c.stage && c.trigger !== "restart").map((c) => c.stage)).size;
  const first = m.checkpoints[0];
  if (first) {
    const n = stagesOf(first.branch);
    parts.push({ seq: first.seq, text: `Branch ${first.branch} ran ${n} stage${n === 1 ? "" : "s"}${m.branches.get(first.branch)?.superseded ? " and stopped" : ""}.` });
  }
  for (const r of m.ruleChanges.filter((e) => e.body.source !== "restart")) {
    const again = m.checkpoints.filter((c) => c.rescores.some((x) => x.body.charter_version === r.body.version && x.body.status === "scored")).map((c) => c.id);
    parts.push({ seq: r.seq, text: `The operator added a rule${again.length ? `, and ${list(again)} ${again.length === 1 ? "was" : "were"} scored again` : ""}.` });
  }
  for (const r of m.restarts) {
    const n = stagesOf(r.body.to_branch);
    parts.push({ seq: r.seq, text: `The operator restarted from ${r.body.from}, which opened branch ${r.body.to_branch}. It ran ${n} stage${n === 1 ? "" : "s"} to the end.` });
  }
  for (const cp of m.checkpoints) {
    const level = levelFor(latestOverall(cp), state.thresholds);
    if (level === "warn" || level === "pause") parts.push({ seq: cp.seq + 0.5, text: `The watcher ${level === "pause" ? "paused the job" : "warned"} at ${cp.id}${noteSent(cp) ? " and sent the worker a note" : ""}.` });
  }
  for (const cp of m.checkpoints.filter((c) => c.trigger === "before_irreversible")) parts.push({ seq: cp.seq + 0.6, text: `${cp.id} waited for a person before an action that cannot be undone.` });
  return parts
    .sort((a, b) => a.seq - b.seq)
    .map((p) => p.text)
    .join(" ");
}

function drawMap() {
  const m = state.model;
  const suggestion = suggestRestart(m, state.thresholds);
  $("map-caption").textContent = mapCaption();
  const box = clear($("suggestion"));
  box.className = `suggestion ${suggestion.kind}`;
  box.append(h("span", {}, h("strong", {}, suggestion.kind === "suggested" ? `Suggested restart point: ${suggestion.checkpoint.id}. ` : "Restart point. "), suggestion.text));
  if (suggestion.kind === "suggested") box.append(h("button", { class: "link", type: "button", onclick: () => select(suggestion.checkpoint.id) }, `Open ${suggestion.checkpoint.id}`));
  drawLevels();
  renderMap($("map"), m, { thresholds: state.thresholds, selected: state.selected, suggestion, onSelect: select, onMenu: openMenu, stageTitle, noteSent });
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
    h("li", { class: "map-hint" }, "Right-click a checkpoint for actions"),
  );
}

/** The warn and pause levels, beside the map they colour. Changing them changes only what this page shows. */
function drawLevels() {
  const m = state.model;
  const t = state.thresholds;
  const changed = t.warn !== m.thresholds.warn || t.pause !== m.thresholds.pause;
  const warn = h("input", { type: "range", min: 0.05, max: 0.95, step: 0.05, value: t.warn, "aria-label": "Warn level" });
  const pause = h("input", { type: "range", min: 0.1, max: 1, step: 0.05, value: t.pause, "aria-label": "Pause level" });
  const apply = (next) => {
    state.thresholds = next;
    drawMap();
    drawDetail();
  };
  warn.addEventListener("change", () => apply({ warn: Number(warn.value), pause: Math.max(Number(pause.value), Number(warn.value)) }));
  pause.addEventListener("change", () => apply({ warn: Math.min(Number(warn.value), Number(pause.value)), pause: Number(pause.value) }));
  clear($("levels")).append(...[
    h("label", { title: "At or above this drift, Candor sends the worker a note and the job goes on." }, "Warn at ", warn, h("span", { class: "mono" }, t.warn.toFixed(2))),
    h("label", { title: "At or above this drift, every tool call waits for a person." }, "Pause at ", pause, h("span", { class: "mono" }, t.pause.toFixed(2))),
    changed ? h("span", { class: "changed" }, "What if: the run used ", `${m.thresholds.warn} and ${m.thresholds.pause}`, " ") : null,
    changed ? h("button", { class: "link", type: "button", onclick: () => apply({ ...m.thresholds }) }, "Back to the run") : null,
  ].filter(Boolean));
}

function select(id) {
  state.selected = id;
  if (state.tab !== "checkpoint") state.tab = "checkpoint";
  drawMap();
  drawDetail();
}

// ---- the actions menu of a checkpoint -----------------------------------------------------------------

function closeMenu() {
  document.getElementById("cp-menu")?.remove();
}

function toast(text) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

/** Opens the section of the checkpoint view with this id, and focuses its first field if it has one. */
function goToSection(id) {
  state.tab = "checkpoint";
  drawDetail();
  const target = document.getElementById(id);
  if (target?.tagName === "DETAILS") target.open = true;
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
  target?.querySelector("input")?.focus({ preventScroll: true });
}

function openMenu(id, x, y) {
  closeMenu();
  const m = state.model;
  const cp = m.byId.get(id);
  if (!cp) return;
  select(id);
  const command = `candor restart ${cp.id} --reason "<what went wrong>"`;
  const item = (label, action, enabled = true) =>
    h("button", { type: "button", role: "menuitem", disabled: enabled ? null : true, onclick: () => {
      closeMenu();
      action();
    } }, label);
  const menu = h("div", { class: "menu", role: "menu", id: "cp-menu", "aria-label": `Actions for ${cp.id}` },
    h("div", { class: "menu-head" }, `${cp.id} · ${stageTitle(cp)}`),
    item("Why this score", () => goToSection("why"), !!cp.latest),
    item("Ask the watcher again with a rule", () => goToSection("ask"), !!cp.first),
    item(cp.safety === "safe_to_restart" ? "Copy the restart command" : "Restart is not possible here", () => navigator.clipboard?.writeText(command).then(() => toast("Restart command copied. Run it on the machine running the job."), () => toast(command)), cp.safety === "safe_to_restart"),
    item("Show its entries in the ledger", () => goToEntries([cp.seq, ...m.windowOf(cp).map((e) => e.seq)])),
  );
  menu.style.cssText = `left:${x}px;top:${y}px`;
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 8) menu.style.left = `${Math.max(8, innerWidth - r.width - 8)}px`;
  if (r.bottom > innerHeight - 8) menu.style.top = `${Math.max(8, y - r.height)}px`;
  const buttons = [...menu.querySelectorAll("button:not([disabled])")];
  buttons[0]?.focus();
  menu.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === "Escape") {
      closeMenu();
      document.querySelector(`[data-cp="${cp.id}"]`)?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(i + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    } else if (e.key === "Tab") closeMenu();
  });
}

// ---- the selected checkpoint --------------------------------------------------------------------------

function drawDetail() {
  const m = state.model;
  const cp = m.byId.get(state.selected);
  const head = clear($("detail-head"));
  if (cp) {
    const latest = latestOverall(cp);
    const level = levelFor(latest, state.thresholds);
    const actions = h("button", { class: "btn", type: "button", "aria-haspopup": "menu", onclick: (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(cp.id, r.left, r.bottom + 6);
    } }, "Actions");
    head.append(
      h("h2", {}, `${cp.id} · ${stageTitle(cp)}`),
      chipFor(level, latest),
      h("span", { class: `chip ${cp.safety === "safe_to_restart" ? "accent" : "none"}` }, cp.safety === "safe_to_restart" ? "can restart here" : "record only"),
      h("span", { class: "chip" }, `branch ${cp.branch}`),
      h("span", { class: "grow" }),
      actions,
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
  drawDetail();
}

function drawView() {
  const views = { checkpoint: viewCheckpoint, rules: viewRules, ledger: viewLedger, receipt: viewReceipt };
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

/** One plain sentence on what this checkpoint closes, from the ledger. */
function whatHappened(cp) {
  const m = state.model;
  if (cp.trigger === "restart") return `Branch ${cp.branch} starts here, from the files of ${m.branches.get(cp.branch)?.from ?? "an earlier checkpoint"}. Nothing new was done yet, so there was nothing to score.`;
  if (cp.trigger === "before_irreversible") {
    // The hold and its checkpoint are written together, so take the held action nearest the checkpoint.
    const held = [...m.held].sort((a, b) => Math.abs(a.seq - cp.seq) - Math.abs(b.seq - cp.seq))[0];
    const approved = held && m.approvals.some((a) => a.body.held_seq === held.seq);
    if (held) return `The worker asked to run ${String(held.body.summary).replace(/^Bash: /, "")}, which cannot be undone. Candor held it for a person${approved ? ", and the operator approved it once" : ""}.`;
  }
  if (cp.firstRecord?.body.reason === "no_new_work") return "Nothing new was done since the last checkpoint, so there was nothing to score.";
  return null;
}

/** What one question of the watcher is checked against, taken from the charter in force for the score. */
function againstOf(d, charter) {
  const rules = (charter?.drift_rules ?? []).filter((r) => r.dimension === d).map((r) => r.text);
  const box = h("div", { class: "against" }, h("div", { class: "k" }, "Checked against, from the charter"));
  if (d === "goal") box.append(h("p", {}, h("strong", {}, "Goal: "), charter?.goal ?? ""));
  if (d === "scope") box.append(h("p", {}, h("strong", {}, "May change: "), charter?.scope.allow_paths.join(", ") || "nothing", h("br"), h("strong", {}, "May never change: "), charter?.scope.deny_paths.join(", ") || "nothing"));
  if (d === "plan") box.append(h("p", {}, h("strong", {}, "Stages, in order: "), (charter?.stages ?? []).map((s) => s.title).join(", ")));
  if (d === "evidence") box.append(h("p", {}, "The stage report of the worker, against the ledger entries recorded since the last checkpoint."));
  if (rules.length) box.append(h("div", { class: "k" }, "Rules"), h("ul", {}, rules.map((r) => h("li", {}, r))));
  return box;
}

function viewCheckpoint(el) {
  const m = state.model;
  const cp = m.byId.get(state.selected);
  if (!cp) return el.append(h("p", {}, "Select a checkpoint on the run map."));
  const report = m.reportFor(cp);
  const window = m.windowOf(cp);
  const actions = window.filter((e) => e.type === "tool_intent");
  const count = (d) => actions.filter((a) => a.body.decision === d).length;
  const reading = cp.latest;
  const latest = latestOverall(cp);
  const t = state.thresholds;
  const level = levelFor(latest, t);
  const charter = m.charterByVersion.get(reading?.body.charter_version ?? 1) ?? m.latestCharter;
  const dimensionOf = (f) => charter?.drift_rules.find((r) => r.id === f.rule)?.dimension ?? null;
  const finding = reading?.body.findings?.[0];

  // What happened, in one place: the alert when the watcher flagged it, otherwise one sentence.
  if (level === "warn" || level === "pause") {
    const did = level === "pause" ? "Candor paused the job. Every tool call waited until a person continued, added a rule or restarted." : noteSent(cp) ? "Candor sent the worker a note with this finding. A warn does not stop the job." : "A warn does not stop the job.";
    el.append(h("div", { class: `alert ${level}` }, h("h3", {}, finding && dimensionOf(finding) ? HEADLINE[dimensionOf(finding)] : `Drift reached ${level}`), finding ? h("p", {}, firstSentences(finding.summary, 2)) : null, h("p", { class: "did" }, did)));
  } else {
    const line = whatHappened(cp);
    if (line) el.append(h("p", { class: "lead" }, line));
  }

  // Why this score.
  const why = h("section", { id: "why" }, h("h3", {}, "Why this score"));
  if (!reading) why.append(h("p", { class: "note" }, `${cp.id} was not scored.`));
  else {
    const b = reading.body;
    why.append(h("p", { class: "sum" }, `A separate Claude model with no tools answers four questions from 0, on course, to 1, off course. The highest answer is the drift of the checkpoint.${reading.type === "rescore" ? ` These are the scores after the rules changed, charter version ${b.charter_version}.` : ""}`));
    const dims = h("div", { class: "dims" });
    for (const d of DIMENSIONS) {
      const v = b.dimensions?.[d] ?? 0;
      const dl = levelFor(v, t);
      const own = (b.findings ?? []).filter((f) => dimensionOf(f) === d);
      const row = h("details", { class: `dim${own.length || dl !== "ok" ? " flagged" : ""}`, open: own.length > 0 ? true : null },
        h("summary", { class: "dim-row" },
          h("div", {}, h("div", { class: "dim-name" }, d[0].toUpperCase() + d.slice(1)), h("div", { class: "dim-q" }, QUESTION[d])),
          h("span", { class: "track", role: "img", "aria-label": `${d} ${v}` }, h("span", { class: "fill", style: `width:${Math.round(v * 100)}%;background:var(--${dl === "ok" ? "ok" : dl}-mark)` }), h("span", { class: "tick", style: `left:${t.warn * 100}%` }), h("span", { class: "tick", style: `left:${t.pause * 100}%` })),
          h("span", { class: "dim-v" }, fmt(v)),
        ),
      );
      row.append(againstOf(d, charter));
      for (const f of own) {
        const rule = charter?.drift_rules.find((r) => r.id === f.rule);
        row.append(h("div", { class: "dim-body" }, h("div", {}, h("div", { class: "k" }, `What the watcher found, against: ${rule ? short(rule.text, 70) : f.rule}`), f.summary), h("div", {}, h("div", { class: "k" }, "In the record"), entryLinks(f.entries))));
      }
      dims.append(row);
    }
    why.append(dims);
  }
  el.append(why);

  // What the worker said, and what Candor checked.
  const says = h("div", { class: "box" }, h("h3", {}, "The worker reported"));
  if (report) {
    says.append(h("p", {}, report.body.summary ?? `Stage ${report.body.stage} ${report.body.done ? "done" : "not done"}.`));
    const dev = report.body.deviations ?? [];
    if (dev.length) says.append(h("div", { class: "note" }, "Deviations it named"), h("ul", { class: "plain" }, dev.map((d) => h("li", {}, d))));
  } else says.append(h("p", { class: "note" }, "No stage report here."));
  const found = h("div", { class: "box" }, h("h3", {}, "Candor checked"));
  found.append(
    h("dl", { class: "facts" },
      h("dt", {}, "Exit checks"), h("dd", {}, cp.checks.length ? cp.checks.map((c) => h("div", {}, h("span", { class: `state ${c.body.status === "passed" ? "ok" : "bad"}` }, icon(c.body.status === "passed" ? "check" : "cross", 14), c.body.check), c.body.strength ? h("span", { class: "note" }, ` · ${c.body.strength}`) : "")) : "none here"),
      h("dt", {}, "Worker actions"), h("dd", {}, `${count("allow")} allowed, ${count("deny")} refused, ${count("hold")} held for a person`),
      h("dt", {}, "Files changed"), h("dd", {}, cp.changedPaths.length ? cp.changedPaths.slice(0, 6).join(", ") + (cp.changedCount > 6 ? ` and ${cp.changedCount - 6} more` : "") : "none"),
    ),
  );
  found.append(h("p", { class: "explain" }, "Worker actions are the commands and file edits the worker asks Claude Code to make. Candor checks each one against the charter before it runs."));
  el.append(h("div", { class: "cols", style: "margin-top:16px" }, says, found));

  // What a person can do here.
  const restart = h("div", { class: "box wide" }, h("h3", {}, cp.safety === "safe_to_restart" ? "Restart from here" : "Record only"));
  if (cp.safety === "safe_to_restart") restart.append(h("p", {}, "Opens a new branch from the files of this checkpoint and forks the worker conversation here. The reason becomes a rule, and the old branch is kept. Only the operator can restart, on the machine running the job."), h("pre", { class: "cmd" }, `candor restart ${cp.id} --reason "<what went wrong>"`));
  else restart.append(h("p", {}, "An action that cannot be undone happened before this point, so a restart has to start from an earlier checkpoint."));
  el.append(restart, liveWatcher(cp));

  // Detail, folded away.
  const notable = window.filter((e) => !ROUTINE(e) && e.type !== "tool_result");
  const activity = h("details", { class: "more" }, h("summary", {}, `Everything recorded here (${notable.length} entries)`));
  activity.append(notable.length ? h("ul", { class: "plain" }, notable.slice(0, 20).map((e) => h("li", {}, h("span", { class: "mono note" }, `#${e.seq} `), describe(e)))) : h("p", { class: "note" }, "Nothing was recorded here."));
  if (notable.length > 20) activity.append(h("button", { class: "link", type: "button", onclick: () => goToEntries(notable.map((e) => e.seq)) }, `All ${notable.length} in the ledger`));

  const rows = [cp.first, ...cp.rescores].filter(Boolean);
  const readings = h("details", { class: "more" }, h("summary", {}, `Every score of ${cp.id} (${rows.length})`),
    h("div", { class: "tablewrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Score"), h("th", {}, "Charter"), h("th", { class: "num" }, "Drift"), h("th", {}, "Watcher"), h("th", { class: "num" }, "Cost"), h("th", {}, "Entry"))),
      h("tbody", {}, rows.map((r, i) => h("tr", {}, h("td", {}, i === 0 ? "first score" : r.body.status === "scored" ? "scored again" : "not scored again"), h("td", {}, `v${r.body.charter_version ?? 1}`), h("td", { class: "num" }, fmt(r.body.overall)), h("td", {}, r.body.judge_model ?? ""), h("td", { class: "num" }, money(r.body.usage?.cost_usd)), h("td", {}, h("button", { class: "link mono", type: "button", onclick: () => goToEntries([r.seq]) }, `#${r.seq}`))))),
    )));
  el.append(activity, readings, h("details", { class: "more" }, h("summary", {}, "Drift over the whole run"), trend(m)), evidenceBox(cp));
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
  const box = h("section", { class: "box wide", id: "ask" }, h("h3", {}, "Ask the watcher again, with your own rule"));
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
      if (!res.ok) return out.append(h("p", {}, res.status === 404 && !body.error ? "The live watcher runs only on the hosted console. This copy of the site has no live watcher." : (body.error ?? `The live watcher answered with status ${res.status}.`)));
      const lvl = levelFor(body.overall, state.thresholds);
      out.append(
        h("p", {}, h("span", { class: "chip accent" }, "live"), " ", chipFor(lvl, body.overall), ` with your rule, against ${fmt(body.original?.overall)} recorded at the time.${body.cached ? " The same question was asked before." : ""}`),
        h("p", { class: "note mono" }, DIMENSIONS.map((d) => `${d} ${fmt(body.dimensions?.[d] ?? 0)}`).join(" · ")),
        h("div", {}, (body.findings ?? []).map((f) => h("p", {}, h("strong", {}, `${f.rule}: `), f.summary))),
        h("p", { class: "note" }, `${body.note} ${body.judge_model}, ${money(body.usage?.cost_usd)}.`),
      );
    } catch (error) {
      clear(out).append(h("p", {}, `The request did not reach the live watcher: ${error instanceof Error ? error.message : String(error)}. The recorded scores are unchanged.`));
    } finally {
      button.disabled = state.live === false;
    }
  });
  const why = "It calls the real watcher model, on the evidence stored for this checkpoint, with your rule added to the charter. The answer is labelled live and is never added to the signed record.";
  if (state.live === false) {
    button.disabled = true;
    for (const f of [dim, text]) f.disabled = true;
    box.append(
      h("p", {}, h("strong", {}, "Runs only on the hosted console. "), `This copy of the site has no live watcher. There, ${why[0].toLowerCase()}${why.slice(1)}`),
      h("p", { class: "note" }, "On a machine running Candor, candor rule adds a rule to a real run and scores its checkpoints again."),
      h("div", { class: "form-row" }, dim, text, button),
    );
  } else box.append(h("p", { class: "note" }, state.live ? why : `Checking whether the live watcher is here… ${why}`), h("div", { class: "form-row" }, dim, text, button), out);
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
