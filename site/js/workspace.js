// The Candor workspace. A reader describes a job, Candor drafts a charter, the reader checks and approves it,
// and a real job runs under Candor: every action checked, each stage a checkpoint scored by the watcher, held
// steps decided here, restarts from a checkpoint, and a signed receipt at the end. The job runs on the server;
// this page only shows it and sends the decisions of the reader.

import { canonicalJson as canonicalLine } from "./canonical.js";
import { clear, download, fmt, h, money } from "./dom.js";
import { renderMap } from "./map.js";
import { buildModel, DIMENSIONS, describe, latestOverall, levelFor } from "./model.js";
import { tar } from "./tar.js";
import { verifyChain, verifyReceiptSignature } from "./verify.js";

const $ = (id) => document.getElementById(id);
/** Appends children, leaving out the empty ones, as h() does. */
const put = (el, ...nodes) => el.append(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false));
const state = { draft: null, input: null, files: {}, review: [], job: null, tab: "run", selected: null, open: null, polling: 0, seeded: false, live: true, busy: false, error: "" };
const SUGGESTED = "Move the invoices service from CommonJS to ES modules, with no change to its public functions.";
const HOLDS = [
  { value: "delete_file *", label: "Deleting any file" },
  { value: "write_file package.json", label: "Writing package.json" },
];

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `The server answered ${res.status}.`);
  return out;
}
async function get(path) {
  const res = await fetch(path);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `The server answered ${res.status}.`);
  return out;
}

// ---- start ------------------------------------------------------------------------------------------------

async function startPage() {
  const id = new URLSearchParams(location.search).get("job");
  try {
    const first = await post("api/charter/review", { input: {} });
    state.files = first.files;
  } catch {
    clear($("stream")).append(h("div", { class: "ws-empty" }, h("h1", {}, "The workspace is not running here"), h("p", {}, "On a laptop, run npm run build and then npm run site:serve. The hosted site runs it at /workspace.html.")));
    return;
  }
  if (id) {
    await poll(id);
    return;
  }
  draw();
}

// ---- the charter --------------------------------------------------------------------------------------------

async function draftCharter(goal) {
  state.busy = true;
  state.error = "";
  draw();
  try {
    const out = await post("api/charter/draft", { goal });
    state.draft = out;
    state.input = structuredClone(out.input);
    state.review = out.review;
    state.live = out.live;
    state.goalAsked = goal;
  } catch (e) {
    state.error = e.message;
  }
  state.busy = false;
  draw();
}

let reviewTimer = 0;
function changed() {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(async () => {
    try {
      const out = await post("api/charter/review", { input: state.input });
      state.review = out.review;
      state.draft = { ...state.draft, charter: out.charter, markdown: out.markdown };
      state.error = "";
    } catch (e) {
      state.error = e.message;
    }
    drawPane();
  }, 350);
}

async function approve() {
  state.busy = true;
  drawPane();
  try {
    const job = await post("api/job", { input: state.input, live: state.live, seededFault: state.seeded });
    history.replaceState(null, "", `?job=${job.id}`);
    state.job = job;
    state.tab = "run";
    state.busy = false;
    poll(job.id);
  } catch (e) {
    state.error = e.message;
    state.busy = false;
    drawPane();
  }
}

// ---- the job ----------------------------------------------------------------------------------------------

async function poll(id) {
  clearTimeout(state.polling);
  try {
    state.job = await get(`api/job/${id}`);
    state.error = "";
  } catch (e) {
    state.error = e.message;
  }
  draw();
  const s = state.job?.status;
  if (s === "running") state.polling = setTimeout(() => poll(id), 900);
  else if (s === "held" || s === "paused") state.polling = setTimeout(() => poll(id), 4000);
}

async function act(action) {
  if (!state.job) return;
  state.busy = true;
  draw();
  try {
    state.job = await post(`api/job/${state.job.id}/act`, { action });
    state.error = "";
  } catch (e) {
    state.error = e.message;
  }
  state.busy = false;
  poll(state.job.id);
}

const model = () => {
  const j = state.job;
  return buildModel({ entries: j.entries, charters: j.charters, receipt: j.receipt ?? { verdicts: {} }, meta: { id: j.id, label: j.mode } });
};
const charterNow = () => state.job?.charters.at(-1) ?? state.draft?.charter ?? null;

// ---- drawing ------------------------------------------------------------------------------------------------

function draw() {
  drawTree();
  drawTop();
  drawStream();
  drawComposer();
  drawNeeds();
  drawTabs();
  drawPane();
  const waiting = state.job?.status === "held" || state.job?.status === "paused";
  document.title = waiting ? "(1) Needs you · Candor workspace" : "Candor workspace";
  $("mode").textContent = state.job ? (state.job.mode === "live" ? "live: real Claude worker and watcher" : "scripted: no model is called") : state.draft ? (state.live ? "live models available" : "scripted: no API key here") : "";
}

function drawTree() {
  const files = state.job?.files ?? (state.draft ? { ...state.files, ".candor/charter.md": state.draft.markdown } : state.files);
  const original = state.job?.original ?? state.files;
  const deny = charterNow()?.scope.deny_paths ?? [];
  const never = (p) => deny.some((d) => (d.endsWith("/**") ? p.startsWith(d.slice(0, -2)) : p === d));
  const paths = [...new Set([...Object.keys(files), ...Object.keys(original)])].sort((a, b) => (a.startsWith(".candor") ? -1 : b.startsWith(".candor") ? 1 : a.localeCompare(b)));
  const tree = clear($("tree"));
  let dir = null;
  for (const p of paths) {
    const parts = p.split("/");
    const d = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    if (d !== dir) {
      dir = d;
      if (d) put(tree, h("li", { class: "dir" }, `${d}/`, never(`${d}/x`) ? h("span", { class: "tagr never" }, " never") : null));
    }
    const gone = !(p in files);
    const tag = p.startsWith(".candor/") ? (state.job ? h("span", { class: "tagr n" }, "charter") : h("span", { class: "tagr n" }, "new")) : gone ? h("span", { class: "tagr d" }, "D") : !(p in original) ? h("span", { class: "tagr n" }, "A") : files[p] !== original[p] ? h("span", { class: "tagr m" }, "M") : null;
    put(tree, h("li", {}, h("button", { type: "button", "aria-current": state.open === p ? "true" : "false", style: d ? "padding-left:18px" : "", onclick: () => openFile(p) }, h("span", { class: gone ? "gone" : "" }, parts.at(-1)), tag)));
  }
}

function openFile(path) {
  state.open = state.open === path ? null : path;
  const v = $("viewer");
  if (!state.open) {
    v.hidden = true;
    drawTree();
    return;
  }
  const files = state.job?.files ?? (state.draft ? { ...state.files, ".candor/charter.md": state.draft.markdown } : state.files);
  const original = state.job?.original ?? state.files;
  const now = files[path];
  const before = original[path];
  clear(v).append(
    h("div", { class: "ws-top", style: "padding:0 0 10px;border:0" }, h("b", {}, path), now === undefined ? h("span", { class: "chip pause" }, "deleted") : before === undefined ? h("span", { class: "chip ok" }, "new") : now !== before ? h("span", { class: "chip warn" }, "changed by the job") : null, h("span", { class: "grow" }), h("button", { class: "btn", type: "button", onclick: () => openFile(path) }, "Close")),
    now !== undefined ? h("pre", {}, now) : null,
    before !== undefined && now !== before ? h("details", { class: "more" }, h("summary", {}, "The file before the job"), h("pre", {}, before)) : null,
  );
  v.hidden = false;
  drawTree();
}

function drawTop() {
  const top = clear($("top"));
  const j = state.job;
  if (!j) {
    put(top, h("span", {}, state.draft ? "Check the charter on the right, then approve it to start." : "No job running"));
    return;
  }
  const charter = charterNow();
  const reported = j.entries.filter((e) => e.type === "stage_report" && (e.branch ?? "A") === j.branch).length;
  const word = { running: "Running", held: "Waiting for you", paused: "Paused by the watcher", done: "Done", stopped: "Stopped", failed: "Failed" }[j.status];
  put(top, [h("span", {}, h("span", { class: `dot ${j.status}` }), h("b", {}, word)), j.status === "running" || j.status === "held" ? h("span", {}, `Stage ${Math.min(reported + 1, charter.stages.length)} of ${charter.stages.length}`) : null, h("span", {}, `branch ${j.branch}`), h("span", { class: "grow" }), h("span", {}, `${j.turns} turns · ${money(j.cost.worker + j.cost.watcher)}`)].filter(Boolean));
}

/** The job as a stream: what the worker did, what Candor decided, each checkpoint and score. */
function drawStream() {
  const box = $("stream");
  // Follow the job: stay at the bottom unless the reader scrolled up to read.
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80 || box.scrollTop === 0;
  const el = clear(box);
  const j = state.job;
  if (!j) {
    if (!state.draft) {
      put(el, 
        h("div", { class: "ws-empty" }, h("h1", {}, "Describe the job"), h("p", {}, "Say what you want done to the invoices project below. Candor drafts a charter: what the job must achieve, the rules it is judged by, what it may touch, and what waits for you. You check it on the right, and the job starts when you approve it."), h("p", { class: "note" }, "The job runs a real worker on the files of the project. Candor checks every action before it runs, takes a checkpoint at the end of each stage, and has a separate watcher score it.")),
      );
    } else {
      put(el, h("div", { class: "ws-col" }, h("div", { class: "ws-user" }, h("div", {}, state.goalAsked)), h("div", { class: "ws-card accent" }, h("b", {}, "Candor drafted a charter from your request and the files of the project."), h("div", {}, state.draft.drafted_by === "model" ? "Claude wrote the draft. Check each part on the right, change what is wrong, then approve it." : "No model is available here, so this is the default charter of the demo. Change what you like on the right, then approve it."), state.draft.input.note ? h("div", { class: "s" }, state.draft.input.note) : null)));
    }
    return;
  }
  const col = h("div", { class: "ws-col" });
  put(col, h("div", { class: "ws-user" }, h("div", {}, charterNow().goal)));
  const stages = new Map(charterNow().stages.map((s) => [s.id, s]));
  let group = null;
  const flush = () => {
    if (!group) return;
    const allowed = group.filter((e) => e.body.decision === "allow");
    if (allowed.length) put(col, h("div", { class: "ws-ev" }, h("span", { class: "ws-who" }, "Worker"), h("span", {}, ...allowed.slice(0, 4).flatMap((e) => [h("span", { class: "ws-tool" }, e.body.summary), " "]), allowed.length > 4 ? `and ${allowed.length - 4} more` : "")));
    if (allowed.length) put(col, h("div", { class: "ws-ev" }, h("span", { class: "ws-who" }, "Candor"), h("span", { class: "ws-ok" }, `${allowed.length} ${allowed.length === 1 ? "action" : "actions"} checked against the charter, allowed`)));
    group = null;
  };
  for (const e of j.entries) {
    if (e.type === "tool_intent" && e.body.decision === "allow") {
      group ??= [];
      group.push(e);
      continue;
    }
    if (e.type === "tool_result" || e.type === "anchor" || e.type === "check_strength" || e.type === "charter_review" || (e.type === "check_result" && e.body.check === "budget")) continue;
    flush();
    if (e.type === "charter_approved") put(col, h("div", { class: "ws-stage" }, `Charter approved, version ${e.body.version}. The job starts.`));
    else if (e.type === "config_change") put(col, h("div", { class: "ws-card warn" }, h("b", {}, "Cut a corner is on. "), e.body.note));
    else if (e.type === "tool_intent" && e.body.decision === "deny") put(col, h("div", { class: "ws-ev" }, h("span", { class: "ws-who" }, "Candor"), h("span", {}, h("span", { class: "ws-no" }, "Refused "), h("span", { class: "ws-tool" }, e.body.summary), ` ${e.body.reason ?? ""}`)));
    else if (e.type === "tool_intent" && e.body.decision === "hold") {
      const open = j.pending?.seq === e.seq;
      put(col, h("div", { class: "ws-card warn ws-held" }, h("span", { class: "t" }, h("b", {}, open ? "Waiting for you. " : "Held for a person. "), "The worker asks to run ", h("span", { class: "ws-tool" }, e.body.summary), /^delete_file /.test(String(e.body.summary)) ? ", which cannot be undone inside the job." : ". The charter says it waits for a person."), open ? h("button", { class: "btn", type: "button", disabled: state.busy ? true : null, onclick: () => act({ kind: "deny" }) }, "Deny") : null, open ? h("button", { class: "btn primary", type: "button", disabled: state.busy ? true : null, onclick: () => act({ kind: "approve" }) }, "Approve") : null));
    } else if (e.type === "human_action") put(col, h("div", { class: "ws-ev" }, h("span", { class: "ws-who" }, "You"), h("span", {}, { approve: "Approved the held action, once.", deny: "Denied the held action.", continue: "Continued the job.", stop: "Stopped the job." }[e.body.action] ?? e.body.action)));
    else if (e.type === "stage_report") {
      const st = stages.get(e.body.stage);
      put(col, h("div", { class: "ws-stage" }, `Stage · ${st?.title ?? e.body.stage}`));
      put(col, h("div", { class: "ws-ev" }, h("span", { class: "ws-who" }, "Worker"), h("div", { class: "ws-say" }, e.body.summary, ...(e.body.deviations ?? []).map((d) => h("div", { class: "note" }, `Deviation: ${d}`)))));
    } else if (e.type === "checkpoint") {
      const score = j.entries.find((x) => x.type === "drift_score" && x.body.checkpoint === e.body.id);
      const checks = j.entries.filter((x) => x.type === "check_result" && x.body.checkpoint === e.body.id && typeof x.body.status === "string" && x.body.check !== "watcher_note");
      const lvl = score?.body.status === "scored" ? levelFor(score.body.overall, charterNow().thresholds) : null;
      const label = { stage_done: "", before_irreversible: " · before the held step", final: " · end of the job", restart: " · restart point" }[e.body.trigger] ?? "";
      put(col, 
        h("div", { class: `ws-card ${lvl === "warn" || lvl === "pause" ? lvl : ""}` }, h("button", { class: "link", type: "button", onclick: () => select(e.body.id) }, h("b", {}, `Checkpoint ${e.body.id}`)), h("span", { class: "s" }, label), " ", lvl ? h("span", { class: `chip ${lvl}` }, `${lvl === "ok" ? "on course" : lvl} ${fmt(score.body.overall)}`) : h("span", { class: "chip none" }, score ? (score.body.status === "unavailable" ? "watcher unavailable" : "not scored") : "scoring…"), h("div", { class: "s" }, checks.length ? checks.map((c) => `${c.body.status === "passed" ? "✓" : "✗"} ${c.body.check}`).join(" · ") : "no exit checks here"), score?.body.findings?.[0] ? h("div", { class: "s" }, `Watcher: ${score.body.findings[0].summary}`) : null),
      );
    } else if (e.type === "check_result" && e.body.check === "watcher_note") put(col, h("div", { class: "ws-ev" }, h("span", { class: "ws-who" }, "Candor"), h("span", {}, "Sent the worker a note with the finding. A warn does not stop the job.")));
    else if (e.type === "rule_change" && e.body.rule?.source !== "restart") put(col, h("div", { class: "ws-card accent" }, h("b", {}, `You added a rule. Charter version ${e.body.version}. `), e.body.rule?.text, h("div", { class: "s" }, "Every scored checkpoint of this branch is scored again under it. Both scores are kept.")));
    else if (e.type === "restart") put(col, h("div", { class: "ws-card accent" }, h("b", {}, `Restarted from ${e.body.from} as branch ${e.body.to_branch}. `), h("div", {}, `Your reason goes with it as a rule: "${e.body.reason}"`), h("div", { class: "s" }, `Branch ${e.body.from_branch} is kept for reference. The files and the conversation go back to ${e.body.from}.`)));
    else if (e.type === "run_end") put(col, h("div", { class: "ws-stage" }, `The job ended: ${e.body.reason}`));
  }
  flush();
  if (j.status === "running") put(col, h("div", { class: "ws-ev" }, h("span", { class: "ws-who" }, "Worker"), h("span", { class: "note" }, "working…")));
  if (j.status === "failed") put(col, h("div", { class: "ws-card pause" }, h("b", {}, "The job failed. "), j.statusReason));
  put(el, col);
  if (stick) el.scrollTop = el.scrollHeight;
}

function drawComposer() {
  const el = clear($("composer"));
  const j = state.job;
  if (j) {
    const active = j.status === "running" || j.status === "held" || j.status === "paused";
    put(el, h("div", { class: "ws-hint", style: "display:flex;gap:10px;align-items:center" }, h("span", {}, active ? "The job runs on its own. Candor stops it only when it needs a decision from you." : "This job has ended. Start a new one to try other rules."), h("span", { class: "grow", style: "flex:1" }), active ? h("button", { class: "btn", type: "button", onclick: () => act({ kind: "stop" }) }, "Stop the job") : h("button", { class: "btn", type: "button", onclick: () => (location.href = "workspace.html") }, "New job")));
    return;
  }
  const text = h("textarea", { "aria-label": "Describe the job", rows: 2, placeholder: SUGGESTED });
  text.value = state.goalAsked ?? SUGGESTED;
  const go = h("button", { class: "btn primary", type: "button", disabled: state.busy ? true : null, onclick: () => draftCharter(text.value.trim() || SUGGESTED) }, state.busy ? "Drafting…" : state.draft ? "Draft again" : "Draft the charter");
  put(el, h("div", { class: "ws-box" }, text, h("div", { class: "row" }, go)), h("div", { class: "ws-hint" }, "The project is fixed in this demo: a small invoices service in CommonJS. Your words shape the charter. ", state.error ? h("span", { class: "ws-no" }, state.error) : null));
}

function drawNeeds() {
  const el = clear($("needs"));
  const j = state.job;
  if (!j) return;
  if (j.status === "held") put(el, h("div", { class: "ws-needs" }, h("h3", {}, "Needs you: a step is waiting"), h("div", {}, `The worker wants to run ${j.pending?.tool ?? ""} ${j.pending?.path ?? ""}. The charter says this waits for your approval.`), h("div", { class: "acts" }, h("button", { class: "btn primary", type: "button", disabled: state.busy ? true : null, onclick: () => act({ kind: "approve" }) }, "Approve"), h("button", { class: "btn", type: "button", disabled: state.busy ? true : null, onclick: () => act({ kind: "deny" }) }, "Deny"))));
  if (j.status === "paused") put(el, h("div", { class: "ws-needs" }, h("h3", {}, "Needs you: the watcher paused the job"), h("div", {}, j.statusReason), h("div", { class: "acts" }, h("button", { class: "btn primary", type: "button", onclick: () => act({ kind: "continue" }) }, "Continue"), h("button", { class: "btn", type: "button", onclick: () => select(lastScored()?.id) }, "See why, add a rule or restart"))));
}
/** The checkpoint to show first: the first that warned or paused on the active branch, else the last scored. */
const lastScored = () => {
  const m = model();
  const t = charterNow().thresholds;
  const line = m.lineageOf(m.activeBranch);
  return line.find((c) => (latestOverall(c) ?? 0) >= t.warn) ?? [...line].reverse().find((c) => c.latest) ?? m.checkpoints.at(-1);
};
const TRIGGER_TITLES = { before_irreversible: "Before the held step", final: "End of the job", restart: "Restart point" };

function drawTabs() {
  const el = clear($("tabs"));
  if (!state.job) return;
  for (const [id, label] of [["run", "Run"], ["rules", "Rules"], ["ledger", "Ledger"], ["receipt", "Receipt"]]) put(el, h("button", { role: "tab", type: "button", "aria-selected": state.tab === id ? "true" : "false", onclick: () => {
          state.tab = id;
          drawPane();
          drawTabs();
        } }, label));
}

function select(id) {
  state.selected = id;
  state.tab = "run";
  drawTabs();
  drawPane();
}

function drawPane() {
  const el = clear($("pane"));
  if (!state.job) return state.draft ? charterEditor(el) : put(el, h("p", { class: "note" }, "Describe the job in the middle. Candor drafts a charter here for you to check and approve."));
  ({ run: paneRun, rules: paneRules, ledger: paneLedger, receipt: paneReceipt })[state.tab](el);
}

// ---- the charter editor -------------------------------------------------------------------------------------

function charterEditor(el) {
  const input = state.input;
  const charter = state.draft.charter;
  const set = (fn) => {
    fn(input);
    changed();
  };
  const sec = (n, title, sub, ...body) => h("section", { class: "ws-sec" }, h("h3", {}, `${n}. ${title}`), sub ? h("p", { class: "sub" }, sub) : null, ...body);

  const goal = h("textarea", { rows: 3, "aria-label": "Goal" });
  goal.value = input.goal ?? charter.goal;
  goal.addEventListener("change", () => set((i) => (i.goal = goal.value)));

  const crit = charter.success.map((s) => {
    const builtIn = s.check && !s.check.startsWith("custom-");
    return h("div", { class: "ws-crit" }, h("span", { class: "t" }, s.text), s.check ? h("span", { class: "badge strong", title: "This check failed on its planted fault, so it can fail." }, "strong check") : h("span", { class: "badge", title: "Nothing checks this, so the receipt will not claim it." }, "not claimed"), builtIn ? h("button", { class: "ws-x", type: "button", title: "Turn this check off", onclick: () => set((i) => (i.checks = { ...(i.checks ?? {}), [s.check]: false })) }, "×") : null);
  });
  const off = Object.entries(input.checks ?? {}).filter(([, v]) => v === false).map(([k]) => k);
  const customPaths = h("input", { type: "text", placeholder: "src/**", "aria-label": "Paths of a new check" });
  const customText = h("input", { type: "text", placeholder: "require(", "aria-label": "Text that must not appear" });

  const rules = (input.rules ?? []).map((r, i) => {
    const dim = h("select", { "aria-label": "Dimension" }, DIMENSIONS.map((d) => h("option", { value: d, selected: d === r.dimension ? true : null }, d)));
    const text = h("textarea", { rows: 2, "aria-label": "Rule" });
    text.value = r.text;
    dim.addEventListener("change", () => set((x) => (x.rules[i].dimension = dim.value)));
    text.addEventListener("change", () => set((x) => (x.rules[i].text = text.value)));
    return h("div", { class: "ws-rule" }, dim, text, h("button", { class: "ws-x", type: "button", title: "Remove this rule", onclick: () => set((x) => x.rules.splice(i, 1)) }, "×"));
  });

  const list = (key, label) => {
    const f = h("input", { type: "text", "aria-label": label });
    f.value = (input[key] ?? []).join(", ");
    f.addEventListener("change", () => set((i) => (i[key] = f.value.split(",").map((x) => x.trim()).filter(Boolean))));
    return h("label", {}, label, f);
  };
  const num = (key, label, step) => {
    const f = h("input", { type: "number", step, "aria-label": label });
    f.value = input[key] ?? (key === "warn" ? charter.thresholds.warn : key === "pause" ? charter.thresholds.pause : key === "max_turns" ? charter.budget.max_turns : charter.budget.max_cost_usd);
    f.addEventListener("change", () => set((i) => (i[key] = Number(f.value))));
    return h("label", {}, label, f);
  };
  const holds = HOLDS.map((o) => {
    const box = h("input", { type: "checkbox", checked: (input.hold ?? []).includes(o.value) ? true : null });
    box.addEventListener("change", () => set((i) => (i.hold = box.checked ? [...new Set([...(i.hold ?? []), o.value])] : (i.hold ?? []).filter((x) => x !== o.value))));
    return h("label", { style: "display:flex;gap:8px;align-items:center;color:var(--fg)" }, box, o.label);
  });
  const seeded = h("input", { type: "checkbox", checked: state.seeded ? true : null });
  seeded.addEventListener("change", () => (state.seeded = seeded.checked));
  const live = h("input", { type: "checkbox", checked: state.live ? true : null, disabled: state.draft.live ? null : true });
  live.addEventListener("change", () => (state.live = live.checked));

  put(el, 
    h("p", { style: "margin:0 0 12px" }, h("b", {}, "Check your charter. "), "This is what Candor holds the job to. Change what is wrong, then approve it. Candor writes it to .candor/charter.md in the project."),
    sec(1, "Goal", "What must be true at the end.", goal),
    sec(2, "Done when", "Each line is a success criterion. A strong check failed on a planted fault, so it can fail. A line with no check is not claimed by the receipt.", ...crit, off.length ? h("p", { class: "note" }, `Turned off: ${off.join(", ")}. `, h("button", { class: "link", type: "button", onclick: () => set((i) => (i.checks = {})) }, "Turn all back on")) : null, h("label", {}, "Add a check: no file under these paths contains this text", h("div", { class: "ws-pairs" }, customPaths, customText)), h("button", { class: "btn", type: "button", style: "margin-top:6px", onclick: () => customText.value.trim() && set((i) => (i.custom_checks = [...(i.custom_checks ?? []), { paths: (customPaths.value || "src/**").split(",").map((x) => x.trim()), text: customText.value.trim() }])) }, "Add check")),
    sec(3, "Rules the watcher scores against", "Plain sentences. A separate Claude model with no tools scores every checkpoint against them, on goal, scope, plan and evidence.", ...rules, h("button", { class: "link", type: "button", style: "margin-top:8px", onclick: () => set((i) => (i.rules = [...(i.rules ?? []), { dimension: "scope", text: "" }])) }, "+ Add a rule")),
    sec(4, "Scope", "Candor checks every write and delete against these before it happens.", list("allow", "May change"), list("deny", "May never change")),
    sec(5, "Needs your approval", "These wait for you. A checkpoint is taken first, so the files can be restored.", ...holds),
    sec(6, "Limits", "Drift runs from 0, on course, to 1, off course.", h("div", { class: "ws-pairs" }, num("warn", "Warn at drift", "0.05"), num("pause", "Pause at drift", "0.05"), num("max_turns", "Worker turns at most", "5"), num("max_cost_usd", "Budget, US dollars", "0.1"))),
    sec(7, "How it runs", null, h("label", { style: "display:flex;gap:8px;align-items:center;color:var(--fg)" }, live, state.draft.live ? "A real Claude worker and watcher" : "A real Claude worker and watcher (needs an API key on the server)"), h("label", { style: "display:flex;gap:8px;align-items:flex-start;color:var(--fg)" }, seeded, h("span", {}, "Cut a corner", h("br"), h("span", { class: "note" }, "Tells the worker to make failing checks pass any way it can. It is written in the record, so the receipt shows the fault was seeded.")))),
    state.review.length ? h("section", { class: "ws-sec" }, h("h3", {}, "Candor's review of this charter"), h("ul", { class: "ws-flags" }, state.review.map((r) => h("li", {}, r.message))), h("p", { class: "note" }, "Approving accepts these. The record keeps the review.")) : null,
    state.error ? h("p", { class: "ws-no" }, state.error) : null,
    h("button", { class: "btn primary ws-start", type: "button", disabled: state.busy ? true : null, onclick: approve }, state.busy ? "Starting…" : "Approve the charter and start"),
    h("p", { class: "note" }, "Approving writes the hash of the charter as the first entry of the record. A later change is a new version, never an edit."),
  );
}

// ---- the run ------------------------------------------------------------------------------------------------

function verdictsBox(j) {
  if (!j.receipt) return null;
  const v = j.receipt.verdicts;
  const tone = (x) => (x === "yes" ? "ok" : x === "partly" ? "warn" : "pause");
  return h("div", { class: "ws-verdicts" }, h("div", { class: "ws-verdict" }, h("div", { class: "k" }, "Stayed on course"), h("div", { class: `v ${tone(v.stayed_on_course.verdict)}` }, v.stayed_on_course.verdict)), h("div", { class: "ws-verdict" }, h("div", { class: "k" }, "Result verified"), h("div", { class: `v ${tone(v.result_verified.verdict)}` }, v.result_verified.verdict)));
}

function paneRun(el) {
  const j = state.job;
  const m = model();
  const t = charterNow().thresholds;
  if (!state.selected || !m.byId.get(state.selected)) state.selected = lastScored()?.id ?? null;
  const mapBox = h("div", { id: "ws-map" });
  if (j.receipt) put(el, verdictsBox(j));
  put(el, h("h3", { style: "margin:0 0 6px" }, "Run map"), h("div", { class: "ws-mapwrap" }, mapBox), h("p", { class: "note" }, "Circles can be restarted from, squares are record only. Click a checkpoint to see why it scored what it did."));
  if (m.checkpoints.length) requestAnimationFrame(() => renderMap(mapBox, m, { thresholds: t, selected: state.selected, suggestion: null, onSelect: select, onMenu: (id) => select(id), stageTitle: (cp) => (cp.trigger === "restart" ? TRIGGER_TITLES.restart : (m.stageOf(cp.stage)?.title ?? TRIGGER_TITLES[cp.trigger] ?? cp.trigger)), noteSent: (cp) => j.entries.some((e) => e.type === "check_result" && e.body.check === "watcher_note" && e.body.checkpoint === cp.id) }));
  const cp = m.byId.get(state.selected);
  if (!cp) return;
  const latest = latestOverall(cp);
  const lvl = levelFor(latest, t);
  const charter = m.charterByVersion.get(cp.latest?.body.charter_version ?? 1) ?? m.latestCharter;
  const report = m.reportFor(cp);
  put(el, h("h3", { style: "margin:16px 0 6px" }, `${cp.id} · ${cp.trigger === "restart" ? TRIGGER_TITLES.restart : (m.stageOf(cp.stage)?.title ?? TRIGGER_TITLES[cp.trigger] ?? cp.trigger)} `, h("span", { class: `chip ${lvl === "not scored" ? "none" : lvl}` }, latest === null ? "not scored" : `${lvl === "ok" ? "on course" : lvl} ${fmt(latest)}`)));
  if (report) put(el, h("div", { class: "ws-sec" }, h("div", { class: "note" }, "The worker says"), h("div", {}, report.body.summary), ...(report.body.deviations ?? []).map((d) => h("div", { class: "note" }, `Deviation: ${d}`))));
  if (cp.latest) {
    const b = cp.latest.body;
    const dims = h("div", { class: "dims" });
    for (const d of DIMENSIONS) {
      const v = b.dimensions?.[d] ?? 0;
      const dl = levelFor(v, t);
      const own = (b.findings ?? []).filter((f) => charter?.drift_rules.find((r) => r.id === f.rule)?.dimension === d);
      const row = h("div", { class: `dim${own.length ? " flagged" : ""}` }, h("div", { class: "dim-row" }, h("div", {}, h("div", { class: "dim-name" }, d[0].toUpperCase() + d.slice(1))), h("span", { class: "track" }, h("span", { class: "fill", style: `width:${Math.round(v * 100)}%;background:var(--${dl === "ok" ? "ok" : dl}-mark)` }), h("span", { class: "tick", style: `left:${t.warn * 100}%` }), h("span", { class: "tick", style: `left:${t.pause * 100}%` })), h("span", { class: "dim-v" }, fmt(v))));
      for (const f of own) {
        const rule = charter?.drift_rules.find((r) => r.id === f.rule);
        row.append(h("div", { class: "dim-body" }, h("div", {}, h("div", { class: "k" }, "Against the rule"), rule?.text ?? f.rule, h("div", { class: "k", style: "margin-top:6px" }, "What the watcher found"), f.summary, h("div", { class: "k", style: "margin-top:6px" }, "In the ledger"), f.entries.map((n) => `#${n}`).join(" "))));
      }
      dims.append(row);
    }
    put(el, h("div", { class: "note" }, `Why this score${cp.latest.type === "rescore" ? `, after the rules changed (charter version ${b.charter_version})` : ""}. ${cp.latest.body.judge_model === "scripted-watcher" ? "Scripted watcher." : `Watcher ${cp.latest.body.judge_model}.`}`), dims);
    if (cp.rescores.length && cp.first) put(el, h("p", { class: "note" }, `First score ${fmt(cp.first.body.overall)}, now ${fmt(latest)}. Both are kept in the ledger.`));
  } else put(el, h("p", { class: "note" }, cp.firstRecord?.body.message ?? "This checkpoint is not scored yet."));
  if (cp.checks.length) put(el, h("div", { class: "note", style: "margin:8px 0" }, cp.checks.map((c) => `${c.body.status === "passed" ? "✓" : "✗"} ${c.body.check}`).join(" · ")));

  const active = j.status !== "done" && j.status !== "stopped" && j.status !== "failed";
  // Add a rule, scored again.
  const dim = h("select", { "aria-label": "Dimension" }, DIMENSIONS.map((d) => h("option", { value: d, selected: d === "scope" ? true : null }, d)));
  const ruleText = h("input", { type: "text", placeholder: "Never try to change legacy/, not even to keep it loading.", "aria-label": "A new rule" });
  put(el, h("div", { class: "ws-sec" }, h("h3", {}, "Add a rule and score again"), h("p", { class: "sub" }, "A new charter version. Every scored checkpoint of this branch is scored again under it, and both scores are kept."), h("div", { class: "ws-form" }, h("div", { class: "ws-pairs", style: "grid-template-columns:110px 1fr" }, dim, ruleText), h("button", { class: "btn", type: "button", disabled: state.busy ? true : null, onclick: () => act({ kind: "rule", dimension: dim.value, text: ruleText.value || ruleText.placeholder }) }, state.busy ? "Scoring…" : "Add the rule"))));
  // Restart from here.
  if (cp.safety === "safe_to_restart") {
    const reason = h("input", { type: "text", placeholder: "Do not try to change legacy/. Report that it no longer loads.", "aria-label": "Why you restart" });
    put(el, h("div", { class: "ws-sec" }, h("h3", {}, `Restart from ${cp.id}`), h("p", { class: "sub" }, `A new branch from the files of ${cp.id} and the conversation up to it. Your reason becomes a rule. Branch ${cp.branch} is kept.`), h("div", { class: "ws-form" }, reason, h("button", { class: "btn", type: "button", disabled: state.busy ? true : null, onclick: () => act({ kind: "restart", from: cp.id, reason: reason.value || reason.placeholder }) }, "Restart from here"))));
  } else put(el, h("p", { class: "note" }, `${cp.id} is record only: an action that cannot be undone happened before it, so a restart has to start from an earlier checkpoint.`));
  if (!active) put(el, h("p", { class: "note" }, "The job has ended. A rule or a restart still works: a restart starts a new branch from that checkpoint."));
}

// ---- rules, ledger, receipt -----------------------------------------------------------------------------------

function paneRules(el) {
  const j = state.job;
  const c = charterNow();
  put(el, h("p", { class: "note" }, `Charter version ${c.version} is in force. `, h("button", { class: "link", type: "button", onclick: () => openFile(".candor/charter.md") }, "Open charter.md")));
  for (const d of DIMENSIONS) {
    const own = c.drift_rules.filter((r) => r.dimension === d);
    if (own.length) put(el, h("div", { class: "ws-sec" }, h("h3", {}, d[0].toUpperCase() + d.slice(1)), h("ul", { class: "plain" }, own.map((r) => h("li", {}, r.text, r.source === "restart" ? h("span", { class: "note" }, " · lesson of a restart") : r.id.startsWith("added-") ? h("span", { class: "note" }, " · added during the run") : null)))));
  }
  const changes = j.entries.filter((e) => e.type === "rule_change");
  put(el, h("h3", {}, "How the rules changed"), changes.length ? h("ul", { class: "plain" }, changes.map((e) => h("li", {}, `v${e.body.from_version} → v${e.body.version}: ${e.body.rule?.text}`))) : h("p", { class: "note" }, "No rule was added yet. Add one from a checkpoint on the Run tab."));
  const rescores = j.entries.filter((e) => e.type === "rescore" && e.body.status === "scored");
  if (rescores.length) put(el, h("h3", {}, "Scored again"), h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Checkpoint"), h("th", {}, "Before"), h("th", {}, "After"))), h("tbody", {}, rescores.map((e) => h("tr", {}, h("td", {}, e.body.checkpoint), h("td", {}, fmt(e.body.first?.overall)), h("td", {}, fmt(e.body.overall))))))));
}

async function paneLedger(el) {
  const j = state.job;
  const box = h("p", {}, "Checking the chain…");
  put(el, h("p", { class: "note" }, "Every event, decision, score, rule change and restart, in order. Each entry holds the hash of the one before. The same format as a local Candor run."), box);
  const rows = j.entries.filter((e) => e.type !== "anchor" && !(e.type === "check_result" && e.body.check === "budget"));
  put(el, h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Actor"), h("th", {}, "What happened"))), h("tbody", {}, rows.map((e) => h("tr", {}, h("td", { class: "mono" }, String(e.seq)), h("td", {}, e.actor), h("td", {}, describe(e))))))));
  // The view returns the entries parsed. Their canonical JSON is the stored line, so the chain is checked on it.
  const result = await verifyChain(j.entries.map((e) => canonicalLine(e)));
  clear(box).append(h("span", { class: `state ${result.ok ? "ok" : "bad"}` }, result.ok ? `Chain intact: ${result.entries} entries, ${j.anchors.length} anchors, checked in your browser.` : result.reason));
}

/** One archive with the files `candor verify` reads: the ledger, the anchors, the blobs and the receipt. */
async function downloadBundle(j) {
  const d = await get(`api/job/${j.id}/download`);
  const files = { "ledger.jsonl": d["ledger.jsonl"], "anchors.jsonl": d["anchors.jsonl"], "receipt.json": `${JSON.stringify(d["receipt.json"], null, 1)}\n`, "charter.md": d["charter.md"] ?? "" };
  for (const [hex, text] of Object.entries(d.blobs ?? {})) files[`blobs/${hex}`] = text;
  const url = URL.createObjectURL(tar(files));
  const a = h("a", { href: url, download: `${j.id}.tar` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function paneReceipt(el) {
  const j = state.job;
  const r = j.receipt;
  if (!r) {
    put(el, h("p", { class: "note" }, "The receipt is written and signed when the job ends."));
    return;
  }
  put(el, verdictsBox(j), h("h3", {}, "Each success criterion"), h("div", { class: "tablewrap" }, h("table", {}, h("tbody", {}, r.criteria.map((c) => h("tr", {}, h("td", {}, c.text), h("td", {}, h("span", { class: `state ${c.status === "verified" ? "ok" : "bad"}` }, c.status === "verified" ? "verified" : c.check ? "failed" : "not claimed, no check"))))))));
  put(el, h("h3", {}, "What this job did not check"), h("ul", { class: "plain" }, r.coverage.map((c) => h("li", {}, c))));
  const sig = h("p", {}, "Checking the signature…");
  put(el, h("h3", {}, "Check it"), sig, h("div", { class: "ws-form" }, h("button", { class: "btn primary", type: "button", onclick: () => downloadBundle(j) }, "Download the record (.tar)"), h("button", { class: "btn", type: "button", onclick: () => download(`${j.id}-receipt.json`, JSON.stringify(r, null, 1), "application/json") }, "Download the receipt only")));
  put(el, h("pre", { class: "cmd", style: "margin-top:8px" }, `tar -xf ${j.id}.tar\ncandor verify receipt.json --key-id ${r.signature?.key_id ?? "<key id>"}`), h("p", { class: "note" }, "The record has the same format as a local Candor run, so the command-line tool checks it. The signing key was made for this job."));
  const s = await verifyReceiptSignature(r);
  clear(sig).append(h("span", { class: `state ${s.ok ? "ok" : "bad"}` }, s.ok ? `Signature valid, key ${s.keyId.slice(0, 19)}…, checked in your browser.` : s.reason));
}

startPage();
