// A tiny element builder. Text is always added as text nodes, never as HTML, because ledger text is
// written by the worker and is untrusted.

const SVG = "http://www.w3.org/2000/svg";

function append(el, children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function setAttrs(el, attrs) {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    // Styles go through the CSS object model. The content security policy refuses style attributes.
    else if (key === "style") el.style.cssText = String(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG, tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

export const fmt = (n, digits = 2) => (typeof n === "number" ? n.toFixed(digits) : "not judged");
export const money = (n) => (typeof n === "number" ? `${n.toFixed(n < 0.1 ? 4 : 2)} dollars` : "unknown");

/** A level chip with its word, so colour is never the only signal. */
export const levelChip = (level) => h("span", { class: `chip ${level === "not judged" ? "none" : level}` }, level === "ok" ? "on course" : level);

/** A file download from data held in the page. */
export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
