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

export type ImpactKind = "geometry" | "text" | "visual" | "paint" | "state" | "none";

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
  stats: { declarations: number; unlifted: number; components: number; tokens: number; breakpoints: number };
}

// ---------------------------------------------------------------- property classes

const PAINT =
  /^(color|background(-color|-image|-position|-size|-repeat|-clip|-origin|-attachment)?|box-shadow|outline.*|opacity|cursor|transition.*|animation.*|text-decoration.*|text-shadow|text-align|border(-top|-right|-bottom|-left)?-color|border(-top|-right|-bottom|-left)?-(left|right)?-?radius|border-radius|fill|stroke.*|filter|backdrop-filter|visibility|pointer-events|user-select|caret-color|accent-color|will-change|z-index|mix-blend-mode|appearance|-webkit-.*|-moz-.*|list-style.*|object-.*|scroll-.*|isolation|overflow(-x|-y)?|content|resize|touch-action|clip-path|mask.*)$/;
const TEXT =
  /^(font.*|letter-spacing|word-spacing|text-transform|white-space|line-height|text-indent|word-break|overflow-wrap|word-wrap|hyphens|tab-size|text-wrap.*|direction|unicode-bidi|writing-mode|text-rendering|font-kerning)$/;
const VISUAL = /^(transform|translate|rotate|scale|perspective.*|transform-origin)$/;

export function kindOf(prop: string): ImpactKind {
  if (PAINT.test(prop)) return "paint";
  if (TEXT.test(prop)) return "text";
  if (VISUAL.test(prop)) return "visual";
  return "geometry";
}

const RANK: Record<ImpactKind, number> = { none: 0, state: 1, paint: 2, visual: 3, text: 4, geometry: 5 };
export const worst = (kinds: ImpactKind[]) => kinds.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "none" as ImpactKind);

// ---------------------------------------------------------------- values

const LENGTH = /^(?:\d+(?:\.\d+)?|\.\d+)(px|rem)$/;
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

type Cat = "space" | "size" | "color" | "radius" | "font";

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
    const name =
      cat === "color"
        ? `hex-${raw.slice(1)}`
        : cat === "font"
          ? sanitize(raw.split(",")[0].replace(/["']/g, "")) || "font"
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
    default:
      return [d];
  }
}

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
  const tokens = new Tokens();
  let declarations = 0;

  for (const s of css.skipped) unlifted.push({ file: css.file, line: s.line, selector: s.text, reason: s.reason, kind: "none" });

  // 1. Classify rules.
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
  const component = (block: string) => block.slice(prefix.length);

  // 2. Breakpoint states, widest first.
  const bpPx = [...new Set(css.rules.filter((r) => r.media?.maxPx !== undefined).map((r) => r.media!.maxPx!))].sort((a, b) => b - a);
  const bpRaw = new Map(css.rules.filter((r) => r.media?.maxPx !== undefined).map((r) => [r.media!.maxPx!, r.media!.maxRaw!]));
  const bpName = (px: number) => `max-${bpRaw.get(px)!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
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

  const lengthToken = (cat: Cat, value: string): string | undefined => {
    const r = resolveVar(value);
    if (!r) return undefined;
    let raw = r.raw;
    if (isZero(raw)) raw = "0px";
    if (!LENGTH.test(raw)) return undefined;
    return r.varName ? tokens.named(cat, r.varName, raw) : tokens.literal(cat, raw);
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
      if (!column && wrap === "nowrap")
        note(e, s, display, "a non-wrapping flex row is lifted as a cluster; items may shrink instead of wrapping", "geometry");
      const av = align?.value.trim();
      if (align && column && !["stretch", "normal"].includes(av!)) note(e, s, align, "stack children always stretch", "geometry");
      const CLUSTER_ALIGN: Record<string, string> = { center: "center", "flex-start": "start", start: "start", "flex-end": "end", end: "end", stretch: "stretch", normal: "stretch" };
      const clusterAlign = av === undefined ? "stretch" : CLUSTER_ALIGN[av];
      if (!column && !clusterAlign) note(e, s, align!, `align-items: ${av} has no Cadesa equivalent`, "geometry");
      const jv = justify?.value.trim();
      if (justify && !["flex-start", "start", "normal", "left"].includes(jv!) && !(column && !m.has("height")))
        note(e, s, justify, `justify-content: ${jv} has no Cadesa equivalent`, "geometry");
      const gapDecl = column ? rowGap : colGap ?? rowGap;
      let gap: string | undefined;
      if (gapDecl && !isZero(resolveVar(gapDecl.value)?.raw ?? "x")) {
        gap = lengthToken("space", gapDecl.value);
        if (!gap) note(e, s, gapDecl, "gap must be a px or rem length", "geometry");
      }
      if (!column && rowGap && colGap && rowGap.value.trim() !== colGap.value.trim())
        note(e, s, rowGap, "a cluster has one gap for rows and columns", "geometry");
      out.layout = {
        pattern,
        ...(gap && { gap }),
        ...(!column && clusterAlign && clusterAlign !== "center" && { align: clusterAlign }),
      };
    } else if (display && !["block", "flow-root"].includes(display.value.trim())) {
      note(e, s, display, `display: ${display.value.trim()} has no Cadesa pattern`, "geometry");
    }
    for (const p of ["flex-direction", "flex-wrap", "align-items", "justify-content", "row-gap", "column-gap"]) {
      const d = take(p);
      if (d && !(p.endsWith("gap") && isZero(d.value))) note(e, s, d, `${p} only applies to a flex container`, "geometry");
    }

    // padding
    const pad = ["top", "right", "bottom", "left"].map((k) => take(`padding-${k}`));
    if (pad.some(Boolean)) {
      const v = pad.map((d) => (d ? d.value.trim() : "0"));
      const blockOk = v[0] === v[2];
      const inlineOk = v[1] === v[3];
      if (!blockOk || !inlineOk) note(e, s, pad.find(Boolean)!, "padding must be symmetric per axis (block, inline)", "geometry");
      else {
        const block = isZero(v[0]) ? undefined : lengthToken("space", v[0]);
        const inline = isZero(v[1]) ? undefined : lengthToken("space", v[1]);
        if ((!isZero(v[0]) && !block) || (!isZero(v[1]) && !inline))
          note(e, s, pad.find(Boolean)!, "padding must be a px or rem length", "geometry");
        else if (block || inline) out.padding = block && inline && block === inline ? block : { ...(block && { block }), ...(inline && { inline }) };
      }
    }

    // border
    const bw = ["top", "right", "bottom", "left"].map((k) => take(`border-${k}-width`));
    const bs = ["top", "right", "bottom", "left"].map((k) => take(`border-${k}-style`));
    const bc = ["top", "right", "bottom", "left"].map((k) => take(`border-${k}-color`));
    if (bw.some(Boolean)) {
      const widths = bw.map((d) => (d ? d.value.trim() : "0"));
      const styles = bs.map((d) => (d ? d.value.trim() : "none"));
      const visible = widths.map((w, i) => !isZero(w) && styles[i] !== "none");
      if (visible.every((x) => !x)) {
        /* no border */
      } else if (visible.every(Boolean) && widths.every((w) => w === "1px") && styles.every((x) => x === "solid") && bc.every((c) => c && c.value === bc[0]!.value)) {
        const c = colorToken(bc[0]!.value);
        if (c) out.border = c;
        else note(e, s, bc[0]!, "border color must be a hex or rgb() color", "paint");
      } else note(e, s, bw.find(Boolean)!, "Cadesa borders are 1px solid on every side", "geometry");
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
    if (maxW && maxW.value.trim() !== "none") {
      const t = lengthToken("size", maxW.value);
      if (!t) note(e, s, maxW, "max-width must be a px or rem length", "geometry");
      else if (!isRoot) note(e, s, maxW, "maxWidth is only supported on a component root", "geometry");
      else if (!autoX) note(e, s, maxW, "Cadesa centers a max-width root (margin-inline: auto); this CSS doesn't", "geometry");
      else out.maxWidth = t;
    }
    margins.forEach((d, i) => {
      if (!d || isZero(d.value)) return;
      if (d.value.trim() === "auto" && (i === 1 || i === 3) && out.maxWidth) return;
      note(e, s, d, "margins are not modelled; use gap and padding", "geometry");
    });

    // width / height / flex item
    const width = take("width");
    const alignSelf = take("align-self");
    const flex = take("flex");
    const shrink = take("flex-shrink");
    const grow = take("flex-grow");
    const basis = take("flex-basis");
    if (width) {
      const v = width.value.trim();
      if (v === "100%" || (v === "auto" && alignSelf?.value.trim() === "stretch")) out.width = "fill";
      else if (v !== "auto") {
        const t = lengthToken("size", v);
        if (t) out.width = t;
        else note(e, s, width, "width must be a px/rem length, 100%, or auto", "geometry");
      }
    }
    if (alignSelf && !["auto", "stretch", "normal"].includes(alignSelf.value.trim()))
      note(e, s, alignSelf, `align-self: ${alignSelf.value.trim()} has no Cadesa equivalent`, "geometry");
    if (flex && !["none", "0 0 auto", "initial", "0 1 auto"].includes(flex.value.trim()))
      note(e, s, flex, `flex: ${flex.value.trim()} has no Cadesa equivalent`, "geometry");
    if (grow && !isZero(grow.value)) note(e, s, grow, "flex-grow has no Cadesa equivalent", "geometry");
    if (basis && basis.value.trim() !== "auto") note(e, s, basis, "flex-basis has no Cadesa equivalent", "geometry");
    void shrink;
    const height = take("height");
    if (height && height.value.trim() !== "auto") {
      const t = lengthToken("size", height.value);
      if (t) out.height = t;
      else note(e, s, height, "height must be a px or rem length", "geometry");
    }
    for (const p of ["min-width", "min-height", "max-height"]) {
      const d = take(p);
      if (d && !["0", "auto", "none", "0px"].includes(d.value.trim())) note(e, s, d, `${p} is not modelled`, "geometry");
    }

    // box-sizing: Cadesa is always border-box
    const bsz = take("box-sizing");
    if (bsz && bsz.value.trim() !== "border-box") note(e, s, bsz, "Cadesa boxes are border-box", "geometry");

    // position
    const pos = take("position");
    const offsets = ["top", "right", "bottom", "left", "inset"].map((p) => take(p)).filter(Boolean) as Decl[];
    if (pos && ["absolute", "fixed", "sticky"].includes(pos.value.trim()))
      note(e, s, pos, `position: ${pos.value.trim()} takes the box out of normal flow`, "geometry");
    else if (offsets.length && pos?.value.trim() === "relative") note(e, s, offsets[0], "relative offsets move the box visually", "visual");

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
      const sizeOk = sizeRaw !== undefined && LENGTH.test(sizeRaw);
      const sizePx = sizeOk ? pxOf(sizeRaw!) : NaN;
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
          note(e, s, d, `a text role needs ${missing.join(", ")}; inherited text is not modelled`, d.prop === "color" ? "paint" : "text");
      } else {
        if (!fw) {
          /* weight defaults to 400; impact.ts flags tags whose UA weight differs */
        }
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
      const k = kindOf(d.prop);
      note(e, s, d, k === "paint" ? "paint only; no effect on layout" : `${d.prop} is not modelled`, k);
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
        radius: () => lengthToken("radius", "0px"),
      };
      const fillLost = (a: Record<string, unknown>, b: Record<string, unknown>, d: Record<string, unknown>, cls: string) => {
        for (const k of lost(a, b)) {
          if (zero[k]) d[k] = zero[k]();
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
  for (const cat of ["space", "size", "color", "radius", "font"] as Cat[]) {
    const m = tokens.cats.get(cat);
    if (m?.size) tokenData[cat] = Object.fromEntries(m);
  }
  const data: Record<string, unknown> = { version: 1 };
  if (prefix !== "ca-") data.prefix = prefix;
  if (Object.keys(tokenData).length) data.tokens = tokenData;
  if (roles.size) data.text = Object.fromEntries([...roles.values()].map((r) => [r.name, r.spec]));
  const bps = bpPx.filter((p) => usedBps.has(p));
  if (bps.length) data.breakpoints = Object.fromEntries(bps.map((p) => [bpName(p), bpRaw.get(p)!]));
  data.styles = styles;

  return {
    file: css.file,
    prefix,
    data,
    yaml: emitYaml(data, css.file, unlifted),
    unlifted,
    elements,
    resets,
    stats: {
      declarations,
      unlifted: unlifted.filter((u) => u.decl).length,
      components: Object.keys(styles).length,
      tokens: tokens.count(),
      breakpoints: bps.length,
    },
  };
}

function emitYaml(data: Record<string, unknown>, file: string, unlifted: Unlifted[]): string {
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
        .map((u) => `#   ${u.line ? `${file}:${u.line}` : file} ${u.selector}${u.decl ? ` { ${u.decl} }` : ""}\n#     ${u.kind}: ${u.reason}${u.when ? ` (${u.when.raw})` : ""}`)
        .join("\n")}\n`
    : "";
  return head + doc.toString({ lineWidth: 0 }) + tail;
}
