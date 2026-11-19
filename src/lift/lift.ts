/**
 * lift: convert plain CSS into a Cadesa source, as far as it fits the language.
 *
 * Each element (BEM root or slot) gets the declarations the cascade would give it in every
 * breakpoint state (base + each `max-width` media query, ordered by specificity and source
 * order). Those effective declarations are mapped to Cadesa props; each narrower state becomes
 * a `when` override holding only what changed. Everything that doesn't map is kept as an
 * `Unlifted` record with what it can affect (geometry, text, visual, paint, state), so impact.ts
 * can say which boxes are no longer exactly predicted.
 */
import { Document, isMap, isScalar, visit } from "yaml";
import { parseCss, specificity, splitSelectors, type CssRule, type Decl, type ParsedCss } from "./css.js";
import { classify } from "./selectors.js";
import { validate } from "../validate.js";
import { lengthExpr } from "../fluid.js";
import { parseContain } from "../model.js";
import { originOf, transformList } from "../engine/transform.js";
import { parseAreas, parseLinePair, parseTrackList } from "../engine/grid.js";

/**
 * What an unmodelled declaration can change: a box's size and everything that follows (geometry,
 * text), only its height (height: its width and its content's layout are known), only how it's
 * drawn where it is (visual), paint, an interactive state, or nothing.
 */
export type ImpactKind = "geometry" | "text" | "height" | "visual" | "paint" | "state" | "none";

export interface Unlifted {
  file: string;
  line: number;
  selector: string;
  decl?: string;
  reason: string;
  kind: ImpactKind;
  /** The class this applies to when the selector is a BEM root or slot. */
  className?: string;
  /** Width range the record applies in (undefined: all widths). */
  when?: { maxPx?: number; minPx?: number; raw: string };
}

/** Effective declarations for one element, per breakpoint state (key: state max px, Infinity = base). */
export interface LiftedElement {
  className: string;
  block: string;
  element?: string;
  states: Map<number, Map<string, Decl>>;
}

export interface LiftResult {
  file: string;
  prefix: string;
  data: Record<string, unknown>;
  yaml: string;
  unlifted: Unlifted[];
  elements: LiftedElement[];
  /** Per block: properties a `.block *` / `.block :where(*)` reset sets on every descendant. */
  resets: Map<string, Set<string>>;
  /** Browser defaults (margins, bold headings, control padding) are already in the declarations. */
  uaInCascade?: boolean;
  stats: { declarations: number; unlifted: number; components: number; tokens: number; breakpoints: number };
}

// ---------------------------------------------------------------- property classes

const PAINT =
  /^(color-scheme|color-adjust|print-color-adjust|forced-color-adjust|color|background(-color|-image|-position|-size|-repeat|-clip|-origin|-attachment)?|box-shadow|outline.*|opacity|cursor|transition.*|animation.*|text-decoration.*|text-shadow|text-align|border(-top|-right|-bottom|-left)?-color|border(-top|-right|-bottom|-left)?-(left|right)?-?radius|border-radius|fill|stroke.*|filter|backdrop-filter|visibility|pointer-events|user-select|caret-color|accent-color|will-change|z-index|mix-blend-mode|appearance|-webkit-.*|-moz-.*|list-style.*|object-.*|scroll-.*|isolation|content|resize|touch-action|clip-path|mask.*)$/;
const TEXT =
  /^(font.*|letter-spacing|word-spacing|text-transform|white-space|line-height|text-indent|word-break|overflow-wrap|word-wrap|hyphens|tab-size|text-wrap.*|direction|unicode-bidi|writing-mode|text-rendering|font-kerning)$/;
const VISUAL = /^(transform|translate|rotate|scale|perspective.*|transform-origin)$/;

/**
 * Paint that changes neither a text's color nor what is painted behind it in the default state
 * (transitions, cursors, outlines, border colors and radii, the ellipsis of text-overflow): no
 * effect on boxes or on contrast.
 */
const COLORLESS =
  /^((-webkit-)?transition.*|cursor|counter-(reset|increment|set)|text-rendering|font-display|image-rendering|shape-rendering|(page-)?break-(before|after|inside)|orphans|widows|speak|backface-visibility|scrollbar-(width|color)|-webkit-text-stroke.*|text-underline-offset|text-underline-position|(-webkit-|-moz-|-ms-)?user-select|pointer-events|touch-action|will-change|resize|scroll-.*|overscroll-.*|caret-color|accent-color|outline.*|border(-top|-right|-bottom|-left)?-color|border(-top|-bottom)?(-left|-right)?-radius|border-(start|end)-(start|end)-radius|list-style.*|isolation|text-decoration.*|(-webkit-)?print-color-adjust|color-adjust|forced-color-adjust|-webkit-tap-highlight-color|(-webkit-|-moz-|-ms-)?text-size-adjust|-webkit-font-smoothing|-moz-osx-font-smoothing|-webkit-touch-callout|-webkit-overflow-scrolling|z-index|text-align|text-overflow)$/;

export function kindOf(prop: string): ImpactKind {
  if (COLORLESS.test(prop)) return "none";
  if (PAINT.test(prop)) return "paint";
  if (TEXT.test(prop)) return "text";
  if (VISUAL.test(prop)) return "visual";
  return "geometry";
}

const RANK: Record<ImpactKind, number> = { none: 0, state: 1, paint: 2, visual: 3, height: 4, text: 5, geometry: 6 };
export const worst = (kinds: ImpactKind[]) => kinds.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "none" as ImpactKind);

// ---------------------------------------------------------------- values

const LENGTH = /^(?:\d+(?:\.\d+)?|\.\d+)(px|rem)$/;
const SIGNED_LENGTH = /^-?(?:\d+(?:\.\d+)?|\.\d+)(px|rem)$/;
const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000" };
const IDENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const pxOf = (raw: string) => parseFloat(raw) * (raw.endsWith("rem") ? 16 : 1);
const isZero = (v: string) => /^0(?:\.0+)?(?:px|rem|em|%)?$/.test(v.trim());

function toHex(v: string): string | undefined {
  const s = v.trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) return s;
  if (NAMED[s]) return NAMED[s];
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (!m) return undefined;
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const a = m[4] === undefined ? undefined : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return `#${h(+m[1])}${h(+m[2])}${h(+m[3])}${a === undefined || a >= 1 ? "" : h(a * 255)}`;
}

const sanitize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "n$1");

type Cat = "space" | "size" | "color" | "radius" | "font" | "paint" | "shadow";
const PAINT_VALUE = /^(?:(?:repeating-)?(?:linear|radial|conic)-gradient|url|image-set)\(/;

class Tokens {
  cats = new Map<Cat, Map<string, string>>();
  private byValue = new Map<string, string>();

  private add(cat: Cat, name: string, raw: string): string {
    const m = this.cats.get(cat) ?? new Map<string, string>();
    this.cats.set(cat, m);
    let n = IDENT.test(name) ? name : `t-${sanitize(name) || "x"}`;
    for (let i = 2; m.has(n) && m.get(n) !== raw; i++) n = `${name}-${i}`;
    m.set(n, raw);
    this.byValue.set(`${cat}:${raw}`, n);
    return n;
  }

  literal(cat: Cat, raw: string): string {
    const known = this.byValue.get(`${cat}:${raw}`);
    if (known) return known;
    if ((cat === "space" || cat === "size" || cat === "radius") && /[(]|vw\b/.test(raw)) return this.add(cat, `${cat}-fluid-${(this.cats.get(cat)?.size ?? 0) + 1}`, raw);
    if (raw.startsWith("-")) return this.add(cat, `${raw.endsWith("%") ? "pct" : "px"}-n${String(Math.round(-pxOf(raw) * 100) / 100).replace(".", "-")}`, raw);
    const name =
      cat === "paint" || cat === "shadow"
        ? `${cat}-${(this.cats.get(cat)?.size ?? 0) + 1}`
        : cat === "color"
        ? `hex-${raw.slice(1)}`
        : cat === "font"
          ? sanitize(raw.split(",")[0].replace(/["']/g, "")) || "font"
          : raw.endsWith("%")
            ? `pct-${String(parseFloat(raw)).replace(".", "-")}`
            : `px-${String(Math.round(pxOf(raw) * 100) / 100).replace(".", "-")}`;
    return this.add(cat, name, raw);
  }

  named(cat: Cat, varName: string, raw: string): string {
    const stripped = varName.replace(new RegExp(`^--(?:ca-)?(?:${cat}-)?`), "");
    return this.add(cat, sanitize(stripped) || cat, raw);
  }

  count() {
    return [...this.cats.values()].reduce((n, m) => n + m.size, 0);
  }
}

// ---------------------------------------------------------------- shorthand expansion

function sides(v: string): [string, string, string, string] | undefined {
  const p = v.trim().split(/\s+(?![^(]*\))/);
  if (p.length === 1) return [p[0], p[0], p[0], p[0]];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  if (p.length === 3) return [p[0], p[1], p[2], p[1]];
  if (p.length === 4) return [p[0], p[1], p[2], p[3]];
  return undefined;
}

/** Expand the shorthands lift understands into longhands. Unknown shorthands pass through. */
function expand(d: Decl): Decl[] {
  const mk = (prop: string, value: string) => ({ ...d, prop, value });
  const box = (base: string) => {
    const s = sides(d.value);
    return s ? ["top", "right", "bottom", "left"].map((k, i) => mk(`${base}-${k}`, s[i])) : [d];
  };
  const axis = (base: string, a: string, b: string, value: string) => {
    const p = value.trim().split(/\s+/);
    return [mk(`${base}-${a}`, p[0]), mk(`${base}-${b}`, p[1] ?? p[0])];
  };
  switch (d.prop) {
    case "padding":
    case "margin":
      return box(d.prop);
    case "padding-block":
    case "margin-block":
      return axis(d.prop.split("-")[0], "top", "bottom", d.value);
    case "padding-inline":
    case "margin-inline":
      return axis(d.prop.split("-")[0], "left", "right", d.value);
    case "gap": {
      const p = d.value.trim().split(/\s+/);
      return [mk("row-gap", p[0]), mk("column-gap", p[1] ?? p[0])];
    }
    case "border": {
      if (/^(?:none|0)$/.test(d.value.trim())) return ["top", "right", "bottom", "left"].map((k) => mk(`border-${k}-width`, "0"));
      const m = /^(\S+)\s+(solid|dashed|dotted|double|none)\s+(.+)$/.exec(d.value.trim());
      if (!m) return [d];
      return ["top", "right", "bottom", "left"].flatMap((k) => [
        mk(`border-${k}-width`, m[2] === "none" ? "0" : m[1]),
        mk(`border-${k}-style`, m[2]),
        mk(`border-${k}-color`, m[3]),
      ]);
    }
    case "border-width":
      return box("border").map((x) => ({ ...x, prop: `${x.prop}-width` }));
    case "background": {
      const hex = toHex(d.value);
      if (PAINT_VALUE.test(d.value.trim())) return [mk("background-image", d.value)];
      return hex || d.value.trim() === "transparent" || d.value.trim() === "none" || d.value.startsWith("var(")
        ? [mk("background-color", d.value)]
        : [d];
    }
    case "font": {
      if (d.value.trim() === "inherit") return [mk("font-family", "inherit"), mk("font-size", "inherit"), mk("font-weight", "inherit"), mk("line-height", "inherit")];
      const m = /^(?:(normal|italic|oblique)\s+)?(?:(normal|bold|bolder|lighter|\d{3})\s+)?([\d.]+(?:px|rem|em|%))(?:\s*\/\s*([\d.]+(?:px|rem|em|%)?|normal))?\s+(.+)$/.exec(
        d.value.trim(),
      );
      if (!m) return [d];
      const out = [mk("font-size", m[3]), mk("font-family", m[5]), mk("font-weight", m[2] ?? "400"), mk("line-height", m[4] ?? "normal")];
      if (m[1] && m[1] !== "normal") out.push(mk("font-style", m[1]));
      return out;
    }
    case "flex":
      return [mk("flex", d.value.trim())];
    case "overflow":
      return axis("overflow", "x", "y", d.value);
    default:
      return [d];
  }
}

/** Per-side tokens as Cadesa writes them: one value, { block, inline }, or sides (a missing side is 0). */
function sidesValue(t: (string | undefined)[], all?: "width"): string | Record<string, string> {
  const [top, right, bottom, left] = t;
  if (top && top === right && right === bottom && bottom === left) return all ? { [all]: top } : top;
  const m: Record<string, string> = {};
  if (top && top === bottom) m.block = top;
  else {
    if (top) m.top = top;
    if (bottom) m.bottom = bottom;
  }
  if (left && left === right) m.inline = left;
  else {
    if (right) m.right = right;
    if (left) m.left = left;
  }
  if (all) {
    // Border sides: no block/inline axes; spell each side.
    const out: Record<string, string> = {};
    for (const [k, i] of [["top", 0], ["right", 1], ["bottom", 2], ["left", 3]] as const) if (t[i]) out[k] = t[i]!;
    return out;
  }
  return m;
}

/** flex shorthand → grow, shrink, basis (undefined when it can't be read). */
export function parseFlex(v: string): { grow: number; shrink: number; basis: string } | undefined {
  if (v === "none") return { grow: 0, shrink: 0, basis: "auto" };
  if (v === "auto") return { grow: 1, shrink: 1, basis: "auto" };
  if (v === "initial") return { grow: 0, shrink: 1, basis: "auto" };
  const p = v.split(/\s+/);
  const num = (x: string | undefined) => (x !== undefined && /^\d*\.?\d+$/.test(x) ? parseFloat(x) : undefined);
  const g = num(p[0]);
  if (g === undefined) return p.length === 1 ? { grow: 1, shrink: 1, basis: p[0] } : undefined;
  if (p.length === 1) return { grow: g, shrink: 1, basis: "0" };
  const sh = num(p[1]);
  if (p.length === 2) return sh === undefined ? { grow: g, shrink: 1, basis: p[1] } : { grow: g, shrink: sh, basis: "0" };
  if (p.length === 3 && sh !== undefined) return { grow: g, shrink: sh, basis: p[2] };
  return undefined;
}

const UNSETTABLE_PROPS = new Set(["padding", "margin", "background", "backdrop", "border", "shadow", "radius", "maxWidth", "measure", "width", "height", "minHeight", "aspect", "grow", "transform", "text"]);

// ---------------------------------------------------------------- the lift

export function lift(file: string, cssText: string): LiftResult {
  return liftParsed(parseCss(file, cssText));
}

interface ElementRule {
  rule: CssRule;
  spec: [number, number, number];
}

export function liftParsed(css: ParsedCss): LiftResult {
  const unlifted: Unlifted[] = [];
  const resets = new Map<string, Set<string>>();
  let declarations = 0;

  const resolveVarRaw = (v: string): string | undefined => {
    let cur = v.trim();
    for (let i = 0; i < 8; i++) {
      const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(cur);
      if (!m) return cur;
      const def = css.vars.get(m[1]);
      if (def) cur = def.value.trim();
      else if (m[2]) cur = m[2].trim();
      else return undefined;
    }
    return undefined;
  };

  for (const s of css.skipped) unlifted.push({ file: css.file, line: s.line, selector: s.text, reason: s.reason, kind: "none" });

  // 1. Classify rules.
  let pageBackground: Decl | undefined;
  /** Elements whose children are all placed in one grid cell (a layer), per state max px. */
  /** Per class: the states (max-width px, Infinity = base) whose "> *" rule puts children in one cell (true) or releases them (false). */
  const layerChildren = new Map<string, Map<number, boolean>>();
  const byClass = new Map<string, { block: string; element?: string; rules: ElementRule[] }>();
  const blockOrder: string[] = [];
  for (const rule of css.rules) {
    declarations += rule.decls.length;
    const sels = splitSelectors(rule.selector);
    const where = rule.media
      ? rule.media.maxPx !== undefined
        ? undefined
        : { minPx: rule.media.minPx, raw: rule.media.raw }
      : undefined;

    // A reset: ".b, .b :where(*)" or ".b *".
    const resetSel = sels.map(classify).find((t) => t.kind === "reset");
    if (resetSel && resetSel.kind === "reset" && !rule.media) {
      const props = new Set<string>();
      for (const d of rule.decls.flatMap(expand)) props.add(d.prop.replace(/-(top|right|bottom|left)(?=$|-)/, ""));
      resets.set(resetSel.block, props);
      continue;
    }

    for (const sel of sels) {
      // The page background: :root / html / body { background-color }.
      if (/^(?::root|html|body)$/.test(sel) && !rule.media) {
        const rest: Decl[] = [];
        for (const d of rule.decls.flatMap(expand))
          if (d.prop === "background-color" && toHex(resolveVarRaw(d.value) ?? "")) pageBackground = d;
          else if (!(d.prop === "margin-top" || d.prop === "margin-right" || d.prop === "margin-bottom" || d.prop === "margin-left") || !isZero(d.value)) rest.push(d);
        if (rest.length)
          unlifted.push({ file: css.file, line: rule.line, selector: sel, decl: rest.map((d) => `${d.prop}: ${d.value}`).join("; "), reason: "page-level styles other than the background are not modelled", kind: worst(rest.map((d) => kindOf(d.prop))) });
        continue;
      }
      // Layer children: ".x > * { grid-area: 1 / 1 }".
      const lc = /^(.+?)\s*>\s*\*$/.exec(sel);
      const lt = lc ? classify(lc[1]) : undefined;
      const ga = rule.decls.length === 1 && /^grid-area$/.test(rule.decls[0].prop) ? rule.decls[0].value.trim() : undefined;
      if (lt && (lt.kind === "root" || lt.kind === "slot") && ga && /^(?:1\s*\/\s*1(\s*\/\s*2\s*\/\s*2)?|auto)$/.test(ga) && (!rule.media || rule.media.maxPx !== undefined)) {
        const cls = lt.kind === "root" ? lt.block : `${lt.block}__${lt.element}`;
        const states = layerChildren.get(cls) ?? new Map<number, boolean>();
        states.set(rule.media?.maxPx ?? Infinity, ga !== "auto");
        layerChildren.set(cls, states);
        continue;
      }
      const t = classify(sel);
      if ((t.kind === "root" || t.kind === "slot") && !where && !(rule.media && rule.media.maxPx === undefined)) {
        const className = t.kind === "root" ? t.block : `${t.block}__${t.element}`;
        if (!byClass.has(className)) byClass.set(className, { block: t.block, element: t.kind === "slot" ? t.element : undefined, rules: [] });
        if (!blockOrder.includes(t.block)) blockOrder.push(t.block);
        byClass.get(className)!.rules.push({ rule, spec: specificity(sel) });
      } else {
        const kinds = rule.decls.map((d) => kindOf(d.prop));
        const state = /:(hover|focus|focus-visible|focus-within|active|visited)\b/.test(sel);
        const pseudoEl = /::?(before|after)\b/.test(sel);
        unlifted.push({
          file: css.file,
          line: rule.line,
          selector: sel,
          decl: rule.decls.map((d) => `${d.prop}: ${d.value}`).join("; "),
          reason: rule.media && rule.media.maxPx === undefined
            ? `@media ${rule.media.raw} is not modelled (Cadesa breakpoints are max-width)`
            : state
              ? "interactive state; the default state is unaffected"
              : pseudoEl
                ? "generated content (::before/::after) is not modelled"
                : "selector is not a BEM root (.block) or slot (.block__element)",
          kind: state && !(rule.media && rule.media.maxPx === undefined) ? "state" : pseudoEl ? "geometry" : worst(kinds),
          when: rule.media && rule.media.maxPx === undefined ? { minPx: rule.media.minPx, raw: rule.media.raw.replace(/^\((.*)\)$/, "$1") } : undefined,
        });
      }
    }
  }

  // Prefix: "ca-" if every block uses it (e.g. CSS compiled by Cadesa), else none.
  const prefix = blockOrder.length && blockOrder.every((b) => b.startsWith("ca-") && b.length > 3) ? "ca-" : "";

  // 2. Breakpoint states, widest first.
  const bpPx = [...new Set(css.rules.filter((r) => r.media?.maxPx !== undefined).map((r) => r.media!.maxPx!))].sort((a, b) => b - a);
  const bpRaw = new Map(css.rules.filter((r) => r.media?.maxPx !== undefined).map((r) => [r.media!.maxPx!, r.media!.maxRaw!]));
  const states = [Infinity, ...bpPx];

  // 3. Effective declarations per element per state.
  const elements: LiftedElement[] = [];
  for (const [className, e] of byClass) {
    const st = new Map<number, Map<string, Decl>>();
    for (const s of states) {
      const applicable = e.rules
        .filter((r) => !r.rule.media || r.rule.media.maxPx! >= s)
        .sort((a, b) => {
          for (let i = 0; i < 3; i++) if (a.spec[i] !== b.spec[i]) return a.spec[i] - b.spec[i];
          return a.rule.order - b.rule.order;
        });
      const map = new Map<string, Decl>();
      for (const r of applicable)
        for (const d of r.rule.decls.flatMap(expand)) {
          const prev = map.get(d.prop);
          if (prev?.important && !d.important) continue;
          map.set(d.prop, d);
        }
      st.set(s, map);
    }
    elements.push({ className, block: e.block, element: e.element, states: st });
  }

  return liftElements({ file: css.file, vars: css.vars, notes: css.notes, prefix, elements, blockOrder, bpPx, bpRaw, layerChildren, pageBackground, unlifted, resets, declarations });
}

/**
 * Everything lift needs once each element's effective declarations per breakpoint state are known.
 * liftParsed computes them from a stylesheet's cascade; other front ends (Tailwind) compute their own.
 */
export interface LiftInput {
  /** File named in reports (and the `# Lifted from` header). */
  file: string;
  /** Custom properties that `var()` values in the declarations refer to. Names become token names. */
  vars: Map<string, Decl>;
  /** Per component: an `intent` note. */
  notes: Map<string, string>;
  prefix: string;
  /** Each element's `states` has the base state (Infinity) and every px in `bpPx`. */
  elements: LiftedElement[];
  blockOrder: string[];
  /** Max-width breakpoint states narrower than the base, widest first, in px. */
  bpPx: number[];
  /** The breakpoint's length as written (e.g. "47.99rem"), per px. */
  bpRaw: Map<number, string>;
  /** Breakpoint name per px (default: max-<raw>). */
  bpName?: (px: number) => string;
  /**
   * Per class: the states (max-width px, Infinity = base) whose "> *" rule puts children in one
   * grid cell (true, a layer) or releases them (false).
   */
  layerChildren: Map<string, Map<number, boolean>>;
  pageBackground?: Decl;
  /** The page's insets per side, as CSS lengths: the body's margin and padding, and the root element's (outer). */
  pageSides?: { margin?: string[]; padding?: string[]; outer?: string[]; overflow?: string; windowHeight?: number };
  /** Records found before mapping (more are added). */
  unlifted: Unlifted[];
  resets: Map<string, Set<string>>;
  /** Browser defaults are part of the declarations (a page front end computed the whole cascade). */
  uaInCascade?: boolean;
  /**
   * `width: 100%` becomes a "100%" size token rather than fill (exact in a cluster too). Lifting
   * Cadesa's own output keeps fill.
   */
  fullWidthAsPercent?: boolean;
  /** Each element's declarations are its whole cascade (a page lift): a property it lacks is unset. */
  wholeCascade?: boolean;
  /** Declarations read, for stats. */
  declarations: number;
}

export function liftElements(input: LiftInput): LiftResult {
  const css = { file: input.file, vars: input.vars, notes: input.notes };
  const { prefix, elements, blockOrder, bpPx, bpRaw, layerChildren, pageBackground, unlifted, resets, declarations } = input;
  const component = (block: string) => block.slice(prefix.length);
  const bpName = input.bpName ?? ((px: number) => `max-${bpRaw.get(px)!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  const states = [Infinity, ...bpPx];
  const tokens = new Tokens();

  // 4. Map declarations to props, per state.
  const roles = new Map<string, { name: string; spec: Record<string, unknown> }>();
  const unliftedByKey = new Map<string, Unlifted>();
  const note = (e: LiftedElement, s: number, d: Decl, reason: string, kind: ImpactKind = kindOf(d.prop)) => {
    const key = `${d.line}:${d.prop}:${e.className}`;
    const prev = unliftedByKey.get(key);
    const maxPx = s === Infinity ? undefined : s;
    if (prev) {
      if (prev.when && (maxPx === undefined || (prev.when.maxPx !== undefined && maxPx > prev.when.maxPx)))
        prev.when = maxPx === undefined ? undefined : { maxPx, raw: `max-width: ${bpRaw.get(maxPx)}` };
      return;
    }
    unliftedByKey.set(key, {
      file: css.file,
      line: d.line,
      selector: `.${e.className}`,
      decl: `${d.prop}: ${d.value}`,
      reason,
      kind,
      className: e.className,
      when: maxPx === undefined ? undefined : { maxPx, raw: `max-width: ${bpRaw.get(maxPx)}` },
    });
  };

  /** Resolve var() references. Returns the raw value and the var name it came from. */
  const resolveVar = (v: string, depth = 0): { raw: string; varName?: string } | undefined => {
    const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(v.trim());
    if (!m) return { raw: v.trim() };
    const def = css.vars.get(m[1]);
    if (def && depth < 8) {
      const inner = resolveVar(def.value, depth + 1);
      return inner ? { raw: inner.raw, varName: m[1] } : undefined;
    }
    return m[2] ? { raw: m[2].trim() } : undefined;
  };

  const lengthToken = (cat: Cat, value: string, signed = false): string | undefined => {
    const r = resolveVar(value);
    if (!r) return undefined;
    let raw = r.raw;
    if (isZero(raw)) raw = "0px";
    if (!(signed ? SIGNED_LENGTH : LENGTH).test(raw)) {
      // A length that follows the viewport width (vw, clamp()...): its own token, computed per width.
      const f = lengthExpr(raw);
      return f?.fluid ? tokens.literal(cat, f.css) : undefined;
    }
    // A negative value is its own token (a var named for a gutter may hold either sign elsewhere).
    return r.varName && !raw.startsWith("-") ? tokens.named(cat, r.varName, raw) : tokens.literal(cat, raw);
  };
  /** A percentage size token (a gap between columns: of the container's width). */
  const pctToken = (value: string): string | undefined => {
    const r = resolveVar(value);
    if (r && /^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(r.raw) && parseFloat(r.raw) > 0 && parseFloat(r.raw) <= 100)
      return r.varName ? tokens.named("size", r.varName, r.raw) : tokens.literal("size", r.raw);
    return undefined;
  };
  /** A size token that may be a percentage of the parent's width (width, max-width). */
  const sizeToken = (value: string): string | undefined => {
    const r = resolveVar(value);
    if (r && /^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(r.raw) && parseFloat(r.raw) > 0 && parseFloat(r.raw) <= 100)
      return r.varName ? tokens.named("size", r.varName, r.raw) : tokens.literal("size", r.raw);
    // Percentages in calc(), min(), max() or clamp() ("min(440px, 100%)"): computed per box.
    const f = r ? lengthExpr(r.raw, { pct: true }) : undefined;
    return lengthToken("size", value) ?? (f?.pct ? tokens.literal("size", f.css) : undefined);
  };
  /** Padding or a margin with a percentage of the containing block's width in it ("7%", "calc(5% - 8px)"): a size token. */
  const sidePctToken = (value: string, signed: boolean): string | undefined => {
    const r = resolveVar(value);
    if (!r) return undefined;
    const m = /^(-?(?:\d+(?:\.\d+)?|\.\d+))%$/.exec(r.raw);
    if (m) {
      const n = parseFloat(m[1]);
      if (!isFinite(n) || (!signed && n < 0) || Math.abs(n) > 10000) return undefined;
      return r.varName && n > 0 ? tokens.named("size", r.varName, `${n}%`) : tokens.literal("size", `${n}%`);
    }
    const f = lengthExpr(r.raw, { pct: true });
    return f?.pct ? tokens.literal("size", f.css) : undefined;
  };
  /** grid-template-columns as Cadesa tracks: size tokens, "<n>fr" and "minmax(0, <n>fr)" (undefined when another kind of track is used). */
  const gridTracks = (v: string): string[] | undefined => {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of v.trim()) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (/\s/.test(ch) && depth === 0) {
        if (cur) parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur) parts.push(cur);
    const out: string[] = [];
    for (const p of parts) {
      const rep = /^repeat\(\s*(\d+)\s*,\s*(.+)\)$/s.exec(p);
      if (rep) {
        const inner = gridTracks(rep[2]);
        const n = parseInt(rep[1]);
        if (!inner || !(n >= 1 && n <= 1000)) return undefined;
        for (let i = 0; i < n; i++) out.push(...inner);
        continue;
      }
      const fr = /^(\d*\.?\d+)fr$/.exec(p);
      const mm = /^minmax\(\s*0(?:px|%)?\s*,\s*(\d*\.?\d+)fr\s*\)$/.exec(p);
      if (fr && parseFloat(fr[1]) > 0) out.push(`${parseFloat(fr[1])}fr`);
      else if (mm && parseFloat(mm[1]) > 0) out.push(`minmax(0, ${parseFloat(mm[1])}fr)`);
      else {
        const t = sizeToken(p);
        if (!t) return undefined;
        out.push(t);
      }
    }
    return out.length ? out : undefined;
  };
  const colorToken = (value: string): string | undefined => {
    const r = resolveVar(value);
    const hex = r && toHex(r.raw);
    if (!hex) return undefined;
    return r!.varName ? tokens.named("color", r!.varName, hex) : tokens.literal("color", hex);
  };

  function mapState(e: LiftedElement, s: number): Record<string, unknown> {
    const m = new Map(e.states.get(s)!);
    const out: Record<string, unknown> = {};
    const isRoot = !e.element;
    const take = (p: string) => {
      const d = m.get(p);
      m.delete(p);
      return d;
    };
    const val = (p: string) => m.get(p)?.value.trim();

    // layout
    const display = take("display");
    if (display && display.value.trim() === "flex") {
      const dir = take("flex-direction")?.value.trim() ?? "row";
      const wrap = take("flex-wrap")?.value.trim() ?? "nowrap";
      const align = take("align-items");
      const justify = take("justify-content");
      const rowGap = take("row-gap");
      const colGap = take("column-gap");
      const column = dir === "column";
      if (dir !== "row" && dir !== "column") note(e, s, display, `flex-direction: ${dir} has no Cadesa pattern`, "geometry");
      const pattern = column ? "stack" : "cluster";
      const av = align?.value.trim();
      const CLUSTER_ALIGN: Record<string, string> = { center: "center", "flex-start": "start", start: "start", "flex-end": "end", end: "end", stretch: "stretch", normal: "stretch" };
      // Across a column: stretched, or as wide as their content at the start, center or end (baseline is start there).
      const STACK_ALIGN: Record<string, string> = { ...CLUSTER_ALIGN, "self-start": "start", "self-end": "end", left: "start", right: "end", baseline: "start", "first baseline": "start" };
      const stackAlign = column && av !== undefined ? STACK_ALIGN[av] : undefined;
      if (align && column && !stackAlign) note(e, s, align, `align-items: ${av} has no Cadesa equivalent`, "geometry");
      const clusterAlign = av === undefined ? "stretch" : CLUSTER_ALIGN[av];
      if (!column && !clusterAlign) note(e, s, align!, `align-items: ${av} has no Cadesa equivalent`, "geometry");
      const jv = justify?.value.trim();
      const JUSTIFY: Record<string, string> = { "flex-start": "start", start: "start", normal: "start", left: "start", "flex-end": "end", end: "end", right: "end", center: "center", "space-between": "between", "space-around": "around", "space-evenly": "evenly" };
      const clusterJustify = jv === undefined || column ? undefined : JUSTIFY[jv];
      if (justify && column && !["flex-start", "start", "normal", "left"].includes(jv!) && m.has("height"))
        note(e, s, justify, `justify-content: ${jv} in a column has no Cadesa equivalent`, "geometry");
      else if (justify && !column && !clusterJustify) note(e, s, justify, `justify-content: ${jv} has no Cadesa equivalent`, "geometry");
      // A stack's gap is its row gap; a cluster's its column gap, with the gap between its lines (row-gap) when that differs.
      const gapDecl = column ? rowGap : colGap;
      const tokenOf = (d: Decl | undefined) => {
        if (!d || isZero(resolveVar(d.value)?.raw ?? "x")) return undefined;
        // A row's gap between columns may be a percentage of its width.
        const t = lengthToken("space", d.value) ?? (!column && d === colGap ? pctToken(d.value) : undefined);
        if (!t) note(e, s, d, !column && d === colGap ? "gap must be a px or rem length, or a percentage" : "gap must be a px or rem length", "geometry");
        return t;
      };
      const gap = tokenOf(gapDecl);
      const valueOf = (d: Decl | undefined) => (d && !isZero(resolveVar(d.value)?.raw ?? "x") ? resolveVar(d.value)?.raw : "0px");
      const lineGap = !column && valueOf(rowGap) !== valueOf(colGap) ? (rowGap && !isZero(resolveVar(rowGap.value)?.raw ?? "x") ? tokenOf(rowGap) : lengthToken("space", "0px")) : undefined;
      out.layout = {
        pattern,
        ...(gap && { gap }),
        ...(lineGap && { rowGap: lineGap }),
        ...(!column && clusterAlign && clusterAlign !== "center" && { align: clusterAlign }),
        ...(stackAlign && stackAlign !== "stretch" && { align: stackAlign }),
        ...(clusterJustify && clusterJustify !== "start" && { justify: clusterJustify }),
        ...(!column && wrap === "nowrap" && { wrap: false }),
      };
    } else if (display && display.value.trim() === "flow") {
      // A page front end's marker: a block container whose children are block boxes.
      out.layout = { pattern: "flow" };
    } else if (display && display.value.trim() === "grid") {
      const cols = take("grid-template-columns");
      const align = take("align-items");
      const justify = take("justify-items");
      const rowGap = take("row-gap");
      const colGap = take("column-gap");
      const cv = cols?.value.trim() ?? "";
      const auto = /^repeat\(\s*auto-fill\s*,\s*minmax\(\s*(?:min\(\s*(.+?)\s*,\s*100%\s*\)|([^,]+?))\s*,\s*1fr\s*\)\s*\)$/.exec(cv);
      // The narrowest "> *" rule that applies in this state decides.
      const applying = [...(layerChildren.get(e.className) ?? [])].filter(([px]) => px >= s).sort((a, b) => a[0] - b[0]);
      const layered = applying[0]?.[1] ?? false;
      const GA: Record<string, string> = { start: "start", "flex-start": "start", center: "center", end: "end", "flex-end": "end", stretch: "stretch", normal: "stretch" };
      const a = align ? GA[align.value.trim()] : "stretch";
      if (align && !a) note(e, s, align, `align-items: ${align.value.trim()} has no Cadesa equivalent`, "geometry");
      const JI: Record<string, string> = { start: "start", "flex-start": "start", left: "start", "self-start": "start", center: "center", end: "end", "flex-end": "end", right: "end", "self-end": "end", stretch: "stretch", normal: "stretch", legacy: "stretch" };
      const j = justify ? JI[justify.value.trim()] : "stretch";
      // The column gap, and the row gap when it differs.
      const gapOf = (): Record<string, string> => {
        // Either gap may be a percentage: the column gap of the grid's width, the row gap of its height (the page front end keeps it only where that is modelled).
        const tok = (d: Decl | undefined) => (d && !isZero(resolveVar(d.value)?.raw ?? "x") ? (lengthToken("space", d.value) ?? pctToken(d.value)) : undefined);
        const val = (d: Decl | undefined) => (d && !isZero(resolveVar(d.value)?.raw ?? "x") ? resolveVar(d.value)?.raw : "0px");
        for (const d of [rowGap, colGap]) if (d && !isZero(resolveVar(d.value)?.raw ?? "x") && !tok(d)) note(e, s, d, "gap must be a px or rem length", "geometry");
        const g = tok(colGap);
        const rg = val(rowGap) !== val(colGap) || /%$/.test(val(rowGap) ?? "") ? (tok(rowGap) ?? lengthToken("space", "0px")) : undefined;
        return { ...(g && { gap: g }), ...(rg && { rowGap: rg }) };
      };
      if (auto) {
        const min = lengthToken("size", auto[1] ?? auto[2]);
        if (!min) note(e, s, cols!, "the grid's minimum column width must be a px or rem length", "geometry");
        else {
          if (justify && !j) note(e, s, justify, `justify-items: ${justify.value.trim()} has no Cadesa equivalent`, "geometry");
          out.layout = { pattern: "grid", min, ...gapOf(), ...(a && a !== "stretch" && { align: a }), ...(j && j !== "stretch" && { justify: j }) };
        }
      } else if (layered && (!cols || /^(?:minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)|1fr)$/.test(cv))) {
        if (justify && j !== "stretch") note(e, s, justify, "a layer's children always stretch across it", "geometry");
        out.layout = { pattern: "layer", ...(a && a !== "stretch" && { align: a }) };
      } else {
        const tracks = cols && cv !== "none" ? gridTracks(cv) : undefined;
        // The rest of a grid's template: CSS Grid's own algorithm (layout.template).
        const more = (["grid-template-rows", "grid-template-areas", "grid-auto-rows", "grid-auto-columns", "grid-auto-flow", "justify-content", "align-content"] as const).map((p) => [p, take(p)] as const);
        if (cols && cv !== "none" && !tracks && !parseTrackList(cv.replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${parseFloat(n) * 16}px`)))
          note(e, s, cols, `grid-template-columns: ${cv} has no Cadesa pattern`, "geometry");
        else if (!tracks || more.some(([, d]) => d)) {
          const template: Record<string, unknown> = {};
          const px = (v: string) => (resolveVar(v)?.raw ?? v).replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${Math.round(parseFloat(n) * 16 * 1e6) / 1e6}px`).trim();
          const KEY: Record<string, string> = { "grid-template-rows": "rows", "grid-auto-rows": "autoRows", "grid-auto-columns": "autoColumns" };
          const list = (d: Decl, key: string) => {
            const v = px(d.value);
            if (v === "none" || (key.startsWith("auto") && v === "auto")) return;
            if (parseTrackList(v) && !(key.startsWith("auto") && parseTrackList(v)!.repeat)) template[key] = v;
            else note(e, s, d, `${d.prop}: ${v} isn't a track list Cadesa reads`, "geometry");
          };
          if (cols && cv !== "none") list({ ...cols, value: cv }, "columns");
          const CONTENT: Record<string, string> = { normal: "", stretch: "", start: "start", "flex-start": "start", left: "start", center: "center", end: "end", "flex-end": "end", right: "end", "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly" };
          for (const [p, d] of more) {
            if (!d) continue;
            const v = px(d.value);
            if (KEY[p]) list(d, KEY[p]);
            else if (p === "grid-template-areas") {
              const rows = v === "none" ? [] : [...v.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
              if (rows.length && parseAreas(rows)) template.areas = rows;
              else if (v !== "none") note(e, s, d, `grid-template-areas: ${v} isn't a template Cadesa reads`, "geometry");
            } else if (p === "grid-auto-flow") {
              if (/^(row\s+dense|dense\s+row|dense)$/.test(v)) template.dense = true;
              else if (v !== "row") note(e, s, d, `grid-auto-flow: ${v} isn't modelled (row and dense are)`, "geometry");
            } else {
              const c = CONTENT[v];
              if (c === undefined) note(e, s, d, `${p}: ${v} has no Cadesa equivalent`, "geometry");
              else if (c) template[p === "justify-content" ? "justifyContent" : "alignContent"] = c;
            }
          }
          if (justify && !j) note(e, s, justify, `justify-items: ${justify.value.trim()} has no Cadesa equivalent`, "geometry");
          out.layout = { pattern: "grid", template, ...gapOf(), ...(a && a !== "stretch" && { align: a }), ...(j && j !== "stretch" && { justify: j }) };
        } else {
          if (justify && !j) note(e, s, justify, `justify-items: ${justify.value.trim()} has no Cadesa equivalent`, "geometry");
          const all = tracks.every((t) => t === "minmax(0, 1fr)");
          out.layout = { pattern: "grid", columns: all ? tracks.length : tracks, ...gapOf(), ...(a && a !== "stretch" && { align: a }), ...(j && j !== "stretch" && { justify: j }) };
        }
      }
    } else if (display && display.value.trim() === "table") {
      // A table: its border spacing is its gap (and row gap, when it differs).
      const collapse = take("border-collapse")?.value.trim() === "collapse";
      const sp = take("border-spacing");
      const fixed = take("table-layout")?.value.trim() === "fixed";
      const [h, v] = (sp ? sp.value.trim().split(/\s+/) : []).concat(sp ? [sp.value.trim().split(/\s+/)[0]] : []);
      const tok = (x?: string) => (x && !isZero(x) ? lengthToken("space", x) : undefined);
      const gap = tok(h);
      const rowGap = v !== h ? (tok(v) ?? (gap ? lengthToken("space", "0px") : undefined)) : undefined;
      // Its min-width: a table is never narrower (as it is never narrower than its columns).
      const mw = take("min-width");
      const min = mw && !isZero(mw.value) && !/^auto$/.test(mw.value.trim()) ? lengthToken("size", mw.value) : undefined;
      if (mw && !isZero(mw.value) && !/^auto$/.test(mw.value.trim()) && !min) note(e, s, mw, "a table's min-width must be a px or rem length", "geometry");
      out.layout = { pattern: "table", ...(min && { min }), ...(gap && { gap }), ...(rowGap && { rowGap }), ...(collapse && { collapse: true }), ...(fixed && { fixed: true }) };
    } else if (display && !["block", "flow-root"].includes(display.value.trim())) {
      note(e, s, display, `display: ${display.value.trim()} has no Cadesa pattern`, "geometry");
    }
    const part = take("table-part");
    if (part) out.part = part.value.trim();
    for (const p of ["flex-direction", "flex-wrap", "align-items", "justify-content", "row-gap", "column-gap"]) {
      const d = take(p);
      // On a block container (Bootstrap's .navbar-collapse once .show makes it display: block) they do nothing.
      const block = !!input.wholeCascade && (!display || /^(block|flow-root|flow|inline|inline-block|list-item)$/.test(display.value.trim()));
      if (d && !(p.endsWith("gap") && isZero(d.value))) note(e, s, d, block ? `${p} only applies to a flex or grid container; no effect here` : `${p} only applies to a flex container`, block ? "none" : "geometry");
    }

    // padding
    const pad = ["top", "right", "bottom", "left"].map((k) => take(`padding-${k}`));
    if (pad.some(Boolean)) {
      const v = pad.map((d) => (d ? d.value.trim() : "0"));
      // A percentage (in calc(), min()... too): of the containing block's width, on every side.
      const t = v.map((x) => (isZero(x) ? undefined : (lengthToken("space", x) ?? sidePctToken(x, false))));
      const bad = v.findIndex((x, i) => !isZero(x) && !t[i]);
      if (bad >= 0) note(e, s, pad[bad]!, "padding must be a length or a percentage", "geometry");
      else if (t.some(Boolean)) out.padding = sidesValue(t);
    }

    // border
    const bw = ["top", "right", "bottom", "left"].map((k) => take(`border-${k}-width`));
    const bs = ["top", "right", "bottom", "left"].map((k) => take(`border-${k}-style`));
    const bc = ["top", "right", "bottom", "left"].map((k) => take(`border-${k}-color`));
    if (bw.some(Boolean)) {
      const widths = bw.map((d) => (d ? d.value.trim() : "0"));
      const styles = bs.map((d) => (d ? d.value.trim() : "none"));
      // In a table, a side with a style but no width still counts when borders collapse: it's given as 0.
      const tablePart = !!part || (out.layout as { pattern?: string } | undefined)?.pattern === "table";
      const visible = widths.map((w, i) => (!isZero(w) || tablePart) && !/^(none|hidden)$/.test(styles[i]));
      const first = visible.indexOf(true);
      if (first < 0) {
        /* no border */
      } else {
        const onePx = widths.every((w, i) => visible[i] && resolveVar(w)?.raw === "1px");
        const keyword = (w: string) => (/^thin$/.test(w) ? "1px" : /^medium$/.test(w) ? "3px" : /^thick$/.test(w) ? "5px" : w);
        const t = onePx ? [] : widths.map((w, i) => (visible[i] ? lengthToken("space", isZero(w) ? "0px" : keyword(w)) : undefined));
        const bad = onePx ? -1 : widths.findIndex((_, i) => visible[i] && !t[i]);
        const c = colorToken(bc[first]?.value ?? "currentcolor");
        if (bad >= 0) note(e, s, bw[bad] ?? bw.find(Boolean)!, "a border width must be a px or rem length", "geometry");
        else {
          if (styles.some((x, i) => visible[i] && x !== "solid")) note(e, s, bs.find((d, i) => visible[i] && d && d.value.trim() !== "solid") ?? bw.find(Boolean)!, "Cadesa borders are solid; this one paints differently", "paint");
          if (bc.some((d, i) => visible[i] && d?.value !== bc[first]?.value)) note(e, s, bc.find((d, i) => visible[i] && d?.value !== bc[first]?.value) ?? bw[first]!, "a Cadesa border has one color; the sides differ", "paint");
          if (!c) note(e, s, bc[first] ?? bw[first]!, "border color must be a hex or rgb() color", "paint");
          const color = c ?? tokens.literal("color", "#000000");
          out.border = onePx ? color : { color, ...(sidesValue(t, "width") as Record<string, string>) };
        }
      }
    }

    // radius
    const radius = take("border-radius");
    if (radius && isZero(radius.value) && s !== Infinity) out.radius = lengthToken("radius", "0px");
    else if (radius && !isZero(radius.value)) {
      const r = lengthToken("radius", radius.value);
      if (r) out.radius = r;
      else note(e, s, radius, "border-radius must be one px or rem length", "paint");
    }

    // background
    const bg = take("background-color");
    if (bg && !["transparent", "none"].includes(bg.value.trim())) {
      const c = colorToken(bg.value);
      if (c) out.background = c;
      else note(e, s, bg, "background must be a hex or rgb() color", "paint");
    }

    // margins, max-width (root: centered)
    const margins = ["top", "right", "bottom", "left"].map((k) => take(`margin-${k}`));
    const maxW = take("max-width");
    const autoX = margins[1]?.value.trim() === "auto" && margins[3]?.value.trim() === "auto";
    const both = maxW && /^min\(\s*([^,]+?)\s*,\s*([^,]+?)\s*\)$/.exec(maxW.value.trim());
    if (both && autoX && lengthToken("size", both[1]) && lengthToken("size", both[2])) {
      // Cadesa's own output when maxWidth and measure both apply: max-width: min(maxWidth, measure).
      const a = lengthToken("size", both[1]);
      const b = lengthToken("size", both[2]);
      if (a && b) {
        out.maxWidth = a;
        out.measure = b;
      } else note(e, s, maxW!, "max-width must be a px or rem length", "geometry");
    } else if (maxW && maxW.value.trim() !== "none") {
      const t = sizeToken(maxW.value);
      if (!t) note(e, s, maxW, "max-width must be a px or rem length, or a percentage", "geometry");
      else if (autoX) out.maxWidth = t;
      else out.measure = t;
    }
    // Margins: px or rem lengths per side, negative ones too; auto left and right (with max-width,
    // auto inline margins are maxWidth's centering).
    const sideTokens: (string | undefined)[] = [];
    let marginOk = true;
    margins.forEach((d, i) => {
      if (!d || isZero(d.value)) return;
      const v = d.value.trim();
      if (v === "auto" && (i === 1 || i === 3) && out.maxWidth) return;
      // auto (top and bottom: the page front end keeps them only where a flex or grid container has free space to give them).
      const t = v === "auto" ? "auto" : (lengthToken("space", v, true) ?? sidePctToken(v, true));
      if (t) sideTokens[i] = t;
      else {
        marginOk = false;
        note(e, s, d, "a margin must be a length, a percentage or auto", "geometry");
      }
    });
    if (marginOk && sideTokens.some(Boolean)) out.margin = sidesValue(sideTokens);

    // width / height / flex item
    const width = take("width");
    const alignSelf = take("align-self");
    const flex = take("flex");
    const shrink = take("flex-shrink");
    const grow = take("flex-grow");
    const basis = take("flex-basis");
    if (width) {
      const v = width.value.trim();
      if ((v === "100%" && !input.fullWidthAsPercent) || (v === "auto" && alignSelf?.value.trim() === "stretch")) out.width = "fill";
      else if (v === "fit-content") out.width = "fit";
      else if (v === "max-content" || v === "min-content") out.width = v;
      else if (v !== "auto") {
        const t = sizeToken(v);
        if (t) out.width = t;
        else note(e, s, width, "width must be a px/rem length, a percentage, or auto", "geometry");
      }
    }
    // A grid item: its lines (grid-row, grid-column) and its own alignment in its area.
    {
      const lines = ["grid-row-start", "grid-row-end", "grid-column-start", "grid-column-end"].map((p) => take(p));
      const js = take("justify-self");
      const gas = take("grid-align-self");
      const SELF: Record<string, string> = { auto: "", normal: "", stretch: "stretch", start: "start", "self-start": "start", "flex-start": "start", left: "start", center: "center", end: "end", "self-end": "end", "flex-end": "end", right: "end" };
      const place: Record<string, string> = {};
      const v = (d?: Decl) => (d ? (resolveVar(d.value)?.raw ?? d.value).trim() : "auto");
      for (const [axis, i] of [["row", 0], ["column", 2]] as const) {
        if (!lines[i] && !lines[i + 1]) continue;
        const pair = `${v(lines[i])} / ${v(lines[i + 1])}`;
        if (pair === "auto / auto") continue;
        if (parseLinePair(pair)) place[axis] = pair;
        else note(e, s, (lines[i] ?? lines[i + 1])!, `grid-${axis}: ${pair} isn't a placement Cadesa reads`, "geometry");
      }
      // A flex item's align-self (a grid item's comes as grid-align-self) is its own alignment across the line too.
      for (const [k, d] of [["justify", js], ["align", gas ?? alignSelf]] as const) {
        if (!d) continue;
        const a = SELF[v(d)];
        if (a === undefined) note(e, s, { ...d, prop: k === "align" ? "align-self" : "justify-self" }, `${k}-self: ${v(d)} has no Cadesa equivalent`, "geometry");
        else if (a) place[k] = a;
      }
      if (Object.keys(place).length) out.place = place;
    }
    // flex: <grow> <shrink> <basis>. A grow factor maps to grow (basis 0 or auto); shrinking is
    // Cadesa's own (a lone item too wide for its line), which flex-shrink: 0 switches off: page.ts
    // decides per width whether that matters.
    const fl = flex ? parseFlex(flex.value.trim()) : undefined;
    if (flex && !fl) note(e, s, flex, `flex: ${flex.value.trim()} has no Cadesa equivalent`, "geometry");
    const g = grow ? parseFloat(grow.value) : fl?.grow ?? 0;
    const b = (basis?.value.trim() ?? fl?.basis ?? "auto").replace(/^0(px|%)?$/, "0");
    void shrink;
    if (grow && isNaN(g)) note(e, s, grow, `flex-grow: ${grow.value} has no Cadesa equivalent`, "geometry");
    else if (g > 0) {
      if (b === "0") out.grow = { factor: g, basis: "zero" };
      else if (b === "auto" || b === "content") out.grow = g;
      else note(e, s, basis ?? flex!, `a flex basis of ${b} has no Cadesa equivalent (0 or auto)`, "geometry");
    } else if (b !== "auto" && b !== "0" && !(b === "content")) note(e, s, basis ?? flex!, `flex-basis: ${b} has no Cadesa equivalent`, "geometry");
    else if (b === "0" && (basis || fl)) note(e, s, basis ?? flex!, "flex-basis: 0 without a grow factor has no Cadesa equivalent", "geometry");
    const ar = take("aspect-ratio");
    if (ar) {
      const m = /^([\d.]+)\s*(?:\/\s*([\d.]+))?$/.exec(ar.value.trim());
      if (m) out.aspect = m[2] ? `${m[1]}:${m[2]}` : `${m[1]}:1`;
      else if (ar.value.trim() !== "auto") note(e, s, ar, "aspect-ratio must be a ratio like 16 / 9", "geometry");
    }
    const fit = take("object-fit");
    if (fit && ["cover", "contain"].includes(fit.value.trim())) out.fit = fit.value.trim();
    else if (fit && fit.value.trim() !== "fill") note(e, s, fit, "paint only; no effect on layout", "paint");
    // overflow: what doesn't fit scrolls or is cut off (overlay is a legacy alias of auto).
    const ox = take("overflow-x");
    const oy = take("overflow-y");
    if (ox || oy) {
      const kw = (d?: Decl) => {
        const v = d ? resolveVar(d.value)?.raw.trim().toLowerCase() : "visible";
        return v === "overlay" ? "auto" : v;
      };
      const [x, y] = [kw(ox), kw(oy)];
      const ok = (v?: string) => !!v && ["visible", "hidden", "clip", "auto", "scroll"].includes(v);
      if (!ok(x) || !ok(y)) note(e, s, (!ok(x) ? ox : oy)!, "overflow must be visible, hidden, clip, auto or scroll", "geometry");
      else if (x !== "visible" || y !== "visible") out.overflow = x === y ? x : { x, y };
    }
    // A 2D transform about its origin: where the box and its content are drawn (nothing else moves).
    const tf = take("transform");
    const to = take("transform-origin");
    if (tf) {
      const list = resolveVar(tf.value)?.raw.trim();
      const origin = to ? resolveVar(to.value)?.raw.trim() : undefined;
      if (list && list !== "none" && transformList(list, 100, 100) && (origin === undefined || originOf(origin, 100, 100)))
        out.transform = origin && !/^(50%|center)(\s+(50%|center))?$/.test(origin) ? { value: list, origin } : list;
      else if (list !== "none") note(e, s, tf, "only 2D transforms (in px or %) are modelled", "visual");
    }
    // contain: layout and paint make an independent formatting context, size sizes the box as if empty.
    const ct = take("contain");
    if (ct) {
      const raw = resolveVar(ct.value)?.raw.trim().toLowerCase().replace(/\s+/g, " ");
      const c = raw ? parseContain(raw) : undefined;
      if (!c) note(e, s, ct, "contain must be none, content, strict, or size, inline-size, layout, style and paint", "geometry");
      else if (c.layout || c.paint || c.size) out.contain = raw;
    }
    const bi = take("background-image");
    if (bi && bi.value.trim() !== "none") {
      const r = resolveVar(bi.value);
      if (r && PAINT_VALUE.test(r.raw)) {
        out.backdrop = r.varName ? tokens.named("paint", r.varName, r.raw) : tokens.literal("paint", r.raw);
        const BG: Record<string, string> = { "background-size": "cover", "background-position": "center", "background-repeat": "no-repeat" };
        for (const [k, want] of Object.entries(BG)) {
          const d = take(k);
          if (d && d.value.trim() !== want && !(k === "background-position" && d.value.trim() === "center center"))
            note(e, s, d, `Cadesa backdrops are ${want}; this paints differently`, "paint");
        }
      } else note(e, s, bi, "background-image must be a gradient or url()", "paint");
    }
    const sh = take("box-shadow");
    if (sh && sh.value.trim() !== "none") {
      const r = resolveVar(sh.value);
      if (r) out.shadow = r.varName ? tokens.named("shadow", r.varName, r.raw) : tokens.literal("shadow", r.raw);
    }
    const posType = m.get("position")?.value.trim();
    // An absolute box's percentage height is of its containing block: kept for the position block below.
    const height = posType && /^(absolute|fixed)$/.test(posType) && /%$/.test(resolveVar(m.get("height")?.value ?? "")?.raw ?? "") ? undefined : take("height");
    if (height && height.value.trim() !== "auto") {
      // A percentage the page front end kept: of a stretched parent's height.
      const t = lengthToken("size", height.value) ?? pctToken(height.value);
      if (t) out.height = t;
      else note(e, s, height, "height must be a px or rem length", "geometry");
    }
    for (const p of ["min-width", "min-height", "max-height"]) {
      const d = take(p);
      // min-height equal to the height is what Cadesa emits with every height.
      if (p === "min-height" && d && height && (d.value.trim() === height.value.trim() || (/^[\d.]+px$/.test(resolveVar(d.value)?.raw ?? "") && /^[\d.]+px$/.test(resolveVar(height.value)?.raw ?? "") && parseFloat(resolveVar(d.value)!.raw) <= parseFloat(resolveVar(height.value)!.raw)))) continue;
      if (p === "min-height" && d && !["0", "auto", "none", "0px"].includes(d.value.trim())) {
        const t = lengthToken("size", d.value);
        if (t) out.minHeight = t;
        else note(e, s, d, "min-height must be a px or rem length", "geometry");
        continue;
      }
      if (d && !["0", "auto", "none", "0px"].includes(d.value.trim())) note(e, s, d, `${p} is not modelled`, "geometry");
    }

    // box-sizing: Cadesa is always border-box
    const bsz = take("box-sizing");
    if (bsz && bsz.value.trim() !== "border-box") note(e, s, bsz, "Cadesa boxes are border-box", "geometry");

    // position
    // position: relative shifts the box (nothing else moves), absolute and fixed take it out of flow
    // into its containing block. Offsets are px or rem lengths (negative too) or percentages. Sticky
    // is predicted at scroll position 0, where it hasn't moved; it still contains absolute children.
    const pos = take("position");
    const inset = take("inset");
    const insetSides = inset ? sides(inset.value) : undefined;
    const offs = (["top", "right", "bottom", "left"] as const).map((k, i) => take(k) ?? (insetSides ? { ...inset!, prop: k, value: insetSides[i] } : undefined));
    const pv = pos?.value.trim();
    if (pos && pv && ["relative", "absolute", "fixed", "sticky"].includes(pv)) {
      const ps: Record<string, string> = {};
      offs.forEach((d, i) => {
        const k = ["top", "right", "bottom", "left"][i];
        if (!d || d.value.trim() === "auto" || pv === "sticky") return;
        const v = d.value.trim();
        const t = /%$/.test(resolveVar(v)?.raw ?? v) ? sizeToken(v) : lengthToken("space", v, true);
        if (t) ps[k] = t;
        else note(e, s, d, `${k} must be a px or rem length, a percentage or auto`, pv === "relative" ? "visual" : "geometry");
      });
      // An absolute box's percentage height is of its containing block, known only once laid out.
      const h = m.get("height");
      if (h && /%$/.test(resolveVar(h.value)?.raw ?? "") && (pv === "absolute" || pv === "fixed")) {
        m.delete("height");
        const t = sizeToken(h.value);
        if (t) ps.height = t;
        else note(e, s, h, "height must be a px or rem length, or a percentage", "geometry");
      }
      out.position = Object.keys(ps).length ? { type: pv, ...ps } : pv;
    } else if (pos && pv && pv !== "static") note(e, s, pos, `position: ${pv} is not modelled`, "geometry");

    // text role
    const ff = take("font-family");
    const fs = take("font-size");
    const fw = take("font-weight");
    const lh = take("line-height");
    const color = take("color");
    const fst = take("font-style");
    if (fst && fst.value.trim() !== "normal") note(e, s, fst, "only upright text is measured", "text");
    if (fs || lh || ff || fw || color) {
      const sizeRaw = fs ? resolveVar(fs.value)?.raw : undefined;
      const sizeOk = sizeRaw !== undefined && (LENGTH.test(sizeRaw) || !!lengthExpr(sizeRaw)?.fluid);
      const sizePx = sizeOk ? (LENGTH.test(sizeRaw!) ? pxOf(sizeRaw!) : lengthExpr(sizeRaw!)!.at(1280)) : NaN;
      let lineHeight: number | undefined;
      const lhRaw = lh ? resolveVar(lh.value)?.raw : undefined;
      if (lhRaw !== undefined) {
        if (/^[\d.]+$/.test(lhRaw)) lineHeight = parseFloat(lhRaw);
        else if (LENGTH.test(lhRaw) && sizeOk) lineHeight = Math.round((pxOf(lhRaw) / sizePx) * 1e6) / 1e6;
        else if (/^[\d.]+%$/.test(lhRaw)) lineHeight = parseFloat(lhRaw) / 100;
      }
      const weightRaw = fw?.value.trim() ?? "400";
      const weight = weightRaw === "normal" ? 400 : weightRaw === "bold" ? 700 : /^\d+$/.test(weightRaw) ? parseInt(weightRaw) : NaN;
      const colorTok = color ? colorToken(color.value) : undefined;
      const fontTok = ff && ff.value.trim() !== "inherit" ? (() => {
        const r = resolveVar(ff.value);
        return r ? (r.varName ? tokens.named("font", r.varName, r.raw) : tokens.literal("font", r.raw)) : undefined;
      })() : undefined;
      const missing = [!sizeOk && "font-size (px or rem)", lineHeight === undefined && "line-height", !colorTok && "color", isNaN(weight) && "font-weight"].filter(Boolean);
      if (missing.length) {
        for (const d of [fs, lh, ff, fw, color].filter(Boolean) as Decl[])
          note(e, s, d, `a text role needs ${missing.join(", ")}${lhRaw === "normal" ? " (line-height: normal depends on the font, whose metrics table has no vertical metrics)" : ""}`, d.prop === "color" ? "paint" : "text");
      } else {
        if (!fw) {
          /* weight defaults to 400; impact.ts flags tags whose UA weight differs */
        }
        const lsD = take("letter-spacing");
        let letterSpacing: number | undefined;
        if (lsD && !["normal", "0"].includes(lsD.value.trim())) {
          const v = resolveVar(lsD.value)?.raw ?? "";
          const em = /^(-?[\d.]+)em$/.exec(v);
          const px = /^(-?[\d.]+)px$/.exec(v);
          if (em) letterSpacing = parseFloat(em[1]);
          else if (px) letterSpacing = Math.round((parseFloat(px[1]) / sizePx) * 1e4) / 1e4;
          else note(e, s, lsD, "letter-spacing must be in em or px", "text");
        }
        const ow = take("overflow-wrap") ?? take("word-wrap");
        const owv = ow?.value.trim();
        if (ow && !["anywhere", "break-word", "normal"].includes(owv!))
          note(e, s, ow, `overflow-wrap: ${owv} is not modelled`, "text");
        const ws = take("white-space") ?? take("text-wrap-mode");
        const wsv = ws?.value.trim();
        if (ws && !["normal", "nowrap", "wrap"].includes(wsv!)) note(e, s, ws, `white-space: ${wsv} is not modelled`, "text");
        const tt = take("text-transform");
        const transform = tt?.value.trim();
        if (tt && transform !== "uppercase" && transform !== "none") note(e, s, tt, `text-transform: ${transform} is not measured`, "text");
        const deco = take("text-decoration") ?? take("text-decoration-line");
        const decoration = deco?.value.trim().split(/\s+/)[0];
        if (deco && decoration !== "none" && decoration !== "underline") note(e, s, deco, "paint only; no effect on layout", "paint");
        const spec = {
          ...(fontTok && { font: fontTok }),
          size: sizeRaw!,
          weight,
          lineHeight: lineHeight!,
          color: colorTok!,
          ...((decoration === "none" || decoration === "underline") && { decoration }),
          ...(letterSpacing !== undefined && { letterSpacing }),
          ...(transform === "uppercase" && { transform }),
          ...(wsv === "nowrap" ? { wrap: "none" } : (owv === "anywhere" || owv === "break-word") && { wrap: owv }),
        };
        const key = JSON.stringify(spec);
        let role = roles.get(key);
        if (!role) {
          const base = e.element ?? component(e.block);
          let name = sanitize(base);
          for (let i = 2; [...roles.values()].some((r) => r.name === name); i++) name = `${sanitize(base)}-${i}`;
          role = { name, spec };
          roles.set(key, role);
        }
        out.text = role.name;
      }
    }

    const ta = take("text-align");
    if (ta) {
      const v = ({ start: "start", left: "start", center: "center", end: "end", right: "end" } as Record<string, string>)[ta.value.trim()];
      if (v && v !== "start") out.textAlign = v;
      else if (!v) note(e, s, ta, "paint only; no effect on layout", "paint");
    }
    const ac = take("align-content");
    if (ac && !(ac.value.trim() === "center" && out.height && out.text) && !["normal", "start"].includes(ac.value.trim()))
      note(e, s, ac, "align-content moves content inside the box; only centering a fixed-height text box is modelled", "visual");

    // Declarations Cadesa's own output emits as part of a reset or a width/fill pattern.
    for (const p of ["font-kerning", "letter-spacing", "word-spacing", "text-indent", "text-transform", "white-space", "overflow-wrap", "word-break", "hyphens"]) {
      const d = m.get(p);
      if (d && ["normal", "0", "none", "manual"].includes(d.value.trim())) m.delete(p);
    }

    for (const d of m.values()) {
      // Chromium drops a control's native appearance once the author styles its background or border.
      const styled = !!bg || bw.some(Boolean);
      // A background clipped to its border or padding box still paints behind the text (only text clips it to the glyphs).
      const k =
        (/(^|-)appearance$/.test(d.prop) && (styled || d.value.trim() === "none")) || (/^(-webkit-)?background-(clip|origin)$/.test(d.prop) && /^(border|padding|content)-box$/.test(d.value.trim()))
          ? "none"
          : d.prop === "text-rendering" && /^(optimizespeed|geometricprecision)$/i.test(d.value.trim())
            ? "text"
            : kindOf(d.prop);
      note(e, s, d, k === "paint" ? "paint only; no effect on layout" : k === "none" ? "no effect on layout or contrast" : `${d.prop} is not modelled`, k);
    }
    return out;
  }

  // 5. Assemble the source: base props, then per-state diffs as `when` overrides.
  const styles: Record<string, Record<string, unknown>> = {};
  const usedBps = new Set<number>();
  for (const block of blockOrder) {
    const name = component(block);
    if (!IDENT.test(name)) {
      unlifted.push({ file: css.file, line: 0, selector: `.${block}`, reason: `"${name}" is not a valid component name`, kind: "geometry", className: block });
      continue;
    }
    const els = elements.filter((e) => e.block === block);
    const root = els.find((e) => !e.element);
    const slots = els.filter((e) => e.element && IDENT.test(e.element));
    for (const e of els.filter((x) => x.element && !IDENT.test(x.element)))
      unlifted.push({ file: css.file, line: 0, selector: `.${e.className}`, reason: `"${e.element}" is not a valid slot name`, kind: "geometry", className: e.className });

    const perState = (e: LiftedElement | undefined) => new Map(states.map((s) => [s, e ? mapState(e, s) : {}]));
    const rootStates = perState(root);
    const slotStates = new Map(slots.map((e) => [e.element!, perState(e)]));

    const style: Record<string, unknown> = {
      ...(css.notes.has(name) && { intent: css.notes.get(name) }),
      ...rootStates.get(Infinity),
    };
    if (slots.length) style.slots = Object.fromEntries(slots.map((e) => [e.element!, slotStates.get(e.element!)!.get(Infinity)]));
    const when: Record<string, unknown> = {};
    for (let i = 1; i < states.length; i++) {
      const s = states[i];
      const prev = states[i - 1];
      const diff = (a: Record<string, unknown>, b: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(b).filter(([k, v]) => JSON.stringify(a[k]) !== JSON.stringify(v)));
      const rootDiff = diff(rootStates.get(prev)!, rootStates.get(s)!);
      const slotDiffs: Record<string, Record<string, unknown>> = Object.fromEntries(
        [...slotStates]
          .map(([n, st]) => [n, diff(st.get(prev)!, st.get(s)!)] as const)
          .filter(([, d]) => Object.keys(d).length),
      );
      // A property present in the wider state but gone in the narrower one can't be expressed as an override.
      const lost = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).filter((k) => !(k in b));
      const zero: Record<string, () => unknown> = {
        padding: () => lengthToken("space", "0px"),
        margin: () => lengthToken("space", "0px"),
        radius: () => lengthToken("radius", "0px"),
        overflow: () => "visible",
        contain: () => "none",
        textAlign: () => "start",
      };
      const fillLost = (a: Record<string, unknown>, b: Record<string, unknown>, d: Record<string, unknown>, cls: string) => {
        for (const k of lost(a, b)) {
          if (UNSETTABLE_PROPS.has(k)) d[k] = "none";
          else if (zero[k]) d[k] = zero[k]();
          else
            unlifted.push({
              file: css.file,
              line: 0,
              selector: `.${cls}`,
              reason: `${k} is removed below ${bpRaw.get(s)}; Cadesa overrides can't unset it`,
              kind: k === "background" ? "paint" : k === "text" ? "text" : "geometry",
              className: cls,
              when: { maxPx: s, raw: `max-width: ${bpRaw.get(s)}` },
            });
        }
      };
      fillLost(rootStates.get(prev)!, rootStates.get(s)!, rootDiff, block);
      for (const [n, st] of slotStates) {
        const d = diff(st.get(prev)!, st.get(s)!);
        fillLost(st.get(prev)!, st.get(s)!, d, `${block}__${n}`);
        if (Object.keys(d).length) slotDiffs[n] = d;
      }
      if (Object.keys(rootDiff).length || Object.keys(slotDiffs).length) {
        when[bpName(s)] = { ...rootDiff, ...(Object.keys(slotDiffs).length && { slots: slotDiffs }) };
        usedBps.add(s);
      }
    }
    if (Object.keys(when).length) style.when = when;
    styles[name] = style;
  }
  unlifted.push(...unliftedByKey.values());
  unlifted.sort((a, b) => a.line - b.line || (a.decl ?? "").localeCompare(b.decl ?? ""));

  const tokenData: Record<string, Record<string, string>> = {};
  let pageData: { background: string } | undefined;
  if (pageBackground) {
    const r = resolveVar(pageBackground.value);
    const hex = r && toHex(r.raw);
    if (hex) pageData = { background: r!.varName ? tokens.named("color", r!.varName, hex) : tokens.literal("color", hex) };
  }
  // The body's margin and padding and the root element's insets: space tokens per side.
  const pageInsets: Record<string, unknown> = {};
  const { overflow: pageOverflow, windowHeight, ...pageSides } = input.pageSides ?? {};
  if (windowHeight) pageInsets.windowHeight = windowHeight;
  if (pageOverflow) pageInsets.overflow = pageOverflow;
  for (const [k, sides] of Object.entries(pageSides)) {
    if (!sides || sides.every((v) => isZero(v))) continue;
    const t = sides.map((v) => (isZero(v) ? undefined : lengthToken("space", v, k === "margin")));
    if (t.some((x, i) => !x && !isZero(sides[i]))) unlifted.push({ file: input.file, line: 0, selector: k === "outer" ? "html" : "body", decl: `${k}: ${sides.join(" ")}`, reason: `page-level ${k} must be px or rem lengths`, kind: "geometry" });
    else pageInsets[k] = sidesValue(t);
  }
  for (const cat of ["space", "size", "color", "radius", "font", "paint", "shadow"] as Cat[]) {
    const m = tokens.cats.get(cat);
    if (m?.size) tokenData[cat] = Object.fromEntries(m);
  }
  const data: Record<string, unknown> = { version: 1 };
  if (prefix !== "ca-") data.prefix = prefix;
  if (Object.keys(tokenData).length) data.tokens = tokenData;
  if (roles.size) data.text = Object.fromEntries([...roles.values()].map((r) => [r.name, r.spec]));
  const bps = bpPx.filter((p) => usedBps.has(p));
  if (bps.length) data.breakpoints = Object.fromEntries(bps.map((p) => [bpName(p), bpRaw.get(p)!]));
  if (pageData || Object.keys(pageInsets).length) data.page = { ...pageData, ...pageInsets };
  data.styles = styles;
  repair(data, css.file, prefix, unlifted);

  return {
    file: css.file,
    prefix,
    data,
    yaml: emitYaml(data, css.file, unlifted),
    unlifted,
    elements,
    resets,
    uaInCascade: input.uaInCascade,
    stats: {
      declarations,
      unlifted: unlifted.filter((u) => u.decl).length,
      components: Object.keys(styles).length,
      tokens: tokens.count(),
      breakpoints: bps.length,
    },
  };
}

/**
 * A lift always produces a valid source: a prop the validator rejects (a combination Cadesa can't
 * express, like aspect and height together) is dropped, and the element is recorded as not lifted
 * there, so its box is approximate instead of the whole run failing.
 */
function repair(data: Record<string, unknown>, file: string, prefix: string, unlifted: Unlifted[]) {
  const source = () => ({ file, text: "", data, locate: () => undefined, parseErrors: [] });
  for (let round = 0; round < 32; round++) {
    const { model, diagnostics } = validate(source());
    if (model) return;
    let fixed = false;
    for (const d of diagnostics) {
      if (d.severity !== "error") continue;
      const segs = d.path.split(".");
      if (segs[0] !== "styles" || segs.length < 3) continue;
      let i = 2;
      let when: string | undefined;
      if (segs[i] === "when") {
        when = segs[i + 1];
        i += 2;
      }
      let slot: string | undefined;
      if (segs[i] === "slots") {
        slot = segs[i + 1];
        i += 2;
      }
      const prop = segs[i];
      let at: unknown = data;
      for (const s of segs.slice(0, i)) at = at && typeof at === "object" ? (at as Record<string, unknown>)[s] : undefined;
      if (!prop || !at || typeof at !== "object" || !(prop in at)) continue;
      delete (at as Record<string, unknown>)[prop];
      fixed = true;
      const block = `${prefix}${segs[1]}`;
      const className = slot ? `${block}__${slot}` : block;
      const kind: ImpactKind = /^(background|backdrop|shadow|radius|fit)$/.test(prop) ? "paint" : prop === "text" ? "text" : "geometry";
      unlifted.push({ file, line: 0, selector: `.${className}`, decl: prop, reason: `this combination has no exact Cadesa equivalent (${d.message}); the box is approximate${when ? ` (${when})` : ""}`, kind, className });
    }
    if (!fixed) return;
  }
}

export function emitYaml(data: Record<string, unknown>, file: string, unlifted: Unlifted[]): string {
  const doc = new Document(data);
  visit(doc, {
    Map(_, node, path) {
      const depth = path.filter((p) => isMap(p)).length;
      const leafy = node.items.every((p) => isScalar(p.value) || (isMap(p.value) && p.value.items.every((q) => isScalar(q.value))));
      if (depth >= 2 && leafy && JSON.stringify(node.toJSON()).length < 110) node.flow = true;
    },
  });
  const head = `# Lifted from ${file} by cadesa lift. Edit freely; this file is now the source.\n`;
  const tail = unlifted.length
    ? `\n# Not lifted (${unlifted.length}):\n${unlifted
        // A comment is one line: anything carried over from the CSS is flattened, never a YAML line of its own.
        .map((u) => `#   ${u.line ? `${file}:${u.line}` : file} ${u.selector}${u.decl ? ` { ${u.decl} }` : ""}`.replace(/\s*\n\s*/g, " ") + `\n#     ${`${u.kind}: ${u.reason}${u.when ? ` (${u.when.raw})` : ""}`.replace(/\s*\n\s*/g, " ")}`)
        .join("\n")}\n`
    : "";
  return head + doc.toString({ lineWidth: 0 }) + tail;
}
