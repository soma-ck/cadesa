/**
 * Tailwind front end for lift: a page that styles elements with utility classes, plus the compiled
 * Tailwind CSS, becomes a Cadesa source and a fixture.
 *
 *   1. Every utility rule that applies to an element is read from the compiled CSS (so custom
 *      themes, arbitrary values and the real cascade order are honoured), per width range.
 *      Tailwind is mobile-first (`md:` = `width >= 48rem`); the ranges between thresholds become
 *      desktop-first states: the widest range is the base, each narrower range a `when` override
 *      on a max-width breakpoint just below its upper threshold (47.99rem below md).
 *   2. var() and calc() are resolved per element (theme variables, Tailwind's own --tw-*
 *      properties); colors become hex. Inherited text (size, line height, weight, color, family,
 *      tracking, case, alignment) is computed down the tree, because Cadesa text roles don't inherit.
 *   3. Each element becomes a component root (top level) or slot with generated class names
 *      (`ca-<component>`, `ca-<component>__<slot>`) and a data-fixture id. Block flow becomes a
 *      stack; `space-y-*` its gap. lift.ts maps the effective declarations to props.
 *   4. Everything not modelled is an Unlifted record against the element, so impact.ts marks the
 *      boxes it can move as ≈. A few things can only be decided after layout (a non-wrapping flex
 *      row that would wrap; a `grid-cols-<n>` grid whose emulation gives a different column
 *      count); `dynamic()` reports those per width.
 */
import { parse } from "parse5";
import { walk, type Box, type Layout } from "../engine/layout.js";
import { parseFixture, textAndRuns, type Fixture, type FixtureNode, type P5Node } from "../fixture.js";
import type { Decl } from "../lift/css.js";
import { emitYaml, kindOf, liftElements, worst, type ImpactKind, type LiftedElement, type LiftResult, type Unlifted } from "../lift/lift.js";
import { loadSource } from "../load.js";
import { modelOf, render } from "../project.js";
import { isStatePseudo, parseTailwindCss, widthsHold, type TailwindCss, type TwDecl, type TwRule } from "./css.js";
import { hexOf, INVALID, parseColor, simplify, substitute } from "./values.js";

// ---------------------------------------------------------------- breakpoints

/** Tailwind v4's default breakpoints (overridable with --breakpoint-* theme variables). */
export const DEFAULT_BREAKPOINTS: Record<string, string> = { sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem", "2xl": "96rem" };

/** A width range [lo, hi) in which every utility's media conditions hold or fail together. */
export interface State {
  lo: number;
  hi: number;
  /** Lift state key: Infinity for the widest (base) range, else the max-width breakpoint px. */
  key: number;
  /** Max-width breakpoint for narrower states, as written, e.g. "47.99rem". */
  raw?: string;
  name?: string;
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Mobile-first thresholds → desktop-first states. `cuts` are px where some media condition flips
 * (min-width thresholds); names map a threshold px to a Tailwind breakpoint name.
 */
export function statesFor(cuts: number[], names: Map<number, string> = new Map()): State[] {
  const cs = [...new Set(cuts.filter((c) => c > 0))].sort((a, b) => a - b);
  const bounds = [0, ...cs, Infinity];
  const out: State[] = [];
  for (let i = bounds.length - 2; i >= 0; i--) {
    const lo = bounds[i];
    const hi = bounds[i + 1];
    if (hi === Infinity) out.push({ lo, hi, key: Infinity });
    else {
      const rem = round(hi / 16 - 0.01);
      const raw = `${rem}rem`;
      out.push({ lo, hi, key: rem * 16, raw, name: `below-${names.get(hi) ?? `${round(hi, 2)}px`.replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "")}` });
    }
  }
  return out;
}

export const stateAt = (states: State[], width: number) => states.find((s) => width >= s.lo && width < s.hi) ?? states[0];

// ---------------------------------------------------------------- the page

interface P5Loc {
  startLine: number;
  startOffset: number;
  endOffset: number;
  startTag?: { startOffset: number; endOffset: number };
  attrs?: Record<string, { startOffset: number; endOffset: number }>;
}
interface P5 {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5[];
  sourceCodeLocation?: P5Loc;
}

type Role = "hidden" | "out" | "container" | "text" | "leaf";

interface Origin {
  value: string;
  utility: string;
  important?: boolean;
}

interface TextCtx {
  size: number;
  lineHeight: { num: number } | { px: number } | "normal";
  family: { value: string; hint?: string };
  weight: number;
  color: { hex: string; hint?: string };
  letterSpacing: number;
  /** Other inherited properties, with the utility that set them. */
  inherited: Map<string, Origin>;
}

interface Note {
  reason: string;
  kind: ImpactKind;
  decl: string;
}

interface El {
  node: P5;
  tag: string;
  classes: string[];
  line: number;
  parent?: El;
  children: El[];
  /** Index among element siblings (for :first-child etc.). */
  index: number;
  siblings: number;
  ownText: boolean;
  id?: string;
  block?: string;
  slot?: string;
  className?: string;
  /** Per state index. */
  roles: Role[];
  own: Map<string, Origin>[];
  text: TextCtx[];
  decls: Map<string, Decl>[];
  notes: Map<string, { note: Note; states: Set<number> }>;
  space: ({ axis: "x" | "y"; value: string; utility: string } | undefined)[];
  nowrap: boolean[];
  /** Has margin-inline: auto as a flex-row item (handled as a visual offset). */
  autoMargin: boolean[];
  gridCols: ({ n: number; gap: number } | undefined)[];
  /** The (shared) slot or root this element's styles are emitted under. */
  signature?: string;
}

const SKIP = new Set(["script", "style", "template", "noscript", "head", "title", "meta", "link", "base"]);
const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "br", "label", "del", "ins"]);
const INLINE_BLOCK = new Set(["button", "input", "select", "textarea", "meter", "progress"]);
const REPLACED_BLOCK = new Set(["img", "svg", "video", "canvas", "audio", "iframe", "embed", "object"]);
const CONTROL = new Set(["input", "select", "textarea"]);
/** Inline tags whose browser defaults change how text measures. */
const UA_TEXT: Record<string, string> = {
  strong: "is bold (font-weight: bolder)",
  b: "is bold (font-weight: bolder)",
  em: "is italic",
  i: "is italic",
  cite: "is italic",
  dfn: "is italic",
  var: "is italic",
  code: "is set in the monospace font",
  kbd: "is set in the monospace font",
  samp: "is set in the monospace font",
  small: "is set at 80%",
  sub: "is smaller and lowered",
  sup: "is smaller and raised",
};

const TEXT_PROPS = new Set(["font-size", "line-height", "font-family", "font-weight", "color", "letter-spacing"]);
const INHERITED_OTHER = new Set(["text-transform", "text-align", "font-style", "white-space", "text-wrap", "text-wrap-mode", "text-wrap-style", "word-break", "overflow-wrap", "hyphens", "text-indent", "word-spacing", "font-variant-numeric", "font-stretch", "line-break", "tab-size", "direction"]);
/** Inherited, but only paint: never affect a box. */
const INHERITED_PAINT = new Set(["-webkit-font-smoothing", "-moz-osx-font-smoothing", "font-feature-settings", "font-variation-settings", "cursor", "visibility", "list-style-type", "list-style-position", "text-shadow", "caret-color", "accent-color", "fill", "stroke"]);

const attr = (n: P5, name: string) => n.attrs?.find((a) => a.name === name)?.value;
const isWs = (s: string) => /^[ \t\n\r\f]*$/.test(s);
const sanitize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "n$1");

// ---------------------------------------------------------------- longhands

const SIDES = ["top", "right", "bottom", "left"] as const;
function boxSides(v: string): string[] {
  const p = v.trim().split(/\s+(?![^(]*\))/);
  if (p.length === 1) return [p[0], p[0], p[0], p[0]];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  if (p.length === 3) return [p[0], p[1], p[2], p[1]];
  return p.slice(0, 4);
}

/** Expand shorthands and logical properties (LTR, horizontal) into physical longhands. */
export function longhands(prop: string, value: string): [string, string][] {
  const logical: Record<string, string[]> = {
    inline: ["left", "right"],
    block: ["top", "bottom"],
    "inline-start": ["left"],
    "inline-end": ["right"],
    "block-start": ["top"],
    "block-end": ["bottom"],
  };
  let m = /^(padding|margin)$/.exec(prop);
  if (m) return boxSides(value).map((v, i) => [`${prop}-${SIDES[i]}`, v]);
  m = /^(padding|margin|inset|scroll-margin|scroll-padding)-(inline|block|inline-start|inline-end|block-start|block-end)$/.exec(prop);
  if (m) {
    const sides = logical[m[2]];
    const vals = value.trim().split(/\s+(?![^(]*\))/);
    const base = m[1] === "inset" ? "" : `${m[1]}-`;
    return sides.map((s, i) => [`${base}${s}`, vals[i] ?? vals[0]]);
  }
  m = /^border-(width|style|color)$/.exec(prop);
  if (m) return boxSides(value).map((v, i) => [`border-${SIDES[i]}-${m![1]}`, v]);
  m = /^border-(inline|block|inline-start|inline-end|block-start|block-end)-(width|style|color)$/.exec(prop);
  if (m) return logical[m[1]].map((s) => [`border-${s}-${m![2]}`, value]);
  m = /^border(?:-(top|right|bottom|left))?$/.exec(prop);
  if (m) {
    const sides = m[1] ? [m[1]] : [...SIDES];
    const parts = value.trim().split(/\s+(?![^(]*\))/);
    const width = parts.find((p) => /^[\d.]/.test(p) || /^(thin|medium|thick)$/.test(p)) ?? "medium";
    const style = parts.find((p) => /^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(p)) ?? "none";
    const color = parts.find((p) => p !== width && p !== style) ?? "currentcolor";
    return sides.flatMap((s) => [[`border-${s}-width`, width], [`border-${s}-style`, style], [`border-${s}-color`, color]] as [string, string][]);
  }
  if (prop === "gap") {
    const p = value.trim().split(/\s+(?![^(]*\))/);
    return [["row-gap", p[0]], ["column-gap", p[1] ?? p[0]]];
  }
  if (prop === "inset") return boxSides(value).map((v, i) => [SIDES[i], v]);
  if (prop === "overflow") {
    const p = value.trim().split(/\s+/);
    return [["overflow-x", p[0]], ["overflow-y", p[1] ?? p[0]]];
  }
  if (prop === "place-items") {
    const p = value.trim().split(/\s+/);
    return [["align-items", p[0]], ["justify-items", p[1] ?? p[0]]];
  }
  if (prop === "place-content") {
    const p = value.trim().split(/\s+/);
    return [["align-content", p[0]], ["justify-content", p[1] ?? p[0]]];
  }
  if (prop === "border-radius" && value.trim().split(/\s+(?![^(]*\))/).length > 1) {
    const s = boxSides(value);
    return (["top-left", "top-right", "bottom-right", "bottom-left"] as const).map((c, i) => [`border-${c}-radius`, s[i]]);
  }
  const corner: Record<string, string[]> = {
    "border-start-start-radius": ["border-top-left-radius"],
    "border-start-end-radius": ["border-top-right-radius"],
    "border-end-end-radius": ["border-bottom-right-radius"],
    "border-end-start-radius": ["border-bottom-left-radius"],
  };
  if (corner[prop]) return corner[prop].map((p) => [p, value]);
  if (prop === "text-wrap") return [["text-wrap", value]];
  return [[prop, value]];
}

// ---------------------------------------------------------------- values

const LEN = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%)?$/;

function lengthPx(v: string, em: number, pct?: number): number | undefined {
  const m = LEN.exec(v.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!m[2]) return n === 0 ? 0 : undefined;
  if (m[2] === "px") return n;
  if (m[2] === "rem") return n * 16;
  if (m[2] === "em") return n * em;
  return pct === undefined ? undefined : (n / 100) * pct;
}

const fmtNum = (n: number) => String(Math.round(n * 1e6) / 1e6);

/** The theme variable a value is a plain reference to (following `var(--a)` → `var(--b)` chains). */
function hintOf(raw: string, theme: Map<string, string>): string | undefined {
  let cur = raw.trim();
  let name: string | undefined;
  for (let i = 0; i < 8; i++) {
    const m = /^var\(\s*(--[\w-]+)\s*(?:,.*)?\)$/s.exec(cur);
    if (!m) break;
    name = m[1];
    const next = theme.get(name);
    if (next === undefined) break;
    cur = next;
  }
  if (name && /^--(?:tw|default)-/.test(name)) return undefined;
  if (name === "--spacing") return "--spacing-1";
  if (name) return name;
  const sp = /^calc\(\s*var\(--spacing\)\s*\*\s*(-?[\d.]+)\s*\)$/.exec(raw.trim());
  if (sp) return `--spacing-${sp[1].replace(".", "-")}`;
  return undefined;
}

const WEIGHTS: Record<string, number> = { normal: 400, bold: 700 };
function bolder(w: number) {
  return w < 350 ? 400 : w < 550 ? 700 : w < 900 ? 900 : w;
}
function lighter(w: number) {
  return w < 550 ? 100 : w < 750 ? 400 : 700;
}

// ---------------------------------------------------------------- result

export interface TailwindLift {
  page: string;
  cssFile: string;
  lifted: LiftResult;
  yaml: string;
  /** The page with generated class names and data-fixture ids added (original classes kept). */
  html: string;
  /** Every element laid out at some width. */
  fixture: Fixture;
  /** The fixture as laid out at `width`: elements hidden there (display: none) are left out. */
  fixtureAt(width: number): Fixture;
  /** Uncertainty that can only be decided after layout, for one width. */
  dynamic(layout: Layout): Unlifted[];
  states: State[];
  /** Data-fixture ids of elements hidden at some widths but not others. */
  responsive: string[];
}

export interface TailwindOptions {
  /** Pre-render widths used to fit `grid-cols-<n>` emulations (default: a spread across each range). */
  sampleStep?: number;
}

export function liftTailwind(page: string, html: string, cssFile: string, cssText: string, _opts: TailwindOptions = {}): TailwindLift {
  const css = parseTailwindCss(cssFile, cssText);
  return new TailwindLifter(page, html, css).run();
}

class TailwindLifter {
  els: El[] = [];
  roots: El[] = [];
  states: State[] = [];
  pageNotes: Note[] = [];
  bodyEl?: El;
  vars = new Map<string, Decl>();
  pageBackground?: Decl;
  rootText!: TextCtx;
  /** Classes with no rule in the compiled CSS (not generated, or not Tailwind). */
  unknownClasses = new Set<string>();

  constructor(
    readonly page: string,
    readonly html: string,
    readonly css: TailwindCss,
  ) {}

  run(): TailwindLift {
    this.parseTree();
    this.computeStates();
    this.computeRootText();
    for (const el of [this.htmlEl, this.bodyEl, ...this.els]) if (el) this.evaluate(el);
    for (const el of this.els) this.classify(el);
    for (const el of this.els) this.synthesize(el);
    this.name();
    return this.assemble();
  }

  // ---- tree

  parseTree() {
    const doc = parse(this.html, { sourceCodeLocationInfo: true }) as unknown as P5;
    const find = (n: P5, tag: string): P5 | undefined => {
      if (n.tagName === tag) return n;
      for (const c of n.childNodes ?? []) {
        const f = find(c, tag);
        if (f) return f;
      }
      return undefined;
    };
    const body = find(doc, "body");
    const htmlEl = find(doc, "html");
    const mk = (n: P5, parent: El | undefined, index: number, siblings: number): El => ({
      node: n,
      tag: n.tagName!,
      classes: (attr(n, "class") ?? "").split(/\s+/).filter(Boolean),
      line: n.sourceCodeLocation?.startLine ?? 0,
      parent,
      children: [],
      index,
      siblings,
      ownText: (n.childNodes ?? []).some((c) => c.nodeName === "#text" && !isWs(c.value ?? "")),
      roles: [],
      own: [],
      text: [],
      decls: [],
      notes: new Map(),
      space: [],
      nowrap: [],
      autoMargin: [],
      gridCols: [],
    });
    if (htmlEl) {
      const h = mk(htmlEl, undefined, 0, 1);
      this.htmlEl = h;
    }
    if (!body) return;
    this.bodyEl = mk(body, this.htmlEl, 0, 1);
    const build = (n: P5, el: El) => {
      const kids = (n.childNodes ?? []).filter((c) => c.tagName && !SKIP.has(c.tagName));
      kids.forEach((c, i) => {
        const k = mk(c, el, i, kids.length);
        el.children.push(k);
        this.els.push(k);
        if (k.tag !== "svg") build(c, k);
      });
    };
    build(body, this.bodyEl);
    this.roots = this.bodyEl.children;
  }
  htmlEl?: El;

  // ---- media states

  computeStates() {
    const cuts: number[] = [];
    const all = [this.htmlEl, this.bodyEl, ...this.els].filter(Boolean) as El[];
    for (const el of all)
      for (const c of el.classes)
        for (const r of this.css.byClass.get(c) ?? []) for (const m of r.media) for (const w of m.widths) cuts.push(w.px);
    const names = new Map<number, string>();
    for (const [n, v] of Object.entries(DEFAULT_BREAKPOINTS)) names.set(lengthPx(v, 16)!, n);
    for (const [k, v] of this.css.theme) {
      const m = /^--breakpoint-([\w-]+)$/.exec(k);
      const px = m && lengthPx(simplify(v), 16);
      if (m && px) names.set(px, m[1]);
    }
    this.states = statesFor(cuts, names);
  }

  // ---- cascade

  /** Root text context: html's preflight font-family and line-height, 16px, black. */
  computeRootText() {
    const theme = this.css.theme;
    const lookup = (name: string): string | undefined => {
      const v = theme.get(name);
      return v === undefined ? undefined : substitute(v, lookup);
    };
    const famRaw = this.css.rootDecls.get("font-family");
    const fam = famRaw ? substitute(famRaw, lookup) : undefined;
    const lhRaw = this.css.rootDecls.get("line-height");
    const lh = lhRaw && /^[\d.]+$/.test(lhRaw) ? { num: parseFloat(lhRaw) } : ("normal" as const);
    let hint: string | undefined;
    if (famRaw) {
      const inner = /^var\(\s*(--[\w-]+)/.exec(famRaw);
      if (inner && theme.has(inner[1])) hint = hintOf(theme.get(inner[1])!, theme) ?? undefined;
    }
    this.rootText = {
      size: 16,
      lineHeight: lh,
      family: { value: fam && fam !== INVALID ? simplify(fam) : "serif", hint },
      weight: 400,
      color: { hex: "#000000" },
      letterSpacing: 0,
      inherited: new Map(),
    };
    if (!this.css.preflight)
      this.pageNotes.push({ reason: "the compiled CSS has no Tailwind preflight; browser default margins, padding and borders remain", kind: "geometry", decl: "preflight" });
  }

  note(el: El, si: number, n: Note) {
    const key = `${n.decl}|${n.reason}|${n.kind}`;
    const prev = el.notes.get(key);
    if (prev) prev.states.add(si);
    else el.notes.set(key, { note: n, states: new Set([si]) });
  }

  /** The value of custom property `name` on `el` in state `si`. */
  lookupVar(el: El | undefined, si: number, name: string, depth = 0): string | undefined {
    if (depth > 24) return undefined;
    if (!el) {
      const v = this.css.theme.get(name);
      return v === undefined ? undefined : substitute(v, (n) => this.lookupVar(undefined, si, n, depth + 1));
    }
    const own = el.own[si]?.get(name);
    if (own) {
      const v = substitute(own.value, (n) => (n === name ? undefined : this.lookupVar(el, si, n, depth + 1)));
      return v === INVALID ? undefined : v;
    }
    const reg = this.css.registered.get(name);
    if (reg && !reg.inherits) return reg.initial;
    return this.lookupVar(el.parent, si, name, depth + 1);
  }

  resolve(el: El, si: number, value: string): string | undefined {
    const v = substitute(value, (n) => this.lookupVar(el, si, n));
    if (v === INVALID) return undefined;
    return simplify(v).trim();
  }

  /** Own declarations per state, and notes for rules that don't apply in the default state. */
  evaluate(el: El) {
    const rules: { rule: TwRule; cls: string }[] = [];
    for (const c of el.classes) {
      const rs = this.css.byClass.get(c);
      if (!rs) {
        this.unknownClasses.add(c);
        continue;
      }
      for (const rule of rs) rules.push({ rule, cls: c });
    }
    rules.sort((a, b) => a.rule.order - b.rule.order);
    this.states.forEach((st, si) => {
      const own = new Map<string, Origin>();
      el.own[si] = own;
      el.space[si] = undefined;
      for (const { rule, cls } of rules) {
        const declText = `${cls} (${rule.decls.filter((d) => !d.prop.startsWith("--")).map((d) => `${d.prop}: ${d.value}`).join("; ") || rule.decls.map((d) => d.prop).join(", ")})`;
        const kinds = rule.decls.filter((d) => !d.prop.startsWith("--")).map((d) => kindOf(d.prop));
        const k = kinds.length ? worst(kinds) : "none";
        let skip = false;
        for (const m of rule.media) {
          if (!widthsHold(m.widths, st.lo)) skip = true;
          else if (m.dark) {
            this.note(el, si, { decl: cls, reason: "dark: variants are not modelled; the light color scheme is assumed", kind: "none" });
            skip = true;
          } else if (m.env === false) skip = true;
          else if (m.env !== true) {
            this.note(el, si, { decl: declText, reason: `${m.env.unknown} is not modelled`, kind: k });
            skip = true;
          }
        }
        if (skip) continue;
        if (rule.complex) {
          const state = /:(hover|focus|focus-visible|focus-within|active|visited|checked|disabled|open|target)\b/.test(rule.selector);
          this.note(el, si, state
            ? { decl: cls, reason: "interactive state; the default state is unaffected", kind: "state" }
            : { decl: declText, reason: `the selector ${rule.selector} is not modelled`, kind: k });
          continue;
        }
        if (rule.pseudoElement) {
          const pe = rule.pseudoElement;
          this.note(el, si, /^(before|after|marker|first-line|first-letter)$/.test(pe)
            ? { decl: declText, reason: `::${pe} content is not modelled`, kind: pe === "before" || pe === "after" ? "geometry" : "text" }
            : { decl: cls, reason: `::${pe} styles don't affect layout`, kind: "none" });
          continue;
        }
        let applies = true;
        for (const p of rule.pseudos) {
          if (isStatePseudo(p)) {
            this.note(el, si, { decl: cls, reason: "interactive state; the default state is unaffected", kind: "state" });
            applies = false;
          } else if (p === "first-child") applies &&= el.index === 0;
          else if (p === "last-child") applies &&= el.index === el.siblings - 1;
          else if (p === "only-child") applies &&= el.siblings === 1;
          else if (p === "nth-child(odd)") applies &&= el.index % 2 === 0;
          else if (p === "nth-child(even)") applies &&= el.index % 2 === 1;
          else if (p === "empty") applies &&= !el.children.length && !el.ownText;
          else {
            this.note(el, si, { decl: declText, reason: `:${p} is not modelled`, kind: k });
            applies = false;
          }
        }
        if (!applies) continue;
        if (rule.spaceChildren) {
          const prop = rule.spaceChildren === "y" ? "margin-block-end" : "margin-inline-end";
          const d = rule.decls.find((x) => x.prop === prop);
          if (d) el.space[si] = { axis: rule.spaceChildren, value: d.value, utility: cls };
          continue;
        }
        for (const d of rule.decls) this.apply(own, d, cls);
      }
    });
  }

  apply(own: Map<string, Origin>, d: TwDecl, utility: string) {
    for (const [p, v] of d.prop.startsWith("--") ? [[d.prop, d.value] as [string, string]] : longhands(d.prop, d.value)) {
      const prev = own.get(p);
      if (prev?.important && !d.important) continue;
      own.set(p, { value: v, utility, important: d.important });
    }
  }

  // ---- inherited text

  textOf(el: El | undefined, si: number): TextCtx {
    if (!el) return this.rootText;
    if (el.text[si]) return el.text[si];
    const parent = this.textOf(el.parent, si);
    const own = el.own[si] ?? new Map<string, Origin>();
    const t: TextCtx = { ...parent, inherited: new Map(parent.inherited) };
    const val = (p: string) => {
      const o = own.get(p);
      if (!o) return undefined;
      const v = this.resolve(el, si, o.value);
      return v === undefined || v === "inherit" ? undefined : v;
    };
    // Browser defaults that preflight leaves in place (headings and links inherit; these don't).
    if (el.tag === "strong" || el.tag === "b") t.weight = bolder(parent.weight);
    if (el.tag === "small") t.size = parent.size * 0.8;
    const fs = val("font-size");
    if (fs) {
      const px = lengthPx(fs, parent.size, parent.size);
      if (px !== undefined) t.size = px;
      else this.note(el, si, { decl: `${own.get("font-size")!.utility} (font-size: ${fs})`, reason: "font-size must be a length", kind: "text" });
    }
    const lh = val("line-height");
    if (lh) {
      if (/^[\d.]+$/.test(lh)) t.lineHeight = { num: parseFloat(lh) };
      else if (lh === "normal") t.lineHeight = "normal";
      else {
        const px = lengthPx(lh, t.size, t.size);
        if (px !== undefined) t.lineHeight = { px };
      }
    }
    const ff = own.get("font-family");
    if (ff) {
      const v = this.resolve(el, si, ff.value);
      if (v && v !== "inherit") t.family = { value: v, hint: hintOf(ff.value, this.css.theme) };
    }
    const fw = val("font-weight");
    if (fw) t.weight = WEIGHTS[fw] ?? (fw === "bolder" ? bolder(parent.weight) : fw === "lighter" ? lighter(parent.weight) : parseFloat(fw) || t.weight);
    const c = own.get("color");
    if (c) {
      const v = this.resolve(el, si, c.value);
      if (v && !/^(inherit|currentcolor)$/i.test(v)) {
        const parsed = parseColor(v, parseColor(parent.color.hex));
        if (parsed) t.color = { hex: hexOf(parsed), hint: parsed.a >= 0.9995 ? hintOf(c.value, this.css.theme) : undefined };
      }
    }
    const ls = val("letter-spacing");
    if (ls) {
      const px = ls === "normal" ? 0 : lengthPx(ls, t.size);
      if (px !== undefined) t.letterSpacing = px;
    }
    for (const p of [...INHERITED_OTHER, ...INHERITED_PAINT]) {
      const o = own.get(p);
      if (o) {
        const v = this.resolve(el, si, o.value);
        if (v !== undefined) t.inherited.set(p, { value: v, utility: o.utility });
      }
    }
    el.text[si] = t;
    return t;
  }

  // ---- roles

  displayOf(el: El, si: number): string {
    const d = el.own[si].get("display");
    const v = d ? this.resolve(el, si, d.value) : undefined;
    if (v) return v;
    if (INLINE.has(el.tag)) return "inline";
    if (INLINE_BLOCK.has(el.tag)) return "inline-block";
    if (REPLACED_BLOCK.has(el.tag)) return this.css.preflight ? "block" : "inline";
    if (el.tag === "li") return "list-item";
    if (["table"].includes(el.tag)) return "table";
    if (["tr", "td", "th", "thead", "tbody", "tfoot", "caption", "colgroup", "col"].includes(el.tag)) return "table-part";
    return "block";
  }

  isInlineLevel(el: El, si: number) {
    return /^(inline|inline-block|inline-flex|inline-grid|inline-flow-root|contents)$/.test(this.displayOf(el, si));
  }

  outOfFlow(el: El, si: number) {
    const p = el.own[si].get("position");
    const v = p ? this.resolve(el, si, p.value) : undefined;
    return v === "absolute" || v === "fixed";
  }

  /** Inline children make an element a text box when every element child is inline in every state. */
  inlineChild(el: El): boolean {
    if (el.tag === "br" || this.ignorable(el)) return true;
    return this.states.every((_, si) => this.isInlineLevel(el, si) && !this.outOfFlow(el, si) && this.displayOf(el, si) !== "none") && !REPLACED_BLOCK.has(el.tag) && !INLINE_BLOCK.has(el.tag);
  }

  /** Never displayed: hidden or out of flow at every width. */
  ignorable(el: El) {
    return this.states.every((_, si) => this.displayOf(el, si) === "none" || this.outOfFlow(el, si));
  }

  isColumn(el: El, si: number) {
    const d = el.own[si].get("flex-direction");
    return /^(inline-)?flex$/.test(this.displayOf(el, si)) && d !== undefined && this.resolve(el, si, d.value) === "column";
  }

  visibleText(el: El): boolean {
    return el.ownText || el.children.some((c) => !this.ignorable(c) && this.inlineChild(c) && this.visibleText(c));
  }

  classify(el: El) {
    // Parents decide first (a text box's descendants are inline content, not boxes).
    if (el.parent && el.parent !== this.bodyEl && el.parent.roles.length && el.parent.roles.every((r) => r === "text" || r === "hidden" || r === "out")) return;
    if (el.parent && el.parent !== this.bodyEl && el.parent.roles.length === 0) return;
    // Children of a flex or grid container are blockified: never inline content.
    const formatsChildren = this.states.some((_, si) => /^(inline-)?(flex|grid)$/.test(this.displayOf(el, si)));
    const allInline = el.children.length > 0 && !formatsChildren && el.children.every((c) => this.inlineChild(c));
    const hasText = el.ownText || (allInline && this.visibleText(el));
    this.states.forEach((_, si) => {
      const d = this.displayOf(el, si);
      let role: Role;
      if (d === "none" || (el.parent && el.parent.roles[si] === "hidden")) role = "hidden";
      else if (this.outOfFlow(el, si)) role = "out";
      else if (el.tag === "svg" || REPLACED_BLOCK.has(el.tag) || CONTROL.has(el.tag)) role = "leaf";
      else if (hasText && (el.children.length === 0 || allInline)) role = "text";
      else if (el.children.length) role = "container";
      else role = "leaf";
      el.roles[si] = role;
    });
  }

  // ---- declarations for lift

  synthesize(el: El) {
    if (!el.roles.length) return;
    const visible = el.roles.map((r) => r !== "hidden" && r !== "out");
    if (!visible.some(Boolean)) return;
    this.states.forEach((st, si) => {
      const role = el.roles[si];
      const out = new Map<string, Decl>();
      el.decls[si] = out;
      if (role === "hidden" || role === "out") return;
      const decl = (prop: string, value: string, utility: string) => out.set(prop, { prop, value, important: false, line: el.line, utility } as Decl & { utility: string });
      const own = el.own[si];
      const res = (p: string) => {
        const o = own.get(p);
        return o ? this.resolve(el, si, o.value) : undefined;
      };
      const parentRole = el.parent && el.parent !== this.bodyEl ? el.parent.roles[si] : "page";
      const parentDisplay = el.parent && el.parent !== this.bodyEl ? this.displayOf(el.parent, si) : "block";
      const inFlexOrGrid = /flex|grid/.test(parentDisplay) && parentRole === "container";

      // Inline-level boxes in block flow sit on line boxes, which Cadesa doesn't model.
      if (!inFlexOrGrid && this.isInlineLevel(el, si))
        this.note(el, si, { decl: `display: ${this.displayOf(el, si)}`, reason: "an inline-level box in block flow sits on a line box (baseline, line height, whitespace); Cadesa lays out block boxes", kind: "geometry" });

      // Sticky: in flow; it only moves once the page scrolls.
      const pos = res("position");
      if (pos === "sticky") this.note(el, si, { decl: own.get("position")!.utility, reason: "position: sticky; predicted at scroll position 0", kind: "none" });

      const skipProp = (p: string) =>
        (el.autoMargin[si] && /^margin-(left|right)$/.test(p) && res(p) === "auto") ||
        p.startsWith("--") || TEXT_PROPS.has(p) || INHERITED_OTHER.has(p) || INHERITED_PAINT.has(p) || p === "display" ||
        (pos === "sticky" && /^(position|top|right|bottom|left|z-index)$/.test(p)) || p === "box-sizing";

      // Layout
      const display = this.displayOf(el, si);
      const flex = /^(inline-)?flex$/.test(display);
      const grid = /^(inline-)?grid$/.test(display);
      const space = el.space[si];
      const spaceVal = space ? this.resolveSpace(el, si, space.value) : undefined;
      const handled = new Set<string>();
      if (role === "container") {
        if (flex) {
          const dir = res("flex-direction") ?? "row";
          const wrap = res("flex-wrap") ?? "nowrap";
          decl("display", "flex", own.get("display")?.utility ?? "flex");
          decl("flex-direction", dir === "column" ? "column" : dir, own.get("flex-direction")?.utility ?? "flex");
          if (dir === "row" && wrap === "nowrap") {
            el.nowrap[si] = true;
            decl("flex-wrap", "wrap", "flex (no wrap)");
          } else if (own.has("flex-wrap")) decl("flex-wrap", wrap, own.get("flex-wrap")!.utility);
          handled.add("flex-direction").add("flex-wrap");
          let rowGap = own.get("row-gap");
          let colGap = own.get("column-gap");
          if (space && spaceVal !== undefined) {
            const axisMain = dir === "column" ? "y" : "x";
            const gapProp = space.axis === "y" ? "row-gap" : "column-gap";
            const existing = space.axis === "y" ? rowGap : colGap;
            if (space.axis === axisMain && (!existing || lengthPx(this.resolve(el, si, existing.value) ?? "x", 16) === 0)) {
              decl(gapProp, spaceVal, space.utility);
              if (space.axis === "y") rowGap = undefined;
              else colGap = undefined;
              handled.add(gapProp);
            } else this.note(el, si, { decl: space.utility, reason: "space-* margins on top of a gap (or across the flex axis) are not modelled", kind: "geometry" });
          }
          for (const [p, o] of [["row-gap", rowGap], ["column-gap", colGap]] as const)
            if (o && !handled.has(p)) {
              decl(p, this.len(el, si, o) ?? o.value, o.utility);
              handled.add(p);
            }
          handled.add("row-gap").add("column-gap");
          // Alignment that only moves items inside the container (never resizes it).
          const kids = el.children.filter((c) => c.roles[si] && c.roles[si] !== "hidden" && c.roles[si] !== "out");
          const jc = res("justify-content");
          if (jc && !/^(normal|flex-start|start|left)$/.test(jc) && (dir !== "column" || own.has("height") || own.has("min-height"))) {
            handled.add("justify-content");
            for (const c of kids) this.note(c, si, { decl: `${own.get("justify-content")!.utility} on the parent (justify-content: ${jc})`, reason: "moves the item along its row; Cadesa packs items at the start", kind: "visual" });
          } else if (jc) handled.add("justify-content");
          const ai = res("align-items");
          if (dir === "column" && ai && !/^(normal|stretch)$/.test(ai)) {
            handled.add("align-items");
            for (const c of kids) {
              const fixed = c.own[si].has("width");
              this.note(c, si, c.roles[si] === "text" || fixed
                ? { decl: `${own.get("align-items")!.utility} on the parent (align-items: ${ai})`, reason: `the item isn't stretched: its width and x differ, ${fixed ? "its width is set" : "its text wraps the same"}, so its height doesn't`, kind: "visual" }
                : { decl: `${own.get("align-items")!.utility} on the parent (align-items: ${ai})`, reason: "the item isn't stretched; it's sized by its content, which Cadesa measures only for a single text run", kind: "geometry" });
            }
          }
          // margin-inline: auto on a row item pushes it (and what follows) along the row.
          if (dir !== "column")
            kids.forEach((c, i) => {
              for (const side of ["left", "right"]) {
                const m = c.own[si].get(`margin-${side}`);
                if (m && this.resolve(c, si, m.value) === "auto") {
                  c.autoMargin[si] = true;
                  for (const d of kids.slice(side === "left" ? i : i + 1))
                    this.note(d, si, { decl: `${m.utility} on #${c.id ?? c.tag} (margin-${side}: auto)`, reason: "auto margins move items along the row; Cadesa packs items at the start", kind: "visual" });
                }
              }
            });
        } else if (grid) {
          const cols = res("grid-template-columns");
          const gapOrigin = own.get("row-gap");
          const rowGap = own.has("row-gap") ? this.len(el, si, own.get("row-gap")!) : undefined;
          const colGap = own.has("column-gap") ? this.len(el, si, own.get("column-gap")!) : undefined;
          const n = cols ? /^repeat\(\s*(\d+)\s*,\s*minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s*\)$/.exec(cols) : null;
          handled.add("grid-template-columns").add("row-gap").add("column-gap").add("align-items").add("justify-items");
          if (!cols || cols === "none" || (n && n[1] === "1")) {
            // One column: a stack with the row gap.
            decl("display", "flex", own.get("display")!.utility);
            decl("flex-direction", "column", own.get("grid-template-columns")?.utility ?? own.get("display")!.utility);
            if (rowGap && lengthPx(res("row-gap")!, 16) !== 0) decl("row-gap", rowGap, gapOrigin!.utility);
            if (space) this.note(el, si, { decl: space.utility, reason: "space-* margins in a grid are not modelled", kind: "geometry" });
            const ji = res("justify-items");
            if (ji && !/^(stretch|normal|legacy)$/.test(ji)) this.note(el, si, { decl: `${own.get("justify-items")!.utility} (justify-items: ${ji})`, reason: "grid items always stretch across their column", kind: "geometry" });
          } else {
            decl("display", "grid", own.get("display")!.utility);
            for (const p of ["align-items", "justify-items"]) if (own.has(p)) decl(p, res(p)!, own.get(p)!.utility);
            if (rowGap) decl("row-gap", rowGap, gapOrigin!.utility);
            if (colGap) decl("column-gap", colGap, own.get("column-gap")!.utility);
            if (n) {
              const gap = lengthPx(res("column-gap") ?? "0", 16) ?? 0;
              el.gridCols[si] = { n: parseInt(n[1]), gap };
              const name = `--grid-cols-${n[1]}`;
              decl("grid-template-columns", `repeat(auto-fill, minmax(var(${name}), 1fr))`, own.get("grid-template-columns")!.utility);
            } else decl("grid-template-columns", cols, own.get("grid-template-columns")!.utility);
            if (space) this.note(el, si, { decl: space.utility, reason: "space-* margins in a grid are not modelled", kind: "geometry" });
          }
        } else if (/^(block|flow-root|list-item|inline-block)$/.test(display)) {
          // Block flow with zero margins (preflight): a stack.
          decl("display", "flex", "block flow");
          decl("flex-direction", "column", "block flow");
          if (space?.axis === "y" && spaceVal !== undefined) decl("row-gap", spaceVal, space.utility);
          else if (space) this.note(el, si, { decl: space.utility, reason: "space-x in block flow is not modelled", kind: "geometry" });
        } else {
          this.note(el, si, { decl: `display: ${display}`, reason: `display: ${display} has no Cadesa pattern`, kind: "geometry" });
        }
        if (el.ownText)
          this.note(el, si, { decl: "text", reason: "text next to block children (anonymous boxes) is not modelled", kind: "geometry" });
        if (space && space.axis === "y" && el.children.some((c) => c.roles[si] === "hidden") && !flex)
          this.note(el, si, { decl: space.utility, reason: "space-y with hidden children (:last-child) is not modelled", kind: "geometry" });
      } else {
        if (space) this.note(el, si, { decl: space.utility, reason: "space-* without children", kind: "none" });
        if (!/^(block|flow-root|list-item|inline|inline-block|flex|inline-flex|grid|inline-grid)$/.test(display))
          this.note(el, si, { decl: `display: ${display}`, reason: `display: ${display} has no Cadesa pattern`, kind: "geometry" });
      }
      if (role !== "container") for (const p of ["flex-direction", "flex-wrap", "align-items", "justify-content", "row-gap", "column-gap", "grid-template-columns", "justify-items"]) handled.add(p);

      // A flex-row item is sized by its content; the engine measures that only for a text run.
      if (parentRole === "container" && /flex/.test(parentDisplay) && el.parent && !this.isColumn(el.parent, si) && role !== "text" && !own.has("width") && !/^(none|0 0 auto)$/.test(res("flex") ?? "x"))
        this.note(el, si, { decl: `<${el.tag}> in a flex row`, reason: "a flex item without a width (w-*) is sized by its content, which Cadesa measures only for a single text run", kind: "geometry" });

      // Form controls size themselves from the font and the UA's internal padding.
      if (CONTROL.has(el.tag) && !own.has("height"))
        this.note(el, si, { decl: `<${el.tag}>`, reason: `a form control's height comes from its font and the browser's internals; give it a height (h-*) to predict it`, kind: "geometry" });
      // Replaced elements and controls have an intrinsic width (the file, 300×150 for svg, ~20ch for inputs).
      const stretched = parentRole === "container" && /flex/.test(parentDisplay) && el.parent && this.isColumn(el.parent, si) && !own.has("align-self");
      if ((CONTROL.has(el.tag) || REPLACED_BLOCK.has(el.tag)) && !own.has("width") && !stretched)
        this.note(el, si, { decl: `<${el.tag}>`, reason: `<${el.tag}> without a width (w-*) takes its intrinsic width, which Cadesa doesn't know`, kind: "geometry" });

      // Borders: preflight makes every side `0 solid currentcolor`.
      const bw = SIDES.map((s) => own.get(`border-${s}-width`));
      const text = this.textOf(el, si);
      if (bw.some(Boolean)) {
        for (const s of SIDES) {
          const w = own.get(`border-${s}-width`);
          const st = own.get(`border-${s}-style`);
          const c = own.get(`border-${s}-color`);
          decl(`border-${s}-width`, w ? (this.resolve(el, si, w.value) ?? "0") : "0", w?.utility ?? "preflight");
          decl(`border-${s}-style`, st ? (this.resolve(el, si, st.value) ?? "solid") : this.css.preflight ? "solid" : "none", st?.utility ?? "preflight");
          const cv = c ? this.resolve(el, si, c.value) : "currentcolor";
          const parsed = cv && !/^currentcolor$/i.test(cv) ? parseColor(cv, parseColor(text.color.hex)) : parseColor(text.color.hex);
          const hint = c && parsed && parsed.a >= 0.9995 ? hintOf(c.value, this.css.theme) : !c ? text.color.hint : undefined;
          decl(`border-${s}-color`, parsed ? this.colorValue(hexOf(parsed), hint) : cv ?? "currentcolor", c?.utility ?? "text color");
        }
      }
      for (const s of SIDES) handled.add(`border-${s}-width`).add(`border-${s}-style`).add(`border-${s}-color`);

      // Everything else the element sets on itself.
      for (const [p, o] of own) {
        if (handled.has(p) || skipProp(p)) continue;
        let v = this.resolve(el, si, o.value);
        if (v === undefined) continue;
        if (p === "background-color" || p === "outline-color" || p === "text-decoration-color") {
          const c = parseColor(v, parseColor(text.color.hex));
          if (c) v = this.colorValue(hexOf(c), c.a >= 0.9995 ? hintOf(o.value, this.css.theme) : undefined);
        } else if (p === "background-image" || p === "box-shadow") v = this.paintValue(p, v, text.color.hex);
        else if (/^(padding|margin)-|^(width|height|max-width|max-height|min-width|min-height|row-gap|column-gap|border-radius|top|right|bottom|left)$/.test(p)) {
          const h = hintOf(o.value, this.css.theme);
          if (h && /^-?[\d.]+px$/.test(v) && parseFloat(v) !== 0) v = this.varValue(h, v);
        }
        if (v === undefined) continue;
        if (p === "aspect-ratio") v = v.replace(/^([\d.]+)\s*\/\s*([\d.]+)$/, "$1 / $2");
        if ((p === "box-shadow" && v === "none") || (p === "background-image" && v === "none")) continue;
        decl(p, v, o.utility);
      }

      // Text: a text box carries its full (inherited) text style.
      if (role === "text") {
        decl("font-family", text.family.hint ? this.varValue(text.family.hint, text.family.value) : text.family.value, "inherited font");
        decl("font-size", `${fmtNum(text.size)}px`, "inherited font size");
        decl("font-weight", String(text.weight), "inherited font weight");
        const lh = text.lineHeight;
        decl("line-height", lh === "normal" ? "normal" : "num" in lh ? fmtNum(lh.num) : fmtNum(lh.px / text.size), "inherited line height");
        decl("color", this.colorValue(text.color.hex, text.color.hint), "inherited color");
        if (text.letterSpacing) decl("letter-spacing", `${fmtNum(text.letterSpacing / text.size)}em`, "inherited tracking");
        for (const [p, o] of text.inherited) {
          if (INHERITED_PAINT.has(p)) continue;
          if (p === "text-align") {
            const v = { left: "start", start: "start", center: "center", right: "end", end: "end" }[o.value];
            if (v && v !== "start") decl("text-align", v, o.utility);
            else if (!v) decl("text-align", o.value, o.utility);
          } else if (/^text-wrap(-style)?$/.test(p) && o.value === "balance" && !(parentRole === "container" && /flex/.test(parentDisplay) && el.parent && !this.isColumn(el.parent, si))) {
            // Balancing keeps the line count, so a box whose width doesn't depend on its text keeps its size.
            this.note(el, si, { decl: o.utility, reason: "text-wrap: balance moves line breaks but keeps the line count; the box is exact, the reported lines are not", kind: "none" });
          } else if (!/^(normal|none|auto|wrap|manual|0|0px|ltr)$/.test(o.value) && !(p === "font-style" && o.value === "normal")) decl(p, o.value, o.utility);
        }
        this.inlineContent(el, si);
      }
    });
  }

  colorValue(hex: string, hint?: string) {
    if (!hint) return hex;
    return this.varValue(hint, hex);
  }

  varValue(name: string, raw: string) {
    const prev = this.vars.get(name);
    if (prev && prev.value !== raw) return raw; // same theme name, different value (e.g. a different scale): literal
    this.vars.set(name, { prop: name, value: raw, important: false, line: 0 });
    return `var(${name})`;
  }

  /** Gradients and shadows: hex colors, Tailwind's empty layers dropped. */
  paintValue(prop: string, v: string, current: string): string | undefined {
    const hexed = hexifyPaint(v, current);
    if (prop === "box-shadow") {
      const layers = splitLayers(hexed).filter((l) => !/^(0(px)?\s+){1,2}#0000(0000)?$/.test(l.trim()) && l.trim() !== "");
      return layers.length ? layers.join(", ") : "none";
    }
    return hexed;
  }

  resolveSpace(el: El, si: number, value: string): string | undefined {
    const v = substitute(value, (n) => (n.startsWith("--tw-space-") ? "0" : this.lookupVar(el, si, n)));
    if (v === INVALID) return undefined;
    const s = simplify(v);
    if (!/^-?[\d.]+px$/.test(s)) return undefined;
    const inner = /calc\(\s*var\(--spacing\)\s*\*\s*[\d.]+\s*\)|var\(--spacing\)/.exec(value);
    const h = inner ? hintOf(inner[0], this.css.theme) : undefined;
    return h && parseFloat(s) !== 0 ? this.varValue(h, s) : s;
  }

  /** A resolved length, as a reference to the theme variable it came from when there is one. */
  len(el: El, si: number, o: Origin): string | undefined {
    const v = this.resolve(el, si, o.value);
    if (v === undefined) return undefined;
    const h = hintOf(o.value, this.css.theme);
    return h && /^-?[\d.]+px$/.test(v) && parseFloat(v) !== 0 ? this.varValue(h, v) : v;
  }

  /** Notes for a text box's inline descendants whose own styles change how the text measures. */
  inlineContent(el: El, si: number) {
    const visit = (k: El) => {
      if (k.tag === "br") return;
      const own = k.own[si];
      const ua = UA_TEXT[k.tag];
      const changes: { prop: string; utility: string; kind: ImpactKind }[] = [];
      for (const [p, o] of own) {
        if (p.startsWith("--")) continue;
        const kind = TEXT_PROPS.has(p) ? (p === "color" ? "paint" : "text") : INHERITED_PAINT.has(p) ? "paint" : kindOf(p);
        changes.push({ prop: p, utility: o.utility, kind });
      }
      const kt = this.textOf(k, si);
      const pt = this.textOf(k.parent, si);
      const textChanges = changes.filter((c) => c.kind !== "paint");
      if (ua && !textChanges.some((c) => c.prop === "font-weight" || c.prop === "font-style" || c.prop === "font-family" || c.prop === "font-size")) {
        const same = (k.tag === "strong" || k.tag === "b") && kt.weight === pt.weight;
        if (!same) this.note(el, si, { decl: `<${k.tag}>`, reason: `inline <${k.tag}> ${ua}; text runs in another style aren't measured`, kind: "text" });
      }
      for (const c of changes) {
        if (c.kind === "paint" || c.kind === "none" || c.kind === "state") {
          if (c.kind === "paint") this.note(el, si, { decl: `${c.utility} on <${k.tag}>`, reason: "inline paint; no effect on layout", kind: "paint" });
          continue;
        }
        // Text properties equal to what the run inherits anyway change nothing.
        if (c.prop === "font-weight" && kt.weight === pt.weight) continue;
        if (c.prop === "font-size" && kt.size === pt.size) continue;
        if (c.prop === "line-height" && JSON.stringify(kt.lineHeight) === JSON.stringify(pt.lineHeight)) continue;
        this.note(el, si, { decl: `${c.utility} on <${k.tag}> (${c.prop})`, reason: "inline runs in another style aren't measured", kind: c.kind === "visual" ? "visual" : c.kind === "geometry" ? "geometry" : "text" });
      }
      for (const n of k.notes.values()) if (n.states.has(si)) this.note(el, si, n.note);
      k.children.forEach(visit);
    };
    el.children.forEach(visit);
  }

  // ---- names, classes, ids

  name() {
    const taken = new Set<string>();
    const usedIds = new Set<string>();
    for (const el of this.els) {
      const id = attr(el.node, "data-fixture");
      if (id) usedIds.add(id);
    }
    const uniqueId = (base: string) => {
      let id = base;
      for (let i = 2; usedIds.has(id); i++) id = `${base}-${i}`;
      usedIds.add(id);
      return id;
    };
    const boxes = (el: El): boolean => el.roles.length > 0 && el.roles.some((r) => r !== "hidden" && r !== "out");
    for (const root of this.roots) {
      if (!boxes(root)) continue;
      const base = sanitize(attr(root.node, "data-fixture") ?? attr(root.node, "id") ?? root.tag) || "block";
      let name = base;
      for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
      taken.add(name);
      root.block = `ca-${name}`;
      root.className = root.block;
      root.signature = root.block;
      root.id = attr(root.node, "data-fixture") ?? uniqueId(name);
      const slots = new Map<string, string>(); // signature → slot name
      const slotNames = new Set<string>();
      const visit = (el: El) => {
        for (const k of el.children) {
          if (!boxes(k)) continue;
          if (!k.roles.length) continue;
          const sig = JSON.stringify([
            k.roles,
            k.decls.map((m) => (m ? [...m.values()].map((d) => `${d.prop}:${d.value}`) : [])),
            [...k.notes.values()].map((n) => [n.note.reason, n.note.kind, n.note.decl, [...n.states]]),
            k.nowrap,
            k.gridCols,
            k.tag,
            k.classes.join(" "),
          ]);
          let slot = slots.get(sig);
          if (!slot) {
            const sb = sanitize(attr(k.node, "data-fixture") ?? k.tag) || "box";
            slot = sb;
            for (let i = 2; slotNames.has(slot); i++) slot = `${sb}-${i}`;
            slotNames.add(slot);
            slots.set(sig, slot);
          }
          k.block = root.block;
          k.slot = slot;
          k.className = `${root.block}__${slot}`;
          k.signature = k.className;
          k.id = attr(k.node, "data-fixture") ?? uniqueId(slot);
          if (k.roles.some((r) => r === "container")) visit(k);
        }
      };
      if (root.roles.some((r) => r === "container")) visit(root);
    }
  }

  // ---- assembly

  liftOnce(gridMin: Map<string, Map<number, number>>): LiftResult {
    const stateKeys = this.states.map((s) => s.key);
    const elements: LiftedElement[] = [];
    const seen = new Set<string>();
    const unlifted: Unlifted[] = [];
    const vars = new Map(this.vars);
    const boxes = this.els.filter((e) => e.className);
    for (const el of boxes) {
      if (seen.has(el.className!)) continue;
      seen.add(el.className!);
      const states = new Map<number, Map<string, Decl>>();
      // States where the element isn't laid out reuse a neighbour's declarations (no override noise).
      const visibleIdx = this.states.map((_, i) => i).filter((i) => el.roles[i] !== "hidden" && el.roles[i] !== "out");
      this.states.forEach((st, si) => {
        const src = visibleIdx.includes(si) ? si : (visibleIdx.filter((i) => i < si).at(-1) ?? visibleIdx[0]);
        const m = new Map(el.decls[src]);
        const g = el.gridCols[src];
        if (g) {
          const name = `--grid-cols-${g.n}`;
          const px = gridMin.get(el.className!)?.get(src) ?? 1;
          const tokenName = `${name}-${this.states[src].name ?? "base"}`;
          vars.set(tokenName, { prop: tokenName, value: `${fmtNum(px)}px`, important: false, line: 0 });
          const d = m.get("grid-template-columns")!;
          m.set("grid-template-columns", { ...d, value: `repeat(auto-fill, minmax(var(${tokenName}), 1fr))` });
        }
        states.set(st.key, m);
      });
      elements.push({ className: el.className!, block: el.block!, element: el.slot, states });
      for (const { note, states: sis } of el.notes.values()) {
        for (const range of this.ranges([...sis].filter((i) => visibleIdx.includes(i)))) {
          unlifted.push({ file: this.page, line: el.line, selector: `.${el.className}`, decl: note.decl, reason: note.reason, kind: note.kind, className: el.className, when: range });
        }
      }
    }
    // Page-level notes apply to every box.
    const bodyNotes = this.bodyEl ? [...this.bodyEl.notes.values()] : [];
    for (const root of this.roots.filter((r) => r.className)) {
      for (const n of this.pageNotes) unlifted.push({ file: this.page, line: 0, selector: `.${root.className}`, decl: n.decl, reason: n.reason, kind: n.kind, className: root.className });
      for (const { note, states: sis } of bodyNotes)
        for (const range of this.ranges([...sis]))
          unlifted.push({ file: this.page, line: this.bodyEl!.line, selector: `.${root.className}`, decl: `${note.decl} on <body>`, reason: note.reason, kind: note.kind, className: root.className, when: range });
    }
    if (this.unknownClasses.size)
      unlifted.push({ file: this.page, line: 0, selector: [...this.unknownClasses].slice(0, 12).join(" ") + (this.unknownClasses.size > 12 ? " ..." : ""), reason: `${this.unknownClasses.size} class name(s) have no rule in ${this.css.file}; they style nothing`, kind: "none" });
    for (const el of this.els.filter((e) => e.roles.length && !e.className && e.roles.every((r) => r === "hidden" || r === "out") && !(e.parent?.roles.every((r) => r === "hidden" || r === "out"))))
      unlifted.push({ file: this.page, line: el.line, selector: `<${el.tag}>`, reason: el.roles.includes("out") ? "taken out of flow (position: absolute/fixed); not laid out" : "hidden at every width (display: none)", kind: "none" });

    const bpPx = this.states.filter((s) => s.key !== Infinity).map((s) => s.key);
    const bpRaw = new Map(this.states.filter((s) => s.raw).map((s) => [s.key, s.raw!]));
    const names = new Map(this.states.filter((s) => s.name).map((s) => [s.key, s.name!]));
    const resets = new Map<string, Set<string>>();
    if (this.css.preflight) for (const r of this.roots) if (r.block) resets.set(r.block, new Set(["margin", "padding", "border", "box-sizing", "border-width"]));
    void stateKeys;
    return liftElements({
      file: this.page,
      vars,
      notes: new Map(),
      prefix: "ca-",
      elements,
      blockOrder: this.roots.filter((r) => r.block).map((r) => r.block!),
      bpPx,
      bpRaw,
      bpName: (px) => names.get(px) ?? `max-${bpRaw.get(px)}`,
      layerChildren: new Map(),
      pageBackground: this.pageBackground,
      unlifted,
      resets,
      declarations: this.els.reduce((n, e) => n + e.classes.length, 0),
    });
  }

  /** Contiguous width ranges covering the given state indices; undefined = every width. */
  ranges(sis: number[]): (Unlifted["when"] | undefined)[] {
    if (!sis.length) return [];
    if (sis.length === this.states.length) return [undefined];
    const sorted = [...sis].sort((a, b) => a - b); // index 0 = widest
    const groups: number[][] = [];
    for (const i of sorted) {
      const g = groups.at(-1);
      if (g && g.at(-1) === i - 1) g.push(i);
      else groups.push([i]);
    }
    return groups.map((g) => {
      const lo = this.states[g.at(-1)!].lo;
      const hi = this.states[g[0]].hi;
      const parts = [lo > 0 && `width ≥ ${round(lo, 2)}px`, hi < Infinity && `width < ${round(hi, 2)}px`].filter(Boolean);
      return { ...(lo > 0 && { minPx: lo }), ...(hi < Infinity && { maxPx: hi - 0.01 }), raw: parts.join(" and ") };
    });
  }

  assemble(): TailwindLift {
    // Page background and page-level styles from <body> / <html>.
    for (const el of [this.htmlEl, this.bodyEl]) {
      if (!el) continue;
      const si = 0;
      const own = el.own[si];
      if (!own) continue;
      const bg = own.get("background-color");
      if (bg) {
        const v = this.resolve(el, si, bg.value);
        const c = v && parseColor(v);
        if (c && c.a >= 0.9995) this.pageBackground = { prop: "background-color", value: this.colorValue(hexOf(c), hintOf(bg.value, this.css.theme)), important: false, line: el.line };
      }
      this.states.forEach((_, s) => {
        for (const [p, o] of el.own[s] ?? []) {
          if (p.startsWith("--") || TEXT_PROPS.has(p) || INHERITED_OTHER.has(p) || INHERITED_PAINT.has(p) || p === "background-color") continue;
          const k = kindOf(p);
          if (k === "paint") continue;
          if (this.bodyEl) this.note(this.bodyEl, s, { decl: `${o.utility} (${p}: ${o.value})`, reason: `page-level ${p} is not modelled`, kind: k });
        }
      });
    }
    const fixtureHtml = this.generatedHtml();
    const fixture = parseFixture(this.page, fixtureHtml);
    const byId = new Map(this.els.filter((e) => e.id).map((e) => [e.id!, e]));
    const hiddenNodes = new Set(this.els.filter((e) => this.ignorable(e)).map((e) => e.node));
    const fixtureFor = (si: number | undefined): Fixture => {
      const keep = (n: FixtureNode): FixtureNode | undefined => {
        const el = n.fixtureId ? byId.get(n.fixtureId) : undefined;
        if (!el) return undefined;
        if (si !== undefined && (el.roles[si] === "hidden" || el.roles[si] === "out")) return undefined;
        const isText = si === undefined ? el.roles.includes("text") : el.roles[si] === "text";
        const children = isText || el.tag === "svg" ? (el.tag === "svg" ? [] : n.children) : (n.children.map(keep).filter(Boolean) as FixtureNode[]);
        // A replaced element or form control has no text box (a textarea's text is its value).
        if (el.roles.every((r) => r !== "text" && r !== "container") && n.text) return { ...n, children, text: "", runs: [] };
        if (isText && hiddenNodes.size) return { ...n, children, ...textAndRuns(el.node as unknown as P5Node, (x) => hiddenNodes.has(x as unknown as P5)) };
        return { ...n, children };
      };
      return { ...fixture, body: fixture.body.map(keep).filter(Boolean) as FixtureNode[] };
    };
    const perState = this.states.map((_, si) => fixtureFor(si));
    const fixtureAt = (w: number) => perState[this.states.indexOf(stateAt(this.states, w))];

    // Fit grid-cols-<n> emulations: the largest minimum that still fits n columns across each range.
    const gridMin = new Map<string, Map<number, number>>();
    let lifted = this.liftOnce(gridMin);
    const grids = this.els.filter((e) => e.className && e.gridCols.some(Boolean));
    if (grids.length) {
      const model = modelOf(loadSource(`${this.page} (tailwind)`, lifted.yaml));
      this.states.forEach((st, si) => {
        if (!grids.some((g) => g.gridCols[si])) return;
        const hi = Math.min(st.hi - 0.01, Math.max(st.lo, 1920) + 640);
        const samples = new Set<number>([Math.max(st.lo, 1), hi]);
        for (let w = Math.ceil(st.lo); w < hi; w += 8) samples.add(Math.max(w, 1));
        const layouts = render(model, perState[si], [...samples]);
        for (const g of grids) {
          const spec = g.gridCols[si];
          if (!spec) continue;
          let min = Infinity;
          for (const l of layouts)
            for (const b of walk(l.boxes))
              if (b.id === g.id) min = Math.min(min, innerWidth(b));
          if (min === Infinity) continue;
          const m = Math.floor(((min + spec.gap) / spec.n - spec.gap) * 100) / 100;
          const per = gridMin.get(g.className!) ?? new Map<number, number>();
          per.set(si, Math.min(per.get(si) ?? Infinity, Math.max(m, 0.01)));
          gridMin.set(g.className!, per);
        }
      });
      lifted = this.liftOnce(gridMin);
    }
    this.relabel(lifted);

    const responsive = this.els.filter((e) => e.id && e.roles.some((r) => r === "hidden" || r === "out") && e.roles.some((r) => r !== "hidden" && r !== "out")).map((e) => e.id!);
    const dynamic = (layout: Layout): Unlifted[] => {
      const si = this.states.indexOf(stateAt(this.states, layout.width));
      const out: Unlifted[] = [];
      const parentOf = new Map<Box, Box>();
      for (const b of walk(layout.boxes)) for (const c of b.children) parentOf.set(c, b);
      for (const b of walk(layout.boxes)) {
        const el = byId.get(b.id);
        if (!el) continue;
        const sel = `[data-fixture="${b.id}"]`;
        if (el.nowrap[si] && b.children.length > 1) {
          if (this.lineCount(b) > 1)
            out.push({ file: this.page, line: el.line, selector: sel, decl: "flex (flex-wrap: nowrap)", reason: `the row doesn't fit at ${layout.width}px; Tailwind's flex row shrinks its items instead of wrapping`, kind: "geometry" });
        }
        const g = el.gridCols[si];
        if (g && b.props.min && b.children.length) {
          const inner = innerWidth(b);
          const cols = Math.max(1, Math.floor((inner + (b.props.gap?.value ?? 0) + 0.001) / (b.props.min.value + (b.props.gap?.value ?? 0))));
          if (cols !== g.n)
            out.push({ file: this.page, line: el.line, selector: sel, decl: `grid-cols-${g.n}`, reason: `grid-cols-${g.n} is emulated with a minimum column width that gives ${cols} columns at ${layout.width}px`, kind: "geometry" });
        }
        // repeat(auto-fill, minmax(X, 1fr)): one column never narrower than X, so it overflows a
        // narrower container; the engine's column fills it instead.
        if (!g && b.props.min && b.props.pattern?.value === "grid" && innerWidth(b) < b.props.min.value - 0.001)
          out.push({ file: this.page, line: el.line, selector: sel, decl: `grid-template-columns (min ${b.props.min.display})`, reason: `the container is narrower than the minimum column at ${layout.width}px; the column overflows it (use minmax(min(X, 100%), 1fr) to keep it inside)`, kind: "geometry" });
        if ((b.tag === "img" || b.tag === "video") && typeof b.props.width?.value === "number") {
          const p = parentOf.get(b);
          const avail = p ? innerWidth(p) : layout.width;
          if (b.w > avail + 0.001)
            out.push({ file: this.page, line: el.line, selector: sel, decl: "max-width: 100% (preflight)", reason: `the image is wider than its container at ${layout.width}px; preflight's max-width: 100% shrinks it`, kind: "geometry" });
        }
      }
      return out;
    };
    return {
      page: this.page,
      cssFile: this.css.file,
      lifted,
      yaml: lifted.yaml,
      html: fixtureHtml,
      fixture: fixtureFor(undefined),
      fixtureAt,
      dynamic,
      states: this.states,
      responsive,
    };
  }

  /** Lines a cluster box laid its children out on. */
  lineCount(b: Box): number {
    let lines = 1;
    let prevRight = -Infinity;
    for (const c of b.children) {
      if (c.x < prevRight - 0.001) lines++;
      prevRight = c.x + c.w;
    }
    return lines;
  }

  /** Name the utility behind each of lift's own records. */
  relabel(lifted: LiftResult) {
    const origin = new Map<string, Map<string, string>>();
    for (const el of this.els) {
      if (!el.className || origin.has(el.className)) continue;
      const m = new Map<string, string>();
      for (const decls of el.decls) for (const d of decls?.values() ?? []) {
        const u = (d as Decl & { utility?: string }).utility;
        if (u && !m.has(d.prop)) m.set(d.prop, u);
      }
      origin.set(el.className, m);
    }
    for (const u of lifted.unlifted) {
      if (!u.className || !u.decl || u.file !== this.page) continue;
      const prop = /^([\w-]+):/.exec(u.decl)?.[1];
      const utility = prop && origin.get(u.className)?.get(prop);
      if (utility && !u.decl.startsWith(utility)) u.decl = `${utility} → ${u.decl}`;
    }
    lifted.yaml = emitYaml(lifted.data, this.page, lifted.unlifted).replace(/^# Lifted from (.*) by cadesa lift\./m, `# Lifted from $1 (Tailwind, ${this.css.file}) by cadesa lift.`);
    const resp = this.els.filter((e) => e.id && e.roles.some((r) => r === "hidden") && e.roles.some((r) => r !== "hidden" && r !== "out"));
    if (resp.length)
      lifted.yaml += `\n# Shown at some widths only (display: none elsewhere): ${resp.map((e) => `#${e.id}`).join(", ")}.\n# Cadesa sources have no display: none; cadesa --tailwind lays these out only where they're shown.\n`;
  }

  generatedHtml(): string {
    const edits: { at: number; end: number; text: string }[] = [];
    for (const el of this.els) {
      if (!el.className) continue;
      const loc = el.node.sourceCodeLocation;
      if (!loc?.startTag) continue;
      const cls = loc.attrs?.class;
      const value = [...el.classes, el.className].join(" ");
      if (cls) edits.push({ at: cls.startOffset, end: cls.endOffset, text: `class="${value}"` });
      else edits.push({ at: loc.startTag.startOffset + 1 + el.tag.length, end: loc.startTag.startOffset + 1 + el.tag.length, text: ` class="${value}"` });
      if (!attr(el.node, "data-fixture")) edits.push({ at: loc.startTag.startOffset + 1 + el.tag.length, end: loc.startTag.startOffset + 1 + el.tag.length, text: ` data-fixture="${el.id}"` });
    }
    edits.sort((a, b) => b.at - a.at || b.end - a.end);
    let out = this.html;
    for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
    return out;
  }
}

function innerWidth(b: Box) {
  const border = b.props.border ? 1 : 0;
  return b.w - 2 * ((b.props.padding?.value.inline ?? 0) + border);
}


function splitLayers(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of v) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function hexifyPaint(v: string, current: string): string {
  // Colors inside gradients and shadows: oklch()/rgb()/color-mix()/named → hex.
  let out = "";
  let i = 0;
  const re = /\b(oklch|oklab|rgba?|hsla?|color-mix)\(/g;
  for (let m = re.exec(v); m; m = re.exec(v)) {
    if (m.index < i) continue;
    let depth = 0;
    let j = m.index + m[1].length;
    for (; j < v.length; j++) {
      if (v[j] === "(") depth++;
      else if (v[j] === ")" && --depth === 0) break;
    }
    const fn = v.slice(m.index, j + 1);
    const c = parseColor(fn, parseColor(current));
    out += v.slice(i, m.index) + (c ? hexOf(c) : fn);
    i = j + 1;
    re.lastIndex = i;
  }
  out += v.slice(i);
  return out.replace(/\bcurrentcolor\b/gi, current).replace(/#([0-9a-f]{3,8})\b/gi, (h) => {
    const c = parseColor(h);
    return c ? hexOf(c) : h;
  });
}
