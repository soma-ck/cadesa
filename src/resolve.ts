import {
  isAuto,
  PROP_ORDER,
  tokenKey,
  type Breakpoint,
  type CellAlign,
  type Component,
  type TablePart,
  type Contain,
  type Justify,
  type MarginSide,
  type Model,
  type Overflow,
  type PositionType,
  type Pattern,
  type Props,
  type Ref,
  type Unsettable,
} from "./model.js";

/** One link in the chain that explains where a computed value came from. */
export interface Step {
  kind: "token" | "text" | "when" | "source";
  label: string;
  path: string;
}

export interface Resolved<T> {
  value: T;
  display: string;
  /** Most specific first: token → active breakpoint → the YAML field to edit. */
  steps: Step[];
}

export interface ResolvedText {
  role: string;
  font?: string;
  sizePx: number;
  weight: number;
  lineHeight: number;
  color: string;
  /** px */
  letterSpacing: number;
  uppercase: boolean;
  /** overflow-wrap: anywhere or break-word: a word too long for a line breaks between characters. */
  wrapAnywhere: boolean;
  /** overflow-wrap: break-word: as anywhere, but min-content still counts whole words. */
  breakWord: boolean;
  /** white-space: nowrap: one line per paragraph. */
  nowrap: boolean;
  underline: boolean;
}

/**
 * A percentage of the containing block's content width (a size token like "50%"), or an expression
 * with percentages in it ("min(440px, 100%)"): `of` gives its px (float) for that width.
 */
export interface Pct {
  pct: number;
  of?: (base: number) => number;
}

export interface Sides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * A size in px: a length as is, a percentage of `base` as Chromium resolves it (in float32, then
 * truncated to a layout unit).
 */
export function sizeAt(v: number | Pct, base: number): number {
  if (typeof v === "number") return v;
  const f = Math.fround;
  // An expression: its float value cut to a layout unit (LayoutUnit(float) truncates).
  if (v.of) return Math.trunc(f(v.of(base) * 64)) / 64;
  return Math.trunc(f(f(f(base) * f(v.pct)) / 100) * 64) / 64;
}

/** A margin: px per side, and which inline sides are auto (their px is 0 until layout). */
export interface Margins extends Sides {
  autoLeft?: boolean;
  autoRight?: boolean;
}

/** A grid column track: a fixed size (px or a percentage of the grid's width) or a flexible share. */
export type Track = { size: number | Pct } | { fr: number; auto: boolean };

export interface ResolvedProps {
  pattern?: Resolved<Pattern>;
  min?: Resolved<number>;
  /** A grid's explicit column tracks (instead of min). */
  columns?: Resolved<Track[]>;
  /** A grid: where items sit across their column. */
  justifyItems?: Resolved<"start" | "center" | "end" | "stretch">;
  justify?: Resolved<Justify>;
  /** A cluster's lines: false keeps every item on one line. */
  wrap?: Resolved<boolean>;
  grow?: Resolved<{ factor: number; basis: "zero" | "content" }>;
  aspect?: Resolved<number>;
  overflow?: Resolved<{ x: Overflow; y: Overflow }>;
  /** Containment (see Props.contain). */
  contain?: Resolved<Contain>;
  /** A table: collapsed borders, fixed layout (its border spacing is gap and rowGap). */
  table?: Resolved<{ collapse: boolean; fixed: boolean }>;
  /** A table part (see Props.part). */
  part?: Resolved<{ part: TablePart; align?: CellAlign; side?: "top" | "bottom"; contentBox?: boolean }>;
  /** Positioning and its offsets (px, or a percentage of the containing block). */
  position?: Resolved<{ type: PositionType; top?: number | Pct; right?: number | Pct; bottom?: number | Pct; left?: number | Pct; height?: number | Pct }>;
  fit?: Resolved<"cover" | "contain">;
  backdrop?: Resolved<string>;
  shadow?: Resolved<string>;
  align?: Resolved<"start" | "center" | "end" | "stretch">;
  textAlign?: Resolved<"start" | "center" | "end">;
  /** `pct`: the gap between columns is this percentage of the content width (value is 0: what intrinsic sizes count). */
  gap?: Resolved<number> & { pct?: number };
  /** A grid's or cluster's gap between rows, when it differs from `gap`. */
  rowGap?: Resolved<number> & { pct?: number };
  padding?: Resolved<Sides>;
  background?: Resolved<string>;
  /** The color, and each side's width as Chromium draws it. */
  border?: Resolved<{ color: string; widths: Sides }>;
  radius?: Resolved<number>;
  margin?: Resolved<Margins>;
  maxWidth?: Resolved<number | Pct>;
  measure?: Resolved<number | Pct>;
  width?: Resolved<number | "fill" | "fit" | Pct>;
  height?: Resolved<number>;
  minHeight?: Resolved<number>;
  /** A height that is a percentage of the parent's content height, once that is definite (stretched or set); auto until then. */
  heightPct?: Resolved<number | Pct>;
  text?: Resolved<ResolvedText>;
}

/**
 * A length as Chromium lays it out: in layout units of 1/64 px, truncated (19.968px is 19.953125px).
 * Box lengths (padding, gap, widths, heights) all go through this; font sizes don't.
 */
export const layoutUnit = (px: number) => Math.floor(px * 64 + 1e-6) / 64;

export const fmtPx = (n: number) => `${Math.round(n * 100) / 100}`;

/**
 * A border width as Chromium lays it out (at device pixel ratio 1): a width under 1px is 1px, and
 * any other is rounded down to whole pixels (2.7px is 2px).
 */
export const borderPx = (px: number) => (px <= 0 ? 0 : px < 1 ? 1 : Math.floor(px));

const ZERO: Sides = { top: 0, right: 0, bottom: 0, left: 0 };
/** Padding plus border, per side: how far the content box sits inside the border box. */
export function insets(p: ResolvedProps): Sides {
  const pad = p.padding?.value ?? ZERO;
  const b = p.border?.value.widths ?? ZERO;
  return { top: pad.top + b.top, right: pad.right + b.right, bottom: pad.bottom + b.bottom, left: pad.left + b.left };
}

/** Four side values (CSS order), as short as CSS would write them. */
function strSides([t, r, b, l]: string[]): string {
  if (t === b && l === r) return t === l ? t : `${t} ${l}`;
  return `${t} ${r} ${b} ${l}`;
}

/** "8px", "8px 16px" or "1px 2px 3px 4px" (CSS order). */
export function sidesDisplay(v: Sides, unit = (n: number) => `${fmtPx(n)}px`): string {
  if (v.top === v.bottom && v.left === v.right) return v.top === v.left ? unit(v.top) : `${unit(v.top)} ${unit(v.left)}`;
  return `${unit(v.top)} ${unit(v.right)} ${unit(v.bottom)} ${unit(v.left)}`;
}

export function activeBreakpoints(model: Model, width: number): Breakpoint[] {
  return model.breakpoints.filter((b) => width <= b.length.px);
}

export function resolveElement(model: Model, component: Component, slot: string | undefined, width: number): ResolvedProps {
  const active = new Set(activeBreakpoints(model, width).map((b) => b.name));
  const layers: { props: Props; when?: Step }[] = [];
  const base = slot === undefined ? component.props : component.slots.get(slot)?.props;
  if (base) layers.push({ props: base });
  for (const ov of component.when) {
    if (!active.has(ov.breakpoint)) continue;
    const props = slot === undefined ? ov.props : ov.slots.get(slot);
    if (!props) continue;
    const bp = model.breakpoints.find((b) => b.name === ov.breakpoint)!;
    layers.push({
      props,
      when: { kind: "when", label: `when.${bp.name} (${width}px ≤ ${fmtPx(bp.length.px)}px)`, path: bp.path },
    });
  }

  const out: ResolvedProps = {};
  // aspect and height both set the height: the one from the more specific layer replaces the other.
  const last = (key: keyof Props) => layers.findLastIndex((l) => l.props[key] !== undefined && !l.props.unset?.[key as Unsettable]);
  const dropped: keyof Props | undefined =
    last("aspect") >= 0 && last("height") >= 0 ? (last("aspect") > last("height") ? "height" : "aspect") : undefined;
  for (const key of PROP_ORDER) {
    if (key === dropped) continue;
    let layer: (typeof layers)[number] | undefined;
    // An override that removes the prop (`maxWidth: none`) undoes every layer before it.
    for (const l of layers) if (l.props.unset?.[key as Unsettable]) layer = undefined;
    else if (l.props[key] !== undefined) layer = l;
    if (!layer) continue;
    const pre = layer.when ? [layer.when] : [];
    const src = (path: string): Step => ({ kind: "source", label: path, path });

    const tokenStep = (r: Ref): Step => {
      const t = model.tokens.get(tokenKey(r.kind, r.name))!;
      return { kind: "token", label: `${r.kind}.${r.name} = ${t.raw}`, path: t.path };
    };
    const lengthOf = (r: Ref): Resolved<number> => {
      const t = model.tokens.get(tokenKey(r.kind, r.name))!;
      // A token that follows the viewport width has its value at this width.
      const px = t.fluid ? t.fluid(width) : t.px!;
      return { value: layoutUnit(px), display: `${fmtPx(px)}px${t.fluid ? ` (${t.raw} at ${width}px)` : ""}`, steps: [tokenStep(r), ...pre, src(r.path)] };
    };
    /** A size token: a length, or a percentage of the containing block's width. */
    const sizeOf = (r: Ref): Resolved<number | Pct> => {
      const t = model.tokens.get(tokenKey(r.kind, r.name))!;
      if (t.calc) {
        const calc = t.calc;
        return { value: { pct: NaN, of: (base) => calc(width, base) }, display: `${t.raw} (% of the parent's width)`, steps: [tokenStep(r), ...pre, src(r.path)] };
      }
      if (t.pct === undefined) return lengthOf(r);
      return { value: { pct: t.pct }, display: `${t.pct}% of the parent's width`, steps: [tokenStep(r), ...pre, src(r.path)] };
    };
    const colorOf = (r: Ref): Resolved<string> => {
      const t = model.tokens.get(tokenKey(r.kind, r.name))!;
      return { value: t.raw, display: t.raw, steps: [tokenStep(r), ...pre, src(r.path)] };
    };

    const p = layer.props;
    switch (key) {
      case "layout": {
        const l = p.layout!;
        out.pattern = { value: l.pattern, display: l.pattern, steps: [...pre, src(`${l.path}.pattern`)] };
        const gapPct = l.gap?.kind === "size" ? model.tokens.get(tokenKey("size", l.gap.name))!.pct : undefined;
        out.gap = gapPct !== undefined ? { ...sizeOf(l.gap!), value: 0, pct: gapPct, display: `${gapPct}% of the content width` } : l.gap ? lengthOf(l.gap) : { value: 0, display: "0px (no gap)", steps: [...pre, src(l.path)] };
        const rowPct = l.rowGap?.kind === "size" ? model.tokens.get(tokenKey("size", l.rowGap.name))!.pct : undefined;
        // A percentage of the grid's height: 0 while its rows are sized, then of its final content height.
        if (l.rowGap) out.rowGap = rowPct !== undefined ? { ...sizeOf(l.rowGap), value: 0, pct: rowPct, display: `${rowPct}% of the content height (0 while the rows are sized)` } : lengthOf(l.rowGap);
        if (l.pattern === "table") out.table = { value: { collapse: !!l.collapse, fixed: !!l.fixed }, display: [l.collapse ? "collapse" : "separate", ...(l.fixed ? ["fixed"] : [])].join(", "), steps: [...pre, src(l.path)] };
        if (l.pattern !== "stack" && l.pattern !== "flow" && l.pattern !== "table") {
          const def = l.pattern === "cluster" ? "center" : "stretch";
          const a = l.align ?? def;
          out.align = { value: a, display: l.align ? a : `${def} (default)`, steps: [...pre, src(l.align ? `${l.path}.align` : l.path)] };
        }
        if (l.min) out.min = lengthOf(l.min);
        if (l.columns) {
          const tracks = l.columns.map((t): Track => ("size" in t ? { size: sizeOf(t.size).value } : { fr: t.fr, auto: t.auto }));
          const show = (t: (typeof l.columns)[number]) => ("size" in t ? t.size.name : t.auto ? `${t.fr}fr` : `minmax(0, ${t.fr}fr)`);
          const shown = l.columns.map(show);
          const display = shown.every((s) => s === shown[0]) && shown.length > 1 ? `repeat(${shown.length}, ${shown[0]})` : shown.join(" ");
          const tokens = l.columns.filter((t) => "size" in t).map((t) => tokenStep((t as { size: Ref }).size));
          out.columns = { value: tracks, display, steps: [...tokens.filter((t, k) => tokens.findIndex((u) => u.path === t.path) === k), ...pre, src(`${l.path}.columns`)] };
        }
        if (l.pattern === "grid") {
          const j = l.justifyItems ?? "stretch";
          out.justifyItems = { value: j, display: l.justifyItems ? j : "stretch (default)", steps: [...pre, src(l.justifyItems ? `${l.path}.justify` : l.path)] };
        }
        if (l.pattern === "cluster") {
          const j = l.justify ?? "start";
          out.justify = { value: j, display: l.justify ? j : "start (default)", steps: [...pre, src(l.justify ? `${l.path}.justify` : l.path)] };
          out.wrap = { value: l.wrap !== false, display: l.wrap === false ? "false (one line)" : "true (default)", steps: [...pre, src(l.wrap === false ? `${l.path}.wrap` : l.path)] };
        }
        break;
      }
      case "grow": {
        const g = p.grow!;
        out.grow = { value: { factor: g.value, basis: g.basis }, display: `${g.value}${g.basis === "zero" ? " (from zero)" : ""}`, steps: [...pre, src(g.path)] };
        break;
      }
      case "position": {
        const ps = p.position!;
        const off = (r?: Ref) => (r ? (r.kind === "size" ? sizeOf(r).value : lengthOf(r).value) : undefined);
        const value = { type: ps.type, ...Object.fromEntries((["top", "right", "bottom", "left", "height"] as const).flatMap((k) => (ps[k] ? [[k, k === "height" ? sizeOf(ps[k]!).value : off(ps[k])]] : []))) };
        const shown = (["top", "right", "bottom", "left"] as const).filter((k) => ps[k]).map((k) => `${k} ${ps[k]!.name}`);
        out.position = { value, display: [ps.type, ...shown].join(", "), steps: [...pre, src(ps.path)] };
        break;
      }
      case "overflow": {
        const o = p.overflow!;
        out.overflow = { value: { x: o.x, y: o.y }, display: o.raw, steps: [...pre, src(o.path)] };
        break;
      }
      case "contain": {
        const c = p.contain!;
        if (c.layout || c.paint || c.size) out.contain = { value: { layout: c.layout, paint: c.paint, ...(c.size && { size: c.size }) }, display: c.raw, steps: [...pre, src(c.path)] };
        break;
      }
      case "part": {
        const t = p.part!;
        out.part = { value: { part: t.value, ...(t.align && { align: t.align }), ...(t.side && { side: t.side }), ...(t.contentBox && { contentBox: true }) }, display: t.raw, steps: [...pre, src(t.path)] };
        break;
      }
      case "textAlign": {
        const t = p.textAlign!;
        out.textAlign = { value: t.value, display: t.value, steps: [...pre, src(t.path)] };
        break;
      }
      case "padding": {
        const pd = p.padding!;
        const sides = (["top", "right", "bottom", "left"] as const).map((s) => (pd[s] ? lengthOf(pd[s]!) : undefined));
        const [top, right, bottom, left] = sides.map((x) => x?.value ?? 0);
        const tokens = sides.filter((x) => x).map((x) => x!.steps[0]);
        const value = { top, right, bottom, left };
        out.padding = {
          value,
          display: sidesDisplay(value),
          steps: [...tokens.filter((t, k) => tokens.findIndex((u) => u.path === t.path) === k), ...pre, src(pd.path)],
        };
        break;
      }
      case "margin": {
        const m = p.margin!;
        const side = (r: MarginSide | undefined) => (r && !isAuto(r) ? lengthOf(r) : undefined);
        const sides = (["top", "right", "bottom", "left"] as const).map((s) => side(m[s]));
        const [top, right, bottom, left] = sides.map((x) => x?.value ?? 0);
        const tokens = sides.filter((x) => x).map((x) => x!.steps[0]);
        const autoLeft = isAuto(m.left);
        const autoRight = isAuto(m.right);
        const value: Margins = { top, right, bottom, left, ...(autoLeft && { autoLeft }), ...(autoRight && { autoRight }) };
        const px = (n: number) => `${fmtPx(n)}px`;
        out.margin = {
          value,
          display: strSides([px(top), autoRight ? "auto" : px(right), px(bottom), autoLeft ? "auto" : px(left)]),
          steps: [...tokens.filter((t, k) => tokens.findIndex((u) => u.path === t.path) === k), ...pre, src(m.path)],
        };
        break;
      }
      case "measure":
      case "maxWidth":
        out[key] = sizeOf(p[key]!);
        break;
      case "height": {
        const t = model.tokens.get(tokenKey(p.height!.kind, p.height!.name))!;
        if (t.pct !== undefined || t.calc) out.heightPct = sizeOf(p.height!);
        else out.height = lengthOf(p.height!);
        break;
      }
      case "radius":
      case "minHeight":
        out[key] = lengthOf(p[key]!);
        break;
      case "background":
        out.background = colorOf(p.background!);
        break;
      case "border": {
        const b = p.border!;
        const c = colorOf(b.color);
        const sides = (["top", "right", "bottom", "left"] as const).map((s) => (b.sides ? (b.sides[s] ? lengthOf(b.sides[s]!) : undefined) : undefined));
        const w = (i: number) => (b.sides ? borderPx(sides[i]?.value ?? 0) : 1);
        const widths = { top: w(0), right: w(1), bottom: w(2), left: w(3) };
        const tokens = sides.filter((x) => x).map((x) => x!.steps[0]);
        out.border = {
          value: { color: c.value, widths },
          display: `${sidesDisplay(widths)} solid ${c.value}`,
          steps: [c.steps[0], ...tokens.filter((t, k) => tokens.findIndex((u) => u.path === t.path) === k), ...pre, src(b.path)],
        };
        break;
      }
      case "backdrop":
      case "shadow": {
        const r = p[key]!;
        const t = model.tokens.get(tokenKey(r.kind, r.name))!;
        out[key] = { value: t.raw, display: `${r.name}`, steps: [tokenStep(r), ...pre, src(r.path)] };
        break;
      }
      case "aspect": {
        const a = p.aspect!;
        out.aspect = { value: a.value, display: a.raw, steps: [...pre, src(a.path)] };
        break;
      }
      case "fit": {
        const f = p.fit!;
        out.fit = { value: f.value, display: f.value, steps: [...pre, src(f.path)] };
        break;
      }
      case "width": {
        const w = p.width!;
        out.width =
          "keyword" in w
            ? { value: w.keyword, display: w.keyword, steps: [...pre, src(w.path)] }
            : sizeOf(w);
        break;
      }
      case "text": {
        const r = p.text!;
        const role = model.text.get(r.name)!;
        const color = model.tokens.get(tokenKey("color", role.color.name))!;
        const font = role.font ? model.tokens.get(tokenKey("font", role.font.name))!.raw : undefined;
        const sizePx = role.size.fluid ? role.size.fluid(width) : role.size.px;
        out.text = {
          value: {
            role: role.name,
            font,
            sizePx: sizePx,
            weight: role.weight,
            lineHeight: role.lineHeight,
            color: color.raw,
            letterSpacing: (role.letterSpacing ?? 0) * sizePx,
            uppercase: role.transform === "uppercase",
            wrapAnywhere: role.wrap === "anywhere" || role.wrap === "break-word",
            breakWord: role.wrap === "break-word",
            nowrap: role.wrap === "none",
            underline: role.decoration === "underline",
          },
          display: `${role.name} (${fmtPx(sizePx)}px/${role.lineHeight}, ${role.weight})`,
          steps: [{ kind: "text", label: `text.${role.name}`, path: role.path }, ...pre, src(r.path)],
        };
        break;
      }
    }
  }
  return out;
}

export function explainChain(r: Resolved<unknown>): string {
  return [r.display, ...r.steps.map((s) => s.label)].join(" ← ");
}
