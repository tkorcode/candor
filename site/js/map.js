// The run map: branches as lanes, checkpoints as nodes, a drift bar above each node, the warn and pause lines,
// the restart edge with its reason, and the suggested restart point. Drawn as SVG from the run model.

import { s } from "./dom.js";
import { latestOverall, levelFor } from "./model.js";

const COL = 96;
const LEFT = 150;
const LANE = 150;
const TOP = 96;
const BAR = 56;

const levelColor = (level) => (level === "ok" ? "var(--ok-mark)" : level === "warn" ? "var(--warn-mark)" : level === "pause" ? "var(--pause-mark)" : "var(--none)");

export function renderMap(container, model, view) {
  const { thresholds, selected, suggestion, onSelect } = view;
  const laneOrder = [...model.branches.keys()];
  const laneY = (branch) => TOP + laneOrder.indexOf(branch) * LANE;
  const maxCol = Math.max(0, ...model.checkpoints.map((c) => c.column));
  const width = LEFT + (maxCol + 1) * COL + 90;
  const height = TOP + laneOrder.length * LANE - 40;
  const pos = (cp) => ({ x: LEFT + cp.column * COL, y: laneY(cp.branch) });
  const lineage = new Set(model.lineageOf(model.activeBranch).map((c) => c.id));

  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "group", "aria-label": `Run map with ${laneOrder.length} branches and ${model.checkpoints.length} checkpoints` });

  for (const branchId of laneOrder) {
    const b = model.branches.get(branchId);
    const y = laneY(branchId);
    const own = model.checkpoints.filter((c) => c.branch === branchId);
    svg.append(
      s("text", { x: 12, y: y - 4, class: "lane-label" }, `Branch ${branchId}`),
      s("text", { x: 12, y: y + 12, class: "lane-sub" }, b.superseded ? "superseded, kept" : "active"),
    );
    // The warn and pause lines, at the height a bar reaches for that score.
    const x0 = LEFT - 24;
    const x1 = LEFT + (maxCol + 1) * COL - 40;
    for (const [name, value, color] of [["warn", thresholds.warn, "var(--warn-mark)"], ["pause", thresholds.pause, "var(--pause-mark)"]]) {
      const ty = y - 18 - BAR * value;
      svg.append(s("line", { x1: x0, x2: x1, y1: ty, y2: ty, class: "thr", stroke: color }), s("text", { x: x1 + 4, y: ty + 3, class: "thr-label" }, `${name} ${value}`));
    }
    // The lane line. Past the point a later branch was forked from, a superseded lane is dashed.
    if (own.length > 0) {
      const first = pos(own[0]);
      const last = pos(own.at(-1));
      svg.append(s("line", { x1: first.x, x2: last.x, y1: y, y2: y, stroke: "currentColor", "stroke-width": 2, "stroke-dasharray": b.superseded ? "6 5" : null, opacity: b.superseded ? 0.55 : 0.8 }));
    }
    // The restart edge from the fork point to the first checkpoint of the branch, with its reason.
    if (b.from && model.byId.get(b.from)) {
      const from = pos(model.byId.get(b.from));
      const to = own[0] ? pos(own[0]) : { x: from.x + COL, y };
      const mid = (from.y + to.y) / 2;
      svg.append(s("path", { d: `M${from.x},${from.y + 12} C${from.x},${mid} ${to.x},${mid} ${to.x - 12},${to.y}`, fill: "none", stroke: "var(--accent)", "stroke-width": 2 }));
      const reason = (b.reason ?? "").length > 70 ? `${b.reason.slice(0, 70)}…` : (b.reason ?? "");
      svg.append(s("text", { x: from.x + 16, y: mid - 6, class: "fork-label" }, s("title", {}, b.reason ?? ""), `restart from ${b.from}: ${reason}`));
    }
  }

  for (const cp of model.checkpoints) {
    const { x, y } = pos(cp);
    const first = typeof cp.first?.body.overall === "number" ? cp.first.body.overall : null;
    const latest = latestOverall(cp);
    const level = levelFor(latest, thresholds);
    const g = s("g", {
      class: "node",
      tabindex: 0,
      role: "button",
      "aria-pressed": selected === cp.id ? "true" : "false",
      "aria-label": `Checkpoint ${cp.id}, stage ${cp.stage ?? "none"}, drift ${latest === null ? "not judged" : latest}, ${level}${suggestion?.checkpoint?.id === cp.id ? ", suggested restart point" : ""}`,
      onclick: () => onSelect(cp.id),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(cp.id);
        }
      },
    });
    // Bars: the first score solid, a later re-score as an outline beside it.
    if (first !== null) g.append(s("rect", { x: x - 6, y: y - 18 - BAR * first, width: 12, height: Math.max(1, BAR * first), rx: 2, fill: levelColor(levelFor(first, thresholds)), opacity: lineage.has(cp.id) ? 1 : 0.55 }));
    if (latest !== null && cp.latest !== cp.first) g.append(s("rect", { x: x + 8, y: y - 18 - BAR * latest, width: 8, height: Math.max(1, BAR * latest), rx: 2, fill: "none", stroke: levelColor(level), "stroke-width": 1.5 }, s("title", {}, `scored again: ${latest}`)));
    const isSquare = cp.safety === "record_only";
    const fill = latest === null ? "var(--surface)" : levelColor(level);
    const stroke = latest === null ? "var(--none)" : levelColor(level);
    if (isSquare) g.append(s("rect", { x: x - 10, y: y - 10, width: 20, height: 20, rx: 3, fill, stroke, "stroke-width": 2 }));
    else g.append(s("circle", { cx: x, cy: y, r: 10, fill, stroke, "stroke-width": 2 }));
    g.append(s("circle", { class: "ring", cx: x, cy: y, r: 16, fill: "none", stroke: selected === cp.id ? "var(--accent)" : "transparent", "stroke-width": 2.5 }));
    if (suggestion?.checkpoint?.id === cp.id) {
      g.append(s("circle", { cx: x, cy: y, r: 21, fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-dasharray": "4 3" }));
      g.append(s("text", { x, y: y - 26 - BAR * Math.max(first ?? 0, latest ?? 0), "text-anchor": "middle", class: "cp-stage", fill: "var(--accent)" }, "suggested restart"));
    }
    if (cp.trigger === "before_irreversible") g.append(s("text", { x, y: y + 48, "text-anchor": "middle", class: "cp-stage" }, "held for approval"));
    g.append(s("text", { x, y: y + 26, "text-anchor": "middle", class: "cp-id" }, cp.id), s("text", { x, y: y + 38, "text-anchor": "middle", class: "cp-stage" }, cp.stage ?? cp.trigger.replaceAll("_", " ")));
    svg.append(g);
  }
  container.replaceChildren(svg);
}

export function legendItems() {
  return [
    ["var(--ok-mark)", "on course (below warn)", false],
    ["var(--warn-mark)", "warn", false],
    ["var(--pause-mark)", "pause", false],
    ["var(--none)", "not judged", true],
  ];
}
