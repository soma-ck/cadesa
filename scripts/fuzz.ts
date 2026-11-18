/**
 * Differential fuzzer: random valid Cadesa sources + fixtures, laid out by the engine and by
 * Chromium, compared box by box.
 *
 * The invariant: every box the engine reports with no error issue and no assumption matches
 * Chromium within the tolerance (x, y, w, h). Boxes the engine flags are excluded, and counted.
 *
 *   npm run fuzz -- --cases 2000 --seed 1 --workers 8
 *   npm run fuzz -- --minutes 60
 *   npm run fuzz -- --replay fuzz/failures          (re-check saved reproductions)
 *   npm run fuzz -- --seeds 17,42 --no-shrink       (re-run particular seeds)
 *   npm run fuzz -- --replay fixtures/fuzz --record (re-check and re-record Chromium's boxes)
 *
 * A mismatch is shrunk (delta debugging over widths, fixture nodes, text, props, overrides and
 * tokens) and saved to fuzz/failures/<hash>/{source.cadesa.yaml,fixture.html,style.css,report.txt,case.json,
 * chromium.json}. Moved to fixtures/fuzz/<name>/, a reproduction becomes a regression test
 * (test/fuzz-regressions.test.ts checks the engine against the recorded chromium.json).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { stringify } from "yaml";
import { compile } from "../src/compile.js";
import { layout, walk, type Layout } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { loadSource } from "../src/load.js";
import { findChrome } from "../src/metrics.js";
import { validate } from "../src/validate.js";

const { values: args } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    cases: { type: "string" },
    minutes: { type: "string" },
    workers: { type: "string", default: "8" },
    tolerance: { type: "string", default: "0.5" },
    out: { type: "string", default: "fuzz/failures" },
    seeds: { type: "string" },
    replay: { type: "string" },
    "no-shrink": { type: "boolean", default: false },
    record: { type: "boolean", default: false },
    "max-shrinks": { type: "string", default: "40" },
    quiet: { type: "boolean", default: false },
    font: { type: "string" },
  },
});

const ROOT = process.cwd();
const TOL = Number(args.tolerance);
/**
 * The font text is set in: --font "Family=path/to/font.woff2" (a variable font with a wght axis;
 * the engine needs metrics for it, bundled or on $CADESA_METRICS). Default: the bundled Inter.
 */
const [FONT_FAMILY, FONT_PATH] = (args.font ?? "Inter=fonts/InterVariable-latin.woff2").split("=");
const FONT_REL = `../../../${FONT_PATH}`;

// ------------------------------------------------------------------ random

function rng(seed: number) {
  let a = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    float: (lo: number, hi: number, dec: number) => Number((lo + next() * (hi - lo)).toFixed(dec)),
    chance: (p: number) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    weighted: <T>(xs: readonly [T, number][]): T => {
      let x = next() * xs.reduce((s, [, w]) => s + w, 0);
      for (const [v, w] of xs) if ((x -= w) < 0) return v;
      return xs[xs.length - 1][0];
    },
  };
  return r;
}
type Rng = ReturnType<typeof rng>;

// ------------------------------------------------------------------ case model

interface Word {
  w: string;
  /** Separator before the word (collapsible whitespace). */
  sep: string;
  tag?: string;
}
interface Text {
  wrapP: boolean;
  paras: Word[][][];
}
interface Node {
  tag: string;
  cls: string[];
  id: string;
  attrs: Record<string, string>;
  children: Node[];
  text?: Text;
  /** Loose text directly inside a container, next to its slots (a mistake users make). */
  stray?: string;
}
type Obj = Record<string, any>;
export interface Case {
  seed: number;
  doc: Obj;
  body: Node[];
  widths: number[];
}

const clone = <T>(x: T): T => structuredClone(x);

// ------------------------------------------------------------------ generator

const WORDS = [
  "the", "quick", "brown", "fox", "jumps", "over", "a", "lazy", "dog", "Pricing", "Settings", "account", "notifications",
  "Save", "Cancel", "team", "plan", "monthly", "billing", "update", "your", "profile", "and", "of", "to", "in", "is", "I",
  "well-known", "state-of-the-art", "e-mail", "Wi-Fi", "co-op", "café", "naïve", "déjà", "Écrire", "façade", "Über",
  "años", "Ærø", "Øresund", "Ça", "garçon", "Größe", "Straße", "¿qué?", "¡olé!", "€19", "$4.99", "100%", "2024",
  "4 000", "100 %", "non-breaking space", "10 km", "—", "–", "word—word", "1–3", "“quoted”",
  "it’s", "wait…", "(parens)", "[x]", "a/b", "Donaudampfschiffahrtsgesellschaft", "WWWWWW", "iiiiii",
  "AVATAR", "Tyrannosaurus", "fi", "ffl", "1,234.56", "—dash", "dash—", "A–Z", "x-", "-y", "--", "self\u00adcontained", "mid-2024",
];
// Words the engine flags (characters outside the measured set, contextual forms): rare, so that
// the boxes around them, which inherit the flag, don't crowd out the boxes that are compared.
const RARE_WORDS = ["œuvre", "日本", "→", "✓", "x@y.z", "3x4", "a*b"];

function genText(r: Rng, short: boolean): Text {
  const nWords = () => (short ? r.int(1, 4) : r.weighted([[r.int(1, 3), 3], [r.int(3, 12), 4], [r.int(12, 40), 2]]));
  const words = (): Word[] =>
    Array.from({ length: nWords() }, (_, i) => ({
      w: r.chance(0.003) ? r.pick(RARE_WORDS) : r.pick(WORDS),
      sep: i === 0 ? r.weighted([["", 8], [" ", 1], ["\n      ", 1]]) : r.weighted([[" ", 12], ["  ", 1], ["\n      ", 1]]),
      tag: r.chance(0.06) ? r.pick(["em", "strong", "a", "span", "b", "code"]) : undefined,
    }));
  const lines = () => Array.from({ length: r.weighted([[1, 8], [2, 2], [3, 1]]) }, words);
  const multi = !short && r.chance(0.15);
  return { wrapP: multi && r.chance(0.7), paras: Array.from({ length: multi ? r.int(2, 3) : 1 }, lines) };
}

type Kind = "box" | "text" | "media" | "empty";
type Parent = "page" | "stack" | "cluster" | "grid" | "layer" | "flow";

interface Gen {
  r: Rng;
  doc: Obj;
  comps: { name: string; kind: Kind; depth: number }[];
  ids: number;
  spaces: string[];
  sizes: string[];
  pcts: string[];
  colors: string[];
  roles: string[];
}

function lengthValue(r: Rng, lo: number, hi: number): string {
  return r.weighted([
    [`${r.int(lo, hi)}px`, 3],
    [`${Number((r.int(lo * 4, hi * 4) / 64).toFixed(4))}rem`, 2],
    [`${r.float(lo, hi, 2)}px`, 1],
    [`${r.float(lo / 16, hi / 16, 3)}rem`, 1],
  ]);
}

function genTokens(g: Gen) {
  const { r } = g;
  const space: Obj = {};
  const n = r.int(2, 6);
  for (let i = 1; i <= n; i++) space[`s${i}`] = r.chance(0.7) ? r.pick(["0.25rem", "0.5rem", "0.75rem", "1rem", "1.5rem", "2rem", "3rem", "4px", "6px", "10px", "12px", "20px"]) : lengthValue(r, 1, 48);
  const size: Obj = {};
  const m = r.int(3, 8);
  for (let i = 1; i <= m; i++)
    size[`z${i}`] = r.weighted([
      [`${r.int(2, 30)}rem`, 3],
      [lengthValue(r, 24, 900), 3],
      [`${r.int(30, 80)}rem`, 1],
      [lengthValue(r, 8, 80), 1],
    ]);
  const color = { ink: "#1e1b4b", paper: "#ffffff", accent: "#3730a3", line: "#d4d4d8" };
  const font: Obj = { inter: `${FONT_FAMILY}, sans-serif` };
  if (r.chance(0.1)) font.serif = "Georgia, serif";
  g.doc.tokens = { space, size, color, radius: { round: "8px" }, font, paint: { band: "linear-gradient(90deg, #3730a3, #0f766e)" }, shadow: { lift: "0 8px 24px #0002" } };
  g.spaces = Object.keys(space);
  g.sizes = Object.keys(size);
  // Percentage size tokens: widths, maxWidth and measure only (never a height or a grid minimum).
  const np = r.weighted([[0, 2], [1, 3], [2, 2], [3, 1]]);
  for (let i = 1; i <= np; i++)
    size[`p${i}`] = r.weighted([
      [`${r.pick([10, 20, 25, 30, 33.333, 40, 50, 60, 66.667, 75, 80, 90, 100])}%`, 3],
      [`${r.float(5, 100, 2)}%`, 2],
      [`${r.int(1, 100)}%`, 1],
    ]);
  g.pcts = Object.keys(size).filter((k) => k.startsWith("p"));
  g.colors = Object.keys(color);

  const text: Obj = {};
  const k = r.int(1, 4);
  for (let i = 1; i <= k; i++) {
    const role: Obj = {};
    const f = r.weighted<string | undefined>([["inter", 60], ["serif", font.serif ? 2 : 0], [undefined, 1]]);
    if (f) role.font = f;
    role.size = r.weighted([
      [`${r.pick([0.75, 0.8125, 0.875, 1, 1.125, 1.25, 1.5, 1.75, 2, 2.5, 3])}rem`, 4],
      [`${r.int(10, 56)}px`, 3],
      [`${r.float(10, 40, 2)}px`, 1],
    ]);
    role.weight = r.chance(0.6) ? r.pick([100, 200, 300, 400, 500, 600, 700, 800, 900]) : r.int(100, 900);
    role.lineHeight = r.chance(0.7) ? r.pick([1, 1.1, 1.15, 1.2, 1.25, 1.3, 1.333, 1.4, 1.5, 1.6, 1.75, 2]) : r.float(0.9, 2.2, 3);
    role.color = r.pick(["ink", "accent"]);
    if (r.chance(0.25)) role.letterSpacing = r.float(-0.05, 0.2, 3);
    if (r.chance(0.15)) role.transform = r.pick(["uppercase", "none"]);
    if (r.chance(0.1)) role.decoration = r.pick(["underline", "none"]);
    if (r.chance(0.2)) role.wrap = r.pick(["anywhere", "anywhere", "normal"]);
    text[`t${i}`] = role;
  }
  g.doc.text = text;
  g.roles = Object.keys(text);

  const nb = r.weighted([[0, 2], [1, 3], [2, 3], [3, 2]]);
  if (nb) {
    const bps: Obj = {};
    for (let i = 1; i <= nb; i++) bps[`bp${i}`] = r.chance(0.6) ? `${r.int(300, 1400)}px` : `${r.int(80, 360) / 4}rem`;
    g.doc.breakpoints = bps;
  }
  if (r.chance(0.3)) g.doc.page = { background: "paper" };
}

function genLayout(g: Gen, parentDepth: number): Obj {
  const { r } = g;
  const pattern = r.weighted([["stack", 4], ["cluster", 3], ["grid", 2], ["layer", 1.5], ["flow", 3.5]] as [string, number][]);
  const l: Obj = { pattern };
  if (pattern === "grid") l.min = r.pick(g.sizes);
  if (pattern !== "flow" && r.chance(0.7)) l.gap = r.pick(g.spaces);
  if (pattern !== "stack" && pattern !== "flow" && r.chance(0.5)) l.align = r.pick(["start", "center", "end", "stretch"]);
  void parentDepth;
  return l;
}

const inlineMargin = (m: unknown) => typeof m === "string" || (!!m && typeof m === "object" && ["inline", "left", "right"].some((k) => k in (m as Obj)));

/** Props for an element of `kind`. */
function genProps(g: Gen, kind: Kind, parent: Parent, override = false): Obj {
  const { r } = g;
  const p: Obj = {};
  const s = override ? 0.35 : 1; // overrides touch fewer props
  if (kind === "box") p.layout = genLayout(g, 0);
  if (kind === "text") p.text = r.pick(g.roles);
  if (kind === "box" && r.chance(0.04)) p.text = r.pick(g.roles);
  if (r.chance(0.4 * s))
    p.padding = r.chance(0.6) ? r.pick(g.spaces) : r.chance(0.5) ? { block: r.pick(g.spaces), inline: r.pick(g.spaces) } : r.chance(0.5) ? { block: r.pick(g.spaces) } : { inline: r.pick(g.spaces) };
  if (r.chance(0.3 * s)) p.background = r.pick(g.colors);
  if (r.chance(0.2 * s)) p.border = r.pick(g.colors);
  if (r.chance(0.15 * s)) p.radius = "round";
  if (r.chance(0.08 * s)) p.shadow = "lift";
  if (r.chance(0.08 * s)) p.backdrop = "band";
  const wantWidth = parent === "cluster" && kind !== "text" ? 0.97 : 0.2;
  // A width, maxWidth or measure: sometimes a percentage of the parent's width.
  const size = () => (g.pcts.length && r.chance(0.3) ? r.pick(g.pcts) : r.pick(g.sizes));
  if (r.chance(wantWidth * s)) p.width = r.chance(parent === "stack" ? 0.4 : parent === "cluster" ? 0.01 : 0.1) ? "fill" : size();
  if (r.chance((parent === "page" ? 0.35 : parent === "cluster" ? 0.02 : 0.12) * s)) p.maxWidth = size();
  if (r.chance(0.12 * s)) p.measure = size();
  // Margins: common in block flow (where they collapse), sometimes anywhere else.
  if (r.chance((parent === "flow" || parent === "page" ? 0.5 : 0.2) * s)) {
    const sp = () => r.pick(g.spaces);
    const block = !!p.maxWidth || r.chance(0.5);
    p.margin = block
      ? r.weighted<Obj>([[{ block: sp() }, 3], [{ top: sp() }, 2], [{ bottom: sp() }, 2], [{ top: sp(), bottom: sp() }, 2]])
      : r.weighted<Obj | string>([[sp(), 2], [{ block: sp(), inline: sp() }, 2], [{ inline: sp() }, 1], [{ left: sp() }, 1], [{ top: sp(), right: sp(), bottom: sp(), left: sp() }, 1], [{ inline: sp(), top: sp() }, 1]]);
  }
  if (kind === "media") {
    if (r.chance(0.85)) p.aspect = r.pick(["16:9", "4:3", "1:1", "3:2", "2:3", "21:9", 1.5, 0.75, "1.91:1"]);
    else if (r.chance(0.8)) p.height = r.pick(g.sizes);
    if (r.chance(0.5)) p.fit = r.pick(["cover", "contain"]);
  } else {
    if (r.chance((kind === "empty" ? 0.6 : 0.12) * s)) p.height = r.pick(g.sizes);
    else if (r.chance((kind === "box" ? 0.08 : 0.03) * s)) p.aspect = r.pick(["16:9", "4:3", "1:1", 2]);
  }
  if (kind === "text" && r.chance(0.25 * s)) p.textAlign = r.pick(["start", "center", "end"]);
  if (override) {
    // An override lists only some props: keep a random non-empty subset.
    const keys = Object.keys(p);
    const keep = keys.filter(() => r.chance(0.5));
    const out: Obj = {};
    for (const k of keep.length ? keep : [r.pick(keys)]) out[k] = p[k];
    if (out.aspect !== undefined && out.height !== undefined) delete out.height;
    if (out.maxWidth !== undefined && inlineMargin(out.margin)) delete out.margin;
    return out;
  }
  if (p.aspect !== undefined && p.height !== undefined) delete p.height;
  return p;
}

const SVGS = [
  (r: Rng) => `<svg xmlns="http://www.w3.org/2000/svg" width="${r.int(20, 1600)}" height="${r.int(20, 1600)}"><rect width="100%" height="100%" fill="#7c3aed"/></svg>`,
  (r: Rng) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r.int(10, 400)} ${r.int(10, 400)}"><circle cx="50%" cy="50%" r="40%" fill="#0f766e"/></svg>`,
  () => `<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f59e0b"/></svg>`,
];
const LOCAL = ["hero", "dawn", "seals", "glacier", "island"];

function imgAttrs(r: Rng): Record<string, string> {
  const a: Record<string, string> = {
    src: r.chance(0.8) ? `data:image/svg+xml,${encodeURIComponent(r.pick(SVGS)(r))}` : `../../../examples/landing/assets/${r.pick(LOCAL)}.svg`,
    alt: "",
  };
  if (r.chance(0.4)) {
    a.width = String(r.int(16, 1920));
    a.height = String(r.int(16, 1920));
  } else if (r.chance(0.1)) a.width = String(r.int(16, 1920));
  return a;
}

const BOX_TAGS = ["div", "div", "div", "section", "article", "header", "nav", "ul", "main", "footer", "aside", "figure"];
const TEXT_TAGS = ["p", "p", "p", "h1", "h2", "h3", "div", "span", "a", "button", "label", "li", "strong"];
const ROOT_BOX_TAGS = ["div", "section", "article", "header", "main", "footer"];
const ROOT_TEXT_TAGS = ["p", "h1", "h2", "div", "a", "span", "button"];

function tagFor(r: Rng, kind: Kind, page: boolean) {
  if (kind === "media") return "img";
  if (kind === "empty") return r.pick(["div", "span", "hr"]);
  if (kind === "box") return r.pick(page ? ROOT_BOX_TAGS : BOX_TAGS);
  return page ? r.weighted(ROOT_TEXT_TAGS.map((t, i) => [t, i < 4 ? 6 : 1] as [string, number])) : r.pick(TEXT_TAGS);
}

function newNode(g: Gen, tag: string, cls: string): Node {
  return { tag, cls: [cls], id: `n${++g.ids}`, attrs: {}, children: [] };
}

function genComponent(g: Gen, depth: number, parent: Parent): { name: string; kind: Kind } {
  const { r } = g;
  const kind: Kind = depth >= 3 ? r.pick(["text", "media"] as Kind[]) : r.weighted([["box", 8], ["text", 2], ["media", 1], ["empty", 0.3]] as [Kind, number][]);
  const name = `c${g.comps.length + 1}`;
  g.comps.push({ name, kind, depth });
  g.doc.styles[name] = { ...genProps(g, kind, parent), slots: {} };
  return { name, kind };
}

/** Kind of an existing slot (from its props). */
function slotKind(style: Obj, slot: string): Kind {
  return style.slots[slot].__kind;
}

function fill(g: Gen, node: Node, comp: string, kind: Kind, props: Obj, depth: number) {
  const { r } = g;
  if (kind === "text") {
    node.text = genText(r, node.tag === "button" || node.tag === "a" || r.chance(0.3));
    if (node.tag === "p") node.text.wrapP = false; // <p> inside <p> is not valid HTML; the parser splits it
  }
  else if (kind === "media") node.attrs = imgAttrs(r);
  else if (kind === "box") {
    const pattern: Parent = props.layout?.pattern ?? "stack";
    const n = pattern === "layer" ? r.int(1, 3) : pattern === "cluster" ? r.int(1, 6) : r.int(1, 4);
    const style = g.doc.styles[comp];
    if (r.chance(0.01)) node.stray = r.pick(WORDS);
    for (let i = 0; i < n; i++) {
      if (depth < 3 && r.chance(0.15)) {
        const existing = g.comps.filter((c) => c.depth > depth && c.name !== comp);
        const c = existing.length && r.chance(0.4) ? r.pick(existing) : genComponent(g, depth + 1, pattern);
        node.children.push(instance(g, c.name, depth + 1, false));
        continue;
      }
      const slots = Object.keys(style.slots);
      let slot: string;
      if (slots.length && r.chance(0.45)) slot = r.pick(slots);
      else {
        slot = `s${slots.length + 1}`;
        const k: Kind = depth >= 2 ? r.weighted([["text", 6], ["media", 1.5], ["empty", 0.7]] as [Kind, number][]) : r.weighted([["text", 6], ["box", 2.5], ["media", 1.5], ["empty", 0.7]] as [Kind, number][]);
        style.slots[slot] = { ...genProps(g, k, pattern), __kind: k };
      }
      const k = slotKind(style, slot);
      const child = newNode(g, tagFor(r, k, false), `ca-${comp}__${slot}`);
      fill(g, child, comp, k, style.slots[slot], depth + 1);
      node.children.push(child);
    }
  }
}

function instance(g: Gen, comp: string, depth: number, page: boolean): Node {
  const c = g.comps.find((x) => x.name === comp)!;
  const node = newNode(g, tagFor(g.r, c.kind, page), `ca-${comp}`);
  fill(g, node, comp, c.kind, g.doc.styles[comp], depth);
  return node;
}

function genOverrides(g: Gen) {
  const { r } = g;
  const bps = Object.keys(g.doc.breakpoints ?? {});
  if (!bps.length) return;
  for (const c of g.comps) {
    const style = g.doc.styles[c.name];
    const when: Obj = {};
    for (const bp of r.chance(0.5) ? [...bps].reverse() : bps) {
      if (!r.chance(0.55)) continue;
      const o: Obj = {};
      if (r.chance(0.6)) Object.assign(o, genProps(g, c.kind, "stack", true));
      // Usually an override keeps the pattern and changes its details (switching a box to a
      // cluster leaves children without widths, which the engine flags).
      if (o.layout && style.layout && r.chance(0.6)) o.layout = { ...o.layout, pattern: style.layout.pattern, ...(style.layout.pattern === "grid" ? { min: o.layout.min ?? style.layout.min } : {}) };
      if (o.layout && o.layout.pattern !== "grid") delete o.layout.min;
      if (o.layout?.pattern === "stack" || o.layout?.pattern === "flow") delete o.layout.align;
      if (o.layout?.pattern === "flow") delete o.layout.gap;
      const slots: Obj = {};
      for (const s of Object.keys(style.slots)) if (r.chance(0.35)) slots[s] = genProps(g, slotKind(style, s), "stack", true);
      if (Object.keys(slots).length) o.slots = slots;
      if (Object.keys(o).length) when[bp] = o;
    }
    if (Object.keys(when).length) style.when = when;
  }
}

export function genCase(seed: number): Case {
  const r = rng(seed);
  const g: Gen = { r, doc: { version: 1, styles: {} }, comps: [], ids: 0, spaces: [], sizes: [], pcts: [], colors: [], roles: [] };
  genTokens(g);
  const body: Node[] = [];
  const nRoots = r.weighted([[1, 5], [2, 3], [3, 1]]);
  for (let i = 0; i < nRoots; i++) {
    const reuse = g.comps.filter((c) => c.depth === 0);
    const c = reuse.length && r.chance(0.3) ? r.pick(reuse) : genComponent(g, 0, "page");
    body.push(instance(g, c.name, 0, true));
  }
  genOverrides(g);
  for (const s of Object.values(g.doc.styles) as Obj[]) {
    for (const sl of Object.values(s.slots) as Obj[]) delete sl.__kind;
    if (!Object.keys(s.slots).length) delete s.slots;
  }
  const widths = new Set<number>();
  const nw = r.int(2, 4);
  while (widths.size < nw) widths.add(r.int(260, 1600));
  for (const v of Object.values(g.doc.breakpoints ?? {}) as string[]) {
    const px = v.endsWith("rem") ? parseFloat(v) * 16 : parseFloat(v);
    if (r.chance(0.5)) {
      const w = r.chance(0.5) ? Math.floor(px) : Math.floor(px) + 1;
      if (w >= 260 && w <= 1600) widths.add(w);
    }
  }
  return { seed, doc: g.doc, body, widths: [...widths].sort((a, b) => a - b) };
}

// ------------------------------------------------------------------ serialization

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function textHtml(t: Text): string {
  const line = (ws: Word[]) => ws.map((w) => w.sep + (w.tag ? `<${w.tag}${w.tag === "a" ? ' href="#"' : ""}>${esc(w.w)}</${w.tag}>` : esc(w.w))).join("");
  const para = (p: Word[][]) => p.map(line).join("<br />");
  return t.wrapP ? t.paras.map((p) => `<p>${para(p)}</p>`).join("") : t.paras.map(para).join("<br />");
}

function nodeHtml(n: Node, indent: string): string {
  const attrs = [`class="${n.cls.join(" ")}"`, `data-fixture="${n.id}"`, ...Object.entries(n.attrs).map(([k, v]) => `${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)].join(" ");
  if (n.tag === "img" || n.tag === "hr") return `${indent}<${n.tag} ${attrs} />`;
  if (n.text) return `${indent}<${n.tag} ${attrs}>${textHtml(n.text)}</${n.tag}>`;
  if (!n.children.length) return `${indent}<${n.tag} ${attrs}></${n.tag}>`;
  return `${indent}<${n.tag} ${attrs}>${n.stray ? esc(n.stray) : ""}\n${n.children.map((k) => nodeHtml(k, indent + "  ")).join("\n")}\n${indent}</${n.tag}>`;
}

export function fixtureHtml(body: Node[]): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="style.css" />
    <style>
      @font-face { font-family: "${FONT_FAMILY}"; font-weight: 100 900; src: url("${FONT_REL}") format("woff2"); }
      body { margin: 0; }
    </style>
  </head>
  <body>
${body.map((n) => nodeHtml(n, "    ")).join("\n")}
  </body>
</html>
`;
}

export const sourceYaml = (doc: Obj) => stringify(doc, { lineWidth: 0 });

// ------------------------------------------------------------------ running a case

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface BoxResult {
  id: string;
  engine: Rect;
  chrome?: Rect;
  excluded: string | undefined;
  delta: number;
  lines?: number;
}
interface WidthResult {
  width: number;
  active: string[];
  boxes: BoxResult[];
  issues: string[];
}
interface CaseResult {
  valid: boolean;
  /** sha256 of the compiled stylesheet Chromium laid out with. */
  cssSha256?: string;
  invalid?: string;
  widths: WidthResult[];
  compared: number;
  excluded: number;
  mismatches: number;
}

const FILE = "fuzz/case.cadesa.yaml";

/** Engine side: validate, compile, lay out. Undefined when the source is invalid. */
function engineSide(yaml: string, html: string, widths: number[]) {
  const { model, diagnostics } = validate(loadSource(FILE, yaml));
  if (!model) return { invalid: diagnostics.map((d) => `${d.path}: ${d.message}`).join("; ") };
  const css = compile(model);
  const fixture = parseFixture("fixture.html", html);
  return { css, layouts: widths.map((w) => layout(model, fixture, w)) };
}

function excludedReason(l: Layout, id: string, assumptions: string[]): string | undefined {
  if (assumptions.length) return `assumption: ${assumptions[0]}`;
  const e = l.issues.find((i) => i.severity === "error" && i.id === id);
  return e ? `error: ${e.message}` : undefined;
}

const LOAD = `(async () => {
  await document.fonts.load('400 16px "${FONT_FAMILY}"');
  await document.fonts.ready;
  await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
  return document.fonts.check('16px "${FONT_FAMILY}"') && ![...document.fonts].some((f) => f.status === 'error');
})()`;
const RECTS = `(() => {
  const o = {};
  for (const el of document.querySelectorAll('[data-fixture]')) {
    const r = el.getBoundingClientRect();
    o[el.dataset.fixture] = { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  return o;
})()`;

async function chromeSide(page: Page, html: string, css: string, widths: number[]): Promise<Record<string, Rect>[]> {
  const doc = html.replace('<link rel="stylesheet" href="style.css" />', () => `<style>\n${css}</style>`);
  await page.setViewportSize({ width: widths[0], height: 800 });
  await page.setContent(doc, { waitUntil: "load" });
  if (!(await page.evaluate(LOAD))) throw new Error(`${FONT_FAMILY} did not load`);
  const out: Record<string, Rect>[] = [];
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 800 });
    out.push((await page.evaluate(RECTS)) as Record<string, Rect>);
  }
  return out;
}

async function runCase(page: Page, yaml: string, html: string, widths: number[]): Promise<CaseResult> {
  const eng = engineSide(yaml, html, widths);
  if (!("css" in eng)) return { valid: false, invalid: eng.invalid, widths: [], compared: 0, excluded: 0, mismatches: 0 };
  const rects = await chromeSide(page, html, eng.css!, widths);
  const res: CaseResult = { valid: true, cssSha256: cssHash(eng.css!), widths: [], compared: 0, excluded: 0, mismatches: 0 };
  eng.layouts!.forEach((l, i) => {
    const wr: WidthResult = { width: l.width, active: l.active, boxes: [], issues: l.issues.map((x) => `${x.severity} #${x.id}: ${x.message}`) };
    for (const b of walk(l.boxes)) {
      const c = rects[i][b.id];
      const excluded = excludedReason(l, b.id, b.assumptions);
      const delta = c ? Math.max(...(["x", "y", "w", "h"] as const).map((k) => Math.abs(b[k] - c[k]))) : Infinity;
      wr.boxes.push({ id: b.id, engine: { x: b.x, y: b.y, w: b.w, h: b.h }, chrome: c, excluded, delta, lines: b.lines?.length });
      if (excluded) res.excluded++;
      else {
        res.compared++;
        if (!(delta <= TOL)) res.mismatches++;
      }
    }
    res.widths.push(wr);
  });
  return res;
}

const caseYaml = (c: Case) => sourceYaml(c.doc);
const caseHtml = (c: Case) => fixtureHtml(c.body);

// ------------------------------------------------------------------ shrinking

function* nodePaths(nodes: Node[], prefix: number[] = []): Generator<number[]> {
  for (let i = 0; i < nodes.length; i++) {
    yield [...prefix, i];
    yield* nodePaths(nodes[i].children, [...prefix, i]);
  }
}
function nodeAt(body: Node[], path: number[]): Node {
  let n = body[path[0]];
  for (const i of path.slice(1)) n = n.children[i];
  return n;
}
function removeAt(body: Node[], path: number[]) {
  const list = path.length === 1 ? body : nodeAt(body, path.slice(0, -1)).children;
  list.splice(path.at(-1)!, 1);
}

const PROP_KEYS = new Set(["layout", "padding", "margin", "background", "backdrop", "border", "shadow", "radius", "maxWidth", "measure", "width", "height", "aspect", "fit", "text", "textAlign"]);

/** Every smaller variant of a case, biggest reductions first. */
function* candidates(c: Case): Generator<Case> {
  // widths
  if (c.widths.length > 1)
    for (const w of c.widths) {
      const k = clone(c);
      k.widths = [w];
      yield k;
    }
  // fixture nodes (whole subtrees), outermost first
  for (const p of nodePaths(c.body)) {
    const k = clone(c);
    removeAt(k.body, p);
    if (k.body.length) yield k;
  }
  // hoist: replace a node by one of its children of the same component
  for (const p of nodePaths(c.body)) {
    const n = nodeAt(c.body, p);
    for (let i = 0; i < n.children.length; i++) {
      if (p.length === 1 && !n.children[i].cls.some((x) => !x.includes("__"))) continue;
      const k = clone(c);
      const list = p.length === 1 ? k.body : nodeAt(k.body, p.slice(0, -1)).children;
      list.splice(p.at(-1)!, 1, clone(n.children[i]));
      yield k;
    }
  }
  // styles: when entries, when slot entries, props
  const styles = c.doc.styles as Obj;
  for (const [name, s] of Object.entries(styles)) {
    for (const bp of Object.keys(s.when ?? {})) {
      const k = clone(c);
      delete k.doc.styles[name].when[bp];
      if (!Object.keys(k.doc.styles[name].when).length) delete k.doc.styles[name].when;
      yield k;
    }
    for (const [bp, o] of Object.entries((s.when ?? {}) as Obj)) {
      for (const sl of Object.keys(o.slots ?? {})) {
        const k = clone(c);
        const ko = k.doc.styles[name].when[bp];
        delete ko.slots[sl];
        if (!Object.keys(ko.slots).length) delete ko.slots;
        yield k;
      }
    }
  }
  const propHolders = (doc: Obj): Obj[] => {
    const out: Obj[] = [];
    for (const s of Object.values(doc.styles as Obj)) {
      out.push(s);
      for (const sl of Object.values((s.slots ?? {}) as Obj)) out.push(sl);
      for (const o of Object.values((s.when ?? {}) as Obj)) {
        out.push(o);
        for (const sl of Object.values((o.slots ?? {}) as Obj)) out.push(sl);
      }
    }
    return out;
  };
  const holders = propHolders(c.doc);
  for (let h = 0; h < holders.length; h++) {
    for (const key of Object.keys(holders[h])) {
      if (!PROP_KEYS.has(key)) continue;
      const k = clone(c);
      delete propHolders(k.doc)[h][key];
      yield k;
      // simplify inside layout / padding
      const v = holders[h][key];
      if (v && typeof v === "object")
        for (const sub of Object.keys(v)) {
          if (sub === "pattern") continue;
          const k2 = clone(c);
          delete propHolders(k2.doc)[h][key][sub];
          yield k2;
        }
    }
  }
  // breakpoints (with their overrides)
  for (const bp of Object.keys(c.doc.breakpoints ?? {})) {
    const k = clone(c);
    delete k.doc.breakpoints[bp];
    if (!Object.keys(k.doc.breakpoints).length) delete k.doc.breakpoints;
    for (const s of Object.values(k.doc.styles as Obj)) if (s.when) {
      delete s.when[bp];
      if (!Object.keys(s.when).length) delete s.when;
    }
    yield k;
  }
  // text role details
  for (const [name, role] of Object.entries((c.doc.text ?? {}) as Obj))
    for (const key of ["letterSpacing", "transform", "decoration", "wrap"])
      if (key in role) {
        const k = clone(c);
        delete k.doc.text[name][key];
        yield k;
      }
  if (c.doc.page) {
    const k = clone(c);
    delete k.doc.page;
    yield k;
  }
  // text content
  for (const p of nodePaths(c.body)) {
    const t = nodeAt(c.body, p).text;
    if (!t) continue;
    const edit = (f: (t: Text) => void) => {
      const k = clone(c);
      f(nodeAt(k.body, p).text!);
      return k;
    };
    for (let i = 0; i < t.paras.length && t.paras.length > 1; i++) yield edit((x) => x.paras.splice(i, 1));
    if (t.wrapP) yield edit((x) => (x.wrapP = false));
    for (let i = 0; i < t.paras.length; i++)
      for (let j = 0; j < t.paras[i].length && t.paras[i].length > 1; j++) yield edit((x) => x.paras[i].splice(j, 1));
    for (let i = 0; i < t.paras.length; i++)
      for (let j = 0; j < t.paras[i].length; j++) {
        const ws = t.paras[i][j];
        // halves, then single words
        if (ws.length > 3) {
          const half = Math.floor(ws.length / 2);
          yield edit((x) => x.paras[i][j].splice(0, half));
          yield edit((x) => x.paras[i][j].splice(half));
        }
        for (let w = 0; w < ws.length && ws.length > 1; w++) yield edit((x) => x.paras[i][j].splice(w, 1));
        for (let w = 0; w < ws.length; w++) {
          if (ws[w].tag) yield edit((x) => delete x.paras[i][j][w].tag);
          if (ws[w].sep.length > 1) yield edit((x) => (x.paras[i][j][w].sep = j + w === 0 && i === 0 ? "" : " "));
        }
      }
  }
  // attributes
  for (const p of nodePaths(c.body)) {
    const n = nodeAt(c.body, p);
    if (n.stray) {
      const k = clone(c);
      delete nodeAt(k.body, p).stray;
      yield k;
    }
    for (const a of ["width", "height"])
      if (a in n.attrs) {
        const k = clone(c);
        delete nodeAt(k.body, p).attrs[a];
        yield k;
      }
    if (n.tag !== "div" && n.tag !== "img" && n.tag !== "hr") {
      const k = clone(c);
      nodeAt(k.body, p).tag = "div";
      yield k;
    }
  }
}

/** Remove tokens, roles, slots and components nothing uses (checked by revalidating). */
function prune(c: Case): Case {
  const used = new Set<string>();
  const visit = (ns: Node[]) => ns.forEach((n) => (n.cls.forEach((x) => used.add(x)), visit(n.children)));
  visit(c.body);
  const k = clone(c);
  const styles = k.doc.styles as Obj;
  for (const [name, s] of Object.entries(styles)) {
    if (![...used].some((u) => u === `ca-${name}`)) {
      delete styles[name];
      continue;
    }
    for (const sl of Object.keys(s.slots ?? {}))
      if (!used.has(`ca-${name}__${sl}`)) {
        delete s.slots[sl];
        for (const o of Object.values((s.when ?? {}) as Obj)) if (o.slots) {
          delete o.slots[sl];
          if (!Object.keys(o.slots).length) delete o.slots;
        }
      }
    if (s.slots && !Object.keys(s.slots).length) delete s.slots;
    for (const [bp, o] of Object.entries((s.when ?? {}) as Obj)) if (!Object.keys(o).length) delete s.when[bp];
    if (s.when && !Object.keys(s.when).length) delete s.when;
  }
  const ok = (x: Case) => !!validate(loadSource(FILE, caseYaml(x))).model;
  const tryDelete = (path: string[]) => {
    const t = clone(k);
    let o: Obj = t.doc;
    for (const p of path.slice(0, -1)) o = o[p];
    delete o[path.at(-1)!];
    if (ok(t)) {
      let o2: Obj = k.doc;
      for (const p of path.slice(0, -1)) o2 = o2[p];
      delete o2[path.at(-1)!];
    }
  };
  for (const name of Object.keys(k.doc.text ?? {})) tryDelete(["text", name]);
  for (const cat of Object.keys(k.doc.tokens ?? {})) for (const name of Object.keys(k.doc.tokens[cat])) tryDelete(["tokens", cat, name]);
  for (const cat of Object.keys(k.doc.tokens ?? {})) if (!Object.keys(k.doc.tokens[cat]).length) delete k.doc.tokens[cat];
  for (const bp of Object.keys(k.doc.breakpoints ?? {})) {
    const used = Object.values(k.doc.styles as Obj).some((s) => s.when && bp in s.when);
    if (!used) delete k.doc.breakpoints[bp];
  }
  if (k.doc.breakpoints && !Object.keys(k.doc.breakpoints).length) delete k.doc.breakpoints;
  return ok(k) ? k : c;
}

async function fails(page: Page, c: Case): Promise<boolean> {
  try {
    const r = await runCase(page, caseYaml(c), caseHtml(c), c.widths);
    return r.valid && r.mismatches > 0;
  } catch {
    return false;
  }
}

async function shrink(page: Page, c0: Case, budgetMs = 240_000): Promise<Case> {
  const t0 = Date.now();
  let cur = prune(c0);
  if (!(await fails(page, cur))) cur = c0;
  // keep only failing widths first
  const r = await runCase(page, caseYaml(cur), caseHtml(cur), cur.widths);
  const bad = r.widths.filter((w) => w.boxes.some((b) => !b.excluded && !(b.delta <= TOL))).map((w) => w.width);
  if (bad.length) cur = { ...cur, widths: bad };
  let changed = true;
  let start = 0;
  while (changed && Date.now() - t0 < budgetMs) {
    changed = false;
    let i = 0;
    for (const k of candidates(cur)) {
      if (i++ < start) continue;
      if (Date.now() - t0 > budgetMs) break;
      const pk = prune(k);
      if (await fails(page, pk)) {
        cur = pk;
        changed = true;
        start = Math.max(0, i - 1);
        break;
      }
    }
    if (!changed && start > 0) {
      start = 0;
      changed = true; // one more full pass from the top
      const before = caseYaml(cur) + caseHtml(cur);
      let improved = false;
      for (const k of candidates(cur)) {
        if (Date.now() - t0 > budgetMs) break;
        const pk = prune(k);
        if (await fails(page, pk)) {
          cur = pk;
          improved = true;
          break;
        }
      }
      if (!improved || before === caseYaml(cur) + caseHtml(cur)) changed = false;
    }
  }
  return cur;
}

// ------------------------------------------------------------------ reporting

const fmt = (r?: Rect) => (r ? `${+r.x.toFixed(3)},${+r.y.toFixed(3)} ${+r.w.toFixed(3)}×${+r.h.toFixed(3)}` : "missing");

function reportText(c: Case, r: CaseResult, note: string): string {
  const out = [`seed: ${c.seed}`, note, `widths: ${c.widths.join(",")}`, `tolerance: ±${TOL}px`, ""];
  for (const w of r.widths) {
    out.push(`${w.width}px${w.active.length ? ` (${w.active.join(", ")} active)` : ""}`);
    out.push("  box     engine (x,y w×h)                     chromium (x,y w×h)                   Δ");
    for (const b of w.boxes)
      out.push(
        `  ${b.excluded ? "≈" : b.delta <= TOL ? "✓" : "✖"} #${b.id.padEnd(5)} ${fmt(b.engine).padEnd(36)} ${fmt(b.chrome).padEnd(36)} ${Number.isFinite(b.delta) ? b.delta.toFixed(3) : "-"}${b.lines ? `  ${b.lines} line(s)` : ""}${b.excluded ? `  [excluded: ${b.excluded}]` : ""}`,
      );
    for (const i of w.issues) out.push(`  issue: ${i}`);
    out.push("");
  }
  return out.join("\n");
}

/** A rough fingerprint of what a minimal case contains, to group failures by likely cause. */
function signature(c: Case, r: CaseResult): string {
  const tags = new Set<string>();
  const walkN = (ns: Node[]) => ns.forEach((n) => (tags.add(n.tag), walkN(n.children)));
  walkN(c.body);
  const props = new Set<string>();
  const visit = (o: Obj) => {
    for (const [k, v] of Object.entries(o)) {
      if (k === "layout") props.add(`layout:${v.pattern}${v.align ? `/${v.align}` : ""}`);
      else if (PROP_KEYS.has(k)) props.add(k);
      else if (k === "slots" || k === "when") for (const x of Object.values(v as Obj)) visit(x);
    }
  };
  for (const s of Object.values(c.doc.styles as Obj)) visit(s);
  const bad = r.widths.flatMap((w) => w.boxes.filter((b) => !b.excluded && !(b.delta <= TOL)));
  const axes = new Set(bad.flatMap((b) => (["x", "y", "w", "h"] as const).filter((k) => !b.chrome || Math.abs(b.engine[k] - b.chrome[k]) > TOL)));
  return `[${[...tags].sort().join(" ")}] {${[...props].sort().join(" ")}} Δ${[...axes].join("")}`;
}

/** The stylesheet's hash, without its header comment (which names the source file). */
export const cssHash = (css: string) => createHash("sha256").update(css.replace(/^\/\*.*?\*\/\n/, "")).digest("hex");

/** Chromium's boxes per width, as recorded for regression tests. */
function chromiumJson(r: CaseResult): string {
  // The boxes hold for this stylesheet only: when the compiler's output changes, re-record.
  const out: Record<string, unknown> = { cssSha256: r.cssSha256 };
  for (const w of r.widths) out[w.width] = Object.fromEntries(w.boxes.filter((b) => b.chrome).map((b) => [b.id, b.chrome!]));
  return JSON.stringify(out, null, 1) + "\n";
}

function save(c: Case, r: CaseResult, outDir: string, note: string): string {
  const yaml = caseYaml(c);
  const html = caseHtml(c);
  const hash = createHash("sha256").update(yaml + html + c.widths.join(",")).digest("hex").slice(0, 10);
  const dir = join(outDir, hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source.cadesa.yaml"), yaml);
  writeFileSync(join(dir, "fixture.html"), html);
  const eng = engineSide(yaml, html, c.widths);
  if ("css" in eng) writeFileSync(join(dir, "style.css"), eng.css!);
  writeFileSync(join(dir, "report.txt"), reportText(c, r, note));
  writeFileSync(join(dir, "case.json"), JSON.stringify({ seed: c.seed, widths: c.widths }, null, 2) + "\n");
  writeFileSync(join(dir, "chromium.json"), chromiumJson(r));
  return hash;
}

// ------------------------------------------------------------------ browser plumbing

const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
async function startServer() {
  const server = createServer((req, res) => {
    const path = resolve(ROOT, "." + decodeURIComponent(new URL(req.url!, "http://x").pathname));
    if (path.startsWith(ROOT) && existsSync(path) && statSync(path).isFile())
      return void res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "max-age=3600" }).end(readFileSync(path));
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>fuzz</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function newWorkerPage(browser: Browser, base: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 800 } });
  const page = await ctx.newPage();
  // Relative URLs in the fixture (the font, local images) resolve as they do from fuzz/failures/<hash>/.
  await page.goto(`${base}/fuzz/failures/_/`);
  return page;
}

// ------------------------------------------------------------------ main

async function replay(browser: Browser, base: string, dirs: string[]) {
  const page = await newWorkerPage(browser, base);
  let bad = 0;
  for (const dir of dirs) {
    const yaml = readFileSync(join(dir, "source.cadesa.yaml"), "utf8");
    const html = readFileSync(join(dir, "fixture.html"), "utf8");
    const { widths, seed, flagged = [] } = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as { widths: number[]; seed?: number; flagged?: string[] };
    const r = await runCase(page, yaml, html, widths);
    // Boxes a case expects the engine to flag must be flagged at every width.
    const unflagged = flagged.filter((id) => r.widths.some((w) => w.boxes.some((b) => b.id === id && !b.excluded)));
    const status = !r.valid
      ? `invalid (${r.invalid})`
      : r.mismatches
        ? `✖ ${r.mismatches} mismatch(es)`
        : unflagged.length
          ? `✖ expected flagged: ${unflagged.join(", ")}`
          : `✓ ${r.compared} compared, ${r.excluded} excluded`;
    if (!r.valid || r.mismatches || unflagged.length) bad++;
    else if (args.record) writeFileSync(join(dir, "chromium.json"), chromiumJson(r));
    console.log(`${dir}: ${status}`);
    if (!args.quiet && r.mismatches) console.log(reportText({ seed: seed ?? 0, doc: {}, body: [], widths }, r, ""));
  }
  console.log(`\n${dirs.length - bad}/${dirs.length} reproductions agree with Chromium`);
  process.exitCode = bad ? 1 : 0;
}

async function main() {
  const executablePath = findChrome();
  const browser = await chromium.launch({ executablePath });
  const { server, base } = await startServer();
  try {
    if (args.replay) {
      const dirs = args.replay.split(",").flatMap((d) =>
        existsSync(join(d, "case.json")) ? [d] : readdirSync(d).map((x) => join(d, x)).filter((x) => existsSync(join(x, "case.json"))),
      );
      return await replay(browser, base, dirs.sort());
    }
    const seed0 = Number(args.seed);
    const explicit = args.seeds?.split(",").map(Number);
    const total = explicit?.length ?? (args.cases ? Number(args.cases) : Infinity);
    const deadline = args.minutes ? Date.now() + Number(args.minutes) * 60_000 : Infinity;
    if (total === Infinity && deadline === Infinity) throw new Error("give --cases, --minutes or --seeds");
    const nWorkers = Math.max(1, Number(args.workers));
    const maxShrinks = Number(args["max-shrinks"]);
    console.log(`browser: Chromium ${browser.version()} (${executablePath ?? "playwright bundled"}), ${nWorkers} workers, tolerance ±${TOL}px`);

    const reasons = new Map<string, number>();
    const stats = { cases: 0, invalid: 0, errors: 0, compared: 0, excluded: 0, failing: 0, widths: 0 };
    const failingSeeds: number[] = [];
    const distinct = new Map<string, { hash: string; seeds: number[]; signature: string }>();
    const signatures = new Map<string, number>();
    let shrinks = 0;
    let next = 0;
    const t0 = Date.now();
    let lastLog = t0;
    let minSeed = Infinity;
    let maxSeed = -Infinity;

    const worker = async () => {
      let page = await newWorkerPage(browser, base);
      for (;;) {
        if (next >= total || Date.now() > deadline) return;
        const i = next++;
        const seed = explicit ? explicit[i] : seed0 + i;
        const c = genCase(seed);
        let r: CaseResult;
        try {
          r = await runCase(page, caseYaml(c), caseHtml(c), c.widths);
        } catch (e) {
          stats.errors++;
          console.log(`seed ${seed}: browser error ${(e as Error).message.split("\n")[0]}`);
          await page.context().close().catch(() => {});
          page = await newWorkerPage(browser, base);
          continue;
        }
        minSeed = Math.min(minSeed, seed);
        maxSeed = Math.max(maxSeed, seed);
        stats.cases++;
        stats.widths += c.widths.length;
        if (!r.valid) {
          stats.invalid++;
          if (stats.invalid <= 5) console.log(`seed ${seed}: generator produced an invalid source: ${r.invalid}`);
          continue;
        }
        stats.compared += r.compared;
        stats.excluded += r.excluded;
        for (const w of r.widths)
          for (const b of w.boxes)
            if (b.excluded) {
              // Group by the root cause, not the box that inherited it.
              const k = b.excluded.replace(/^assumption: geometry depends on #\S+, which the engine can't guarantee \(/, "assumption: depends on ").replace(/#\S+/g, "#").replace(/\d+(\.\d+)?/g, "N").replace(/"[^"]*"/g, '"…"').slice(0, 110);
              reasons.set(k, (reasons.get(k) ?? 0) + 1);
            }
        if (r.mismatches) {
          stats.failing++;
          failingSeeds.push(seed);
          const sig0 = signature(c, r);
          if (args["no-shrink"] || shrinks >= maxShrinks) {
            console.log(`seed ${seed}: ✖ ${r.mismatches} mismatch(es) ${sig0} (not shrunk)`);
            continue;
          }
          shrinks++;
          const small = await shrink(page, c);
          const rs = await runCase(page, caseYaml(small), caseHtml(small), small.widths);
          const sig = signature(small, rs);
          const hash = save(small, rs, args.out!, `found by seed ${seed}, shrunk`);
          const d = distinct.get(hash) ?? { hash, seeds: [], signature: sig };
          d.seeds.push(seed);
          distinct.set(hash, d);
          signatures.set(sig, (signatures.get(sig) ?? 0) + 1);
          console.log(`seed ${seed}: ✖ ${r.mismatches} mismatch(es) → shrunk to ${args.out}/${hash} ${sig}`);
        }
        if (!args.quiet && Date.now() - lastLog > 30_000) {
          lastLog = Date.now();
          const mins = (Date.now() - t0) / 60_000;
          console.log(`… ${stats.cases} cases, ${stats.compared} boxes compared, ${stats.failing} failing (${Math.round(stats.cases / mins)} cases/min)`);
        }
      }
    };
    await Promise.all(Array.from({ length: nWorkers }, worker));

    const secs = (Date.now() - t0) / 1000;
    console.log(`\n── summary`);
    console.log(`cases run:         ${stats.cases} (seeds ${explicit ? explicit.join(",") : `${minSeed}–${maxSeed}`}), ${stats.widths} widths`);
    console.log(`boxes compared:    ${stats.compared}`);
    console.log(`excluded (flagged): ${stats.excluded}`);
    for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(v).padStart(7)}  ${k}`);
    console.log(`invalid sources:   ${stats.invalid}`);
    console.log(`browser errors:    ${stats.errors}`);
    console.log(`failing cases:     ${stats.failing}${failingSeeds.length ? ` (seeds ${failingSeeds.slice(0, 30).join(",")}${failingSeeds.length > 30 ? ", …" : ""})` : ""}`);
    console.log(`divergences:       ${distinct.size} distinct after shrinking, ${signatures.size} distinct signatures`);
    for (const d of distinct.values()) console.log(`  ${args.out}/${d.hash}  seeds ${d.seeds.join(",")}  ${d.signature}`);
    console.log(`duration:          ${secs.toFixed(0)}s (${Math.round((stats.cases / secs) * 3600)} cases/hour)`);
    process.exitCode = stats.failing || stats.invalid || stats.errors ? 1 : 0;
  } finally {
    await browser.close();
    server.close();
  }
}

await main();
