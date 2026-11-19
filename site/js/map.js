// The run map: branches as lanes, checkpoints as nodes carrying their drift score and level, a circle for each
// checkpoint a person can restart from and a square for one that is record only, a lock on a step held for a
// person, and the fork with its reason.
// Drawn as SVG from the run model. Colour always comes with a number, a word or a shape.

import { s } from "./dom.js";
import { latestOverall, levelFor } from "./model.js";

const MIN_COL = 104;
const LEFT = 116;
const LANE = 150;
const TOP = 58;
const R = 17;

const tone = (level) => (level === "ok" ? "ok" : level === "warn" ? "warn" : level === "pause" ? "pause" : "none");
const short = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** A padlock, 12 px, centred on x, y. */
const lockGlyph = (x, y, color) =>
  s("g", { transform: `translate(${x - 6} ${y - 6}) scale(0.5)`, fill: "none", stroke: color, "stroke-width": 2.6, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, s("rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }), s("path", { d: "M8 11V7a4 4 0 0 1 8 0v4" }));

export function renderMap(container, model, view) {
  const { thresholds, selected, suggestion, onSelect, onMenu, stageTitle, noteSent } = view;
  const laneOrder = [...model.branches.keys()];
  const laneY = (branch) => TOP + 24 + laneOrder.indexOf(branch) * LANE;
  const maxCol = Math.max(0, ...model.checkpoints.map((c) => c.column));
  // Fill the width of the panel when there is room, and scroll sideways when there is not.
  const COL = Math.max(MIN_COL, Math.floor(((container.parentElement?.clientWidth ?? 0) - LEFT - 24) / (maxCol + 1)));
  const chars = Math.floor(COL / 7);
  const width = LEFT + (maxCol + 1) * COL + 4;
  const height = TOP + laneOrder.length * LANE - 10;
  const pos = (cp) => ({ x: LEFT + COL / 2 + cp.column * COL, y: laneY(cp.branch) });
  const approvedHeld = new Set(model.approvals.map((a) => a.body.held_seq));

  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "group", "aria-label": `Run map with ${laneOrder.length} branches and ${model.checkpoints.length} checkpoints` });

  for (const branchId of laneOrder) {
    const b = model.branches.get(branchId);
    const y = laneY(branchId);
    const own = model.checkpoints.filter((c) => c.branch === branchId);
    const replacedBy = [...model.branches.values()].find((x) => x.fromBranch === branchId)?.id;
    svg.append(
      s("text", { x: 8, y: y - 4, class: "lane-label" }, `Branch ${branchId}`),
      s("text", { x: 8, y: y + 13, class: "lane-sub" }, b.superseded ? (replacedBy ? `replaced by ${replacedBy}` : "kept") : "active"),
    );
    if (own.length > 0) {
      const first = pos(own[0]);
      const last = pos(own.at(-1));
      svg.append(s("line", { x1: first.x, x2: last.x, y1: y, y2: y, stroke: "var(--line)", "stroke-width": 3, "stroke-dasharray": b.superseded ? "2 7" : null, "stroke-linecap": "round" }));
    }
    // The restart edge from the fork point to the first checkpoint of the branch, with its reason. It leaves
    // the fork point below its labels and enters the new branch from the left, so it crosses no text.
    if (b.from && model.byId.get(b.from)) {
      const from = pos(model.byId.get(b.from));
      const to = own[0] ? pos(own[0]) : { x: from.x + COL, y };
      const startY = from.y + R + 54;
      const startX = from.x - COL * 0.3;
      svg.append(s("path", { d: `M${from.x - R - 9},${from.y} C${startX},${from.y} ${startX},${startY} ${startX},${startY + 10} L${startX},${to.y - 24} Q${startX},${to.y} ${startX + 24},${to.y} L${to.x - R - 4},${to.y}`, fill: "none", stroke: "var(--accent)", "stroke-width": 2 }), s("path", { d: `M${to.x - R - 10},${to.y - 5} L${to.x - R - 3},${to.y} L${to.x - R - 10},${to.y + 5}`, fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-linecap": "round" }));
      svg.append(s("text", { x: to.x - R, y: to.y - R - 28, class: "fork-label" }, s("title", {}, b.reason ?? ""), `Restart from ${b.from}: ${short(b.reason ?? "", Math.max(40, Math.floor((width - to.x) / 6.6)))}`));
    }
  }

  for (const cp of model.checkpoints) {
    const { x, y } = pos(cp);
    const latest = latestOverall(cp);
    const level = levelFor(latest, thresholds);
    const t = tone(level);
    const isSelected = selected === cp.id;
    const isSuggested = suggestion?.checkpoint?.id === cp.id;
    const rescored = cp.rescores.some((r) => r.body.status === "scored");
    const held = cp.trigger === "before_irreversible";
    const heldEntry = held ? model.held.find((e) => e.seq > cp.seq) : null;
    const approved = heldEntry ? approvedHeld.has(heldEntry.seq) || model.approvals.some((a) => a.seq > cp.seq) : false;
    const stage = stageTitle(cp);
    const g = s("g", {
      class: "node",
      tabindex: 0,
      role: "button",
      "data-cp": cp.id,
      "aria-pressed": isSelected ? "true" : "false",
      "aria-label": `${cp.id}, ${stage}, ${latest === null ? "not scored" : `drift ${latest}, ${level === "ok" ? "on course" : level}`}${cp.safety === "safe_to_restart" ? ", can restart here" : ", record only"}${held ? ", held for a person" : ""}${isSuggested ? ", suggested restart point" : ""}`,
      onclick: () => onSelect(cp.id),
      // Right-click, the context menu key or Shift F10 opens the actions of the checkpoint.
      oncontextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu?.(cp.id, e.clientX, e.clientY);
      },
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(cp.id);
        } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu?.(cp.id, r.left + r.width / 2, r.bottom);
        }
      },
    });
    g.append(s("circle", { class: "halo", cx: x, cy: y, r: R + 9, fill: "transparent" }));
    if (isSuggested) g.append(s("circle", { cx: x, cy: y, r: R + 8, fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-dasharray": "4 4" }));
    g.append(s("circle", { class: "ring", cx: x, cy: y, r: R + 5, fill: "none", stroke: isSelected ? "var(--accent)" : "transparent", "stroke-width": 2.5 }));
    const fill = latest === null ? "var(--surface)" : `var(--${t}-bg)`;
    const stroke = latest === null ? "var(--none)" : `var(--${t}-mark)`;
    if (cp.safety === "record_only") g.append(s("rect", { x: x - R, y: y - R, width: R * 2, height: R * 2, rx: 6, fill, stroke, "stroke-width": 2.5 }));
    else g.append(s("circle", { cx: x, cy: y, r: R, fill, stroke, "stroke-width": 2.5 }));
    g.append(s("text", { x, y: y + 4, "text-anchor": "middle", class: "cp-score", fill: latest === null ? "var(--muted)" : `var(--${t})` }, latest === null ? "–" : latest.toFixed(2)));
    if (rescored) {
      const first = typeof cp.first?.body.overall === "number" ? cp.first.body.overall.toFixed(2) : "none";
      g.append(s("circle", { cx: x + R - 2, cy: y - R + 2, r: 5.5, fill: "var(--fg)", stroke: "var(--surface)", "stroke-width": 2 }, s("title", {}, `Scored again after a rule change: ${latest} (first ${first})`)));
    }
    // The shape says whether a restart is possible: a circle can be restarted from, a square is record only.
    if (held) g.append(lockGlyph(x, y - R - 18, "var(--fg)"));
    g.append(
      s("text", { x, y: y + R + 17, "text-anchor": "middle", class: "cp-id" }, cp.id),
      s("text", { x, y: y + R + 32, "text-anchor": "middle", class: "cp-stage" }, s("title", {}, stage), short(stage, chars)),
    );
    if (held) g.append(s("text", { x, y: y + R + 47, "text-anchor": "middle", class: "cp-flag", fill: "var(--fg)" }, approved ? "held, approved" : "held for a person"));
    else if (noteSent?.(cp)) g.append(s("text", { x, y: y + R + 47, "text-anchor": "middle", class: "cp-flag", fill: `var(--${t})` }, "note sent to worker"));
    else if (isSuggested) g.append(s("text", { x, y: y + R + 47, "text-anchor": "middle", class: "cp-flag", fill: "var(--accent-text)" }, "suggested restart"));
    svg.append(g);
  }
  container.replaceChildren(svg);
}
