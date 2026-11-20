/**
 * The Cadesa reference layout engine.
 *
 * Cadesa's layout semantics are defined here, without a browser. The language is
 * deliberately small (no cascade, no inheritance, two layout patterns, explicit tokens),
 * so the box tree is fully determined by source + fixture + viewport width.
 *
 * Text is measured with bundled font metrics (see text.ts). Text in a font Cadesa has not
 * measured falls back to a one-line assumption, which every report flags.
 */
import { closest } from "../diagnostics.js";
import { styled, type Fixture, type FixtureNode, type Span } from "../fixture.js";
import { containsLayout, scrolls, tokenKey, type Component, type Model, type PageSides, type Pattern, type Ref } from "../model.js";
import { activeBreakpoints, atBase, fmtPx, insets, layoutUnit, resolveElement, scrollbarPx, sizeAt, type GridSpec, type Margins, type ResolvedProps, type Sides, type Track } from "../resolve.js";
import { layoutText, metricsFor, pieces, TEXT_EPS, type Line } from "./text.js";
import { boxMatrix4, multiply4, originOf, perspective4, projectRect, translate4, type Matrix4 } from "./transform.js";
import { expandTracks, placeFlow as gridPlace, sizeTracks, trackStarts, type Contribution, type Explicit, type TrackList, type TrackSize } from "./grid.js";
import { Exclusions } from "./floats.js";
import { firstBaseline, layoutTable, tableGrid, tableInsets, tableIntrinsic, type Grid, type TableHooks } from "./table.js";

const EPS = 0.001;

/** The room for a line of text beside floats (see layoutText's `band`), from the text's content box. */
type Band = (top: number, h: number, fits: (w: number) => boolean) => { top: number; l: number; r: number };

/**
 * A block formatting context's floats, and where a box sits in it: its border box's top left
 * corner in the context's coordinates (see floats.ts).
 */
interface Bfc {
  ex: Exclusions;
  x: number;
  y: number;
}

export interface Box {
  id: string;
  /** A form control's baseline from its border box's top (px), where it isn't its bottom (a button input's label). */
  controlBaseline?: number;
  tag: string;
  component: string;
  slot?: string;
  /** Editable YAML path for this element's style. */
  sourcePath: string;
  fixtureLine?: number;
  /** The element's HTML attributes (href, role, type...), for checks that depend on them. */
  attrs?: Record<string, string>;
  x: number;
  y: number;
  w: number;
  h: number;
  props: ResolvedProps;
  text?: string;
  /** Laid-out lines, with widths in px, when the text could be measured. */
  lines?: Line[];
  /** Runs of its text in another font, weight or face (italic or upright): what they are set in, for `cadesa fonts`. */
  runFonts?: { font?: string; weight: number; italic: boolean; text?: string }[];
  /** Its text's runs (paragraphs between line breaks), as set (uppercased where it is): what `cadesa fonts` measures whole for a font whose contextual forms can't be searched. */
  runTexts?: string[];
  /** Px this box's content extends past its content box horizontally. */
  overflowX?: number;
  /** Px this box's content extends past its fixed height. */
  overflowY?: number;
  assumptions: string[];
  /**
   * Laid out in a block formatting context after floats: where it goes decides how its lines (and
   * those of what is in it) wrap beside them, so its size is known only where its place is.
   */
  afterFloats?: boolean;
  children: Box[];
  /** A run of text the browser wraps in an anonymous box: laid out, but not an element (no DOM box to compare). */
  anonymous?: boolean;
  /** A cluster item on a line its items overfill (by their flex base sizes): they shrink, or overflow. */
  overfull?: boolean;
  /** A scroll container that shows a scrollbar where scrollbars take space (overflow: scroll, or auto with its content overflowing). */
  scrollbar?: boolean;
}

export interface Issue {
  severity: "error" | "warning";
  id: string;
  message: string;
  path?: string;
  suggestion?: string;
}

export interface Layout {
  width: number;
  active: string[];
  boxes: Box[];
  issues: Issue[];
  /**
   * Elements (component roots and slots) not laid out at all at this width: under a box with no
   * layout, or not a slot or component the engine knows. Their boxes are missing from `boxes`.
   */
  notLaidOut?: { id: string; tag: string; line?: number }[];
  /** The page background from the source, if declared. */
  page?: { background: string; path: string };
  /** How thick its scrollbars were taken to be (0: overlay; 15: classic, --scrollbars classic). */
  scrollbar?: number;
}

/** "abs": an absolutely positioned or fixed box, placed in its containing block. */
type ParentKind = "page" | "abs" | Pattern;
const MEDIA = new Set(["img", "video", "picture", "svg", "canvas", "iframe", "object", "embed"]);
const CONTROLS = new Set(["button", "input", "select", "textarea"]);

/**
 * Where a box sits across a cell it doesn't fill (block flow, a stack, the page): auto inline
 * margins (maxWidth's, or margin: auto) take the space left over, a narrower box is centered by two
 * of them; otherwise it starts after its left margin. A box as wide as the cell (or wider) starts
 * at its left margin.
 */
function offsetX(b: Box, cell: number, flow = false): number {
  const m = marginOf(b.props);
  const free = cell - b.w - m.left - m.right;
  if (b.props.maxWidth && b.w < cell) return (cell - b.w) / 2;
  // In block flow, justify-self places a block that doesn't fill its line (overflowing at either end).
  const js = flow && !m.autoLeft && !m.autoRight ? b.props.place?.value.justify : undefined;
  if (js === "center") return m.left + Math.trunc((free * 64) / 2) / 64;
  if (js === "end") return m.left + free;
  if (free <= 0) return m.left;
  if (m.autoLeft && m.autoRight) return m.left + Math.trunc((free * 64) / 2) / 64;
  if (m.autoLeft) return m.left + free;
  return m.left;
}

/** Children one under another (a stack or block flow): a child that changes size moves only those after it. */
const inLine = (b: Box) =>
  b.props.pattern?.value === "stack" || b.props.pattern?.value === "flow" ||
  // A table's captions and row groups, and a row group's rows, are one under another too (table.ts flags the
  // whole table when what changes is a width).
  b.props.pattern?.value === "table" || /^(header|body|footer)$/.test(b.props.part?.value.part ?? "");

const NO_MARGIN: Margins = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Whether box `b` is the containing block of an absolutely positioned (any positioned box, or
 * layout or paint containment) or fixed (containment only) descendant.
 */
export function containingBlock(b: Box, type: "absolute" | "fixed" | string): boolean {
  if (containsLayout(b.props.contain?.value)) return true;
  return type === "absolute" && !!b.props.position;
}
const marginOf = (p: ResolvedProps): Margins => p.margin?.value ?? NO_MARGIN;
/** Height including the vertical margins (a flex or grid item's outer size; they never collapse there). */
const outerH = (b: Box) => {
  const m = marginOf(b.props);
  return m.top + b.h + m.bottom;
};

/** Layout units (1/64 px) as integers, and back. */
const U = (px: number) => Math.round(px * 64);
const PX = (u: number) => u / 64;

/**
 * Chromium's LayoutUnitDiffuser: `size` (layout units) shared over `buckets`, each the integer
 * share or one unit more, the extra units spread evenly (Bresenham).
 */
function diffuser(size: number, buckets: number) {
  const base = Math.trunc(size / buckets);
  const dx = (size - base * buckets) * 2;
  const dy = buckets * 2;
  let x = 0;
  let y = buckets;
  let count = buckets;
  return () => {
    if (count === 0) return 0;
    count--;
    x += dx;
    if (x >= y) {
      y += dy;
      return base + 1;
    }
    return base;
  };
}

/**
 * Collapsed margins: the largest positive and the most negative margin that adjoin. Their sum is
 * the space they make (CSS 2.1 §8.3.1).
 */
interface Strut {
  pos: number;
  neg: number;
}
const NONE: Strut = { pos: 0, neg: 0 };
const strut = (m: number): Strut => (m >= 0 ? { pos: m, neg: 0 } : { pos: 0, neg: m });
const join = (...xs: Strut[]): Strut => ({ pos: Math.max(0, ...xs.map((x) => x.pos)), neg: Math.min(0, ...xs.map((x) => x.neg)) });
const sum = (x: Strut) => x.pos + x.neg;

/** How a block's vertical margins take part in its parent's block flow. */
interface Collapse {
  /** Its top margin, joined with its first child's when they collapse through it. */
  top: Strut;
  bottom: Strut;
  /** Nothing in it separates its top and bottom margins: they collapse through it into one. */
  empty: boolean;
  /** An empty block's own top margin (where its border box sits). */
  at: Strut;
}

interface FlowResult {
  boxes: Box[];
  contentH: number;
  /** Margins that collapse through the top (first child) and bottom (last child) of the box. */
  top: Strut;
  bottom: Strut;
  /** Only empty children: their margins all collapse into `pending`. */
  empty: boolean;
  pending: Strut;
}

/**
 * The height of one line box. Chromium multiplies a unitless line-height by the font size in
 * layout units (1/64 px, rounded to nearest) and rounds the product down to a layout unit; every
 * line of the text is that tall. (A product within 1/64000 px of a step counts as on it: lift
 * stores px line heights as 6-digit ratios.)
 */
export const lineHeightPx = (sizePx: number, lineHeight: number) => Math.floor((Math.round(sizePx * 64) / 64) * lineHeight * 64 + 1e-3) / 64;
/**
 * The line-height ratio that makes lineHeightPx give `px` (in layout units) at `sizePx`:
 * the shortest of a few roundings (from 6 digits) that does: 16px at 12px stays 1.333333, and 40px at 16.8px works.
 */
export function lineHeightRatio(px: number, sizePx: number): number {
  const want = Math.floor(px * 64 + 1e-3) / 64;
  const exact = px / (Math.round(sizePx * 64) / 64 || sizePx);
  for (const d of [6, 9, 12]) {
    const r = Math.round(exact * 10 ** d) / 10 ** d;
    if (lineHeightPx(sizePx, r) === want) return r;
  }
  return Math.round(exact * 1e12) / 1e12;
}

/**
 * The fonts, weights and faces runs of a text box's text are set in, where they differ from the
 * box's, with the text set in each (and the text inside atomic inlines, in theirs).
 */
function runFontsOf(n: FixtureNode, props: ResolvedProps): { font?: string; weight: number; italic: boolean; text?: string }[] {
  const t = props.text?.value;
  if (!t) return [];
  const out = new Map<string, { font?: string; weight: number; italic: boolean; text?: string }>();
  const add = (f: { font?: string; weight: number; italic: boolean }, text: string) => {
    const key = `${f.font}|${f.weight}|${f.italic}`;
    const o = out.get(key) ?? { ...f, text: "" };
    o.text += text;
    out.set(key, o);
  };
  n.runMeta.forEach((r, i) => {
    for (const sp of r.spans ?? []) {
      for (const x of sp.inner ?? []) add({ font: x.font, weight: x.weight, italic: x.italic }, x.text);
      if (sp.face && !styled(sp)) add(sp.face, [...(n.runs[i] ?? "")].slice(sp.from, sp.to).join("").replaceAll("￼", ""));
      if (sp.font === undefined && sp.italic === undefined && sp.weight === undefined) continue;
      add({ font: sp.font ?? t.font, weight: sp.weight ?? t.weight, italic: sp.italic ?? !!t.italic }, [...(n.runs[i] ?? "")].slice(sp.from, sp.to).join("").replaceAll("￼", ""));
    }
  });
  return [...out.values()];
}

/**
 * Inter's contextual alternates draw a lowercase "x" between digits (a space, no-break space or
 * narrow no-break space on either side allowed) as "×", unless the digit before it is a 0 that
 * doesn't follow a digit (a hex prefix, "0x2"). Probed in Chromium at weights 100 to 900: such a
 * run is as wide as the same run with "×". An "x" whose context spans a change of font or the edge
 * of an inline box with margins, border or padding (shaped apart) isn't known: with `doubt`, true
 * when there is one; otherwise the text with each such "x" replaced.
 */
function interTimes(r: string, spans: Span[] | undefined, doubt?: false): string;
function interTimes(r: string, spans: Span[] | undefined, doubt: true): boolean;
function interTimes(r: string, spans: Span[] | undefined, doubt = false): string | boolean {
  if (!r.includes("x")) return doubt ? false : r;
  const cs = [...r];
  const sp = (c: string | undefined) => c === " " || c === "\u00a0" || c === "\u202f";
  const digit = (c: string | undefined) => !!c && c >= "0" && c <= "9";
  const split = (a: number, b: number) => (spans ?? []).some((x) => (styled(x) || x.open || x.close || x.openAt) && ((x.from > a && x.from <= b) || (x.to > a && x.to <= b)));
  for (let i = 0; i < cs.length; i++) {
    if (cs[i] !== "x") continue;
    const a = sp(cs[i - 1]) ? i - 2 : i - 1;
    const b = sp(cs[i + 1]) ? i + 2 : i + 1;
    if (!digit(cs[a]) || !digit(cs[b]) || (cs[a] === "0" && !digit(cs[a - 1]))) continue;
    if (split(a, b)) {
      if (doubt) return true;
      continue;
    }
    cs[i] = "×";
  }
  return doubt ? false : cs.join("");
}

/** A color that paints nothing (a background in it doesn't count as painted). */
function transparent(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (c === "transparent" || /^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/.test(c)) return true;
  const f = /^(?:rgba?|hsla?)\((.*)\)$/.exec(c);
  if (!f) return false;
  const args = f[1].includes("/") ? f[1].split("/").map((x) => x.trim()) : f[1].split(",").map((x) => x.trim());
  const alpha = f[1].includes("/") ? args[1] : args.length === 4 ? args[3] : undefined;
  return alpha !== undefined && parseFloat(alpha) === 0;
}

interface Arrangement {
  rows: Box[][];
  /** Natural height of each row. */
  heights: number[];
  gap: number;
  /** A grid's percentage row gap: of its final content height (its rows were sized with none). */
  gapPct?: number;
  align: "start" | "center" | "end" | "stretch" | "baseline";
  insetTop: number;
  insetY: number;
  /** A wrapping flex container's lines share extra height in layout units (Chromium's diffuser). */
  flexLines: boolean;
  /** A cluster that doesn't wrap: its one line is its content box's height. */
  oneLine: boolean;
}

/** A stack whose children grow into its extra height (flex-grow in a column). */
interface StackGrow {
  kids: Box[];
  gap: number;
  insetTop: number;
  insetY: number;
  /** Each child's own (content) height before growing. */
  natural: number[];
}

/** Intrinsic widths (border box, px): min-content and max-content, or why they aren't known. */
interface Intrinsic {
  min: number;
  max: number;
  why?: string;
  /** A row of several items inside, whose max-content the browser takes from its wrapped lines when the box is narrower. */
  wraps?: boolean;
  /** With `why`: the min-content width is known all the same (a compressible form field inside), only the max-content one isn't. */
  minKnown?: boolean;
}

/**
 * Lay out a page at a viewport width. Where scrollbars take space (classic, --scrollbars classic),
 * the page's own appear as Chromium shows them: a vertical one when the page is taller than the
 * window by half a pixel or more, a horizontal one when it is wider than its layout width; each
 * takes 15px from the window (the page is laid out again, narrower). Media queries and vw units
 * keep the whole window's width.
 */
export function layout(model: Model, fixture: Fixture, width: number): Layout {
  const SB = scrollbarPx();
  const bars = { x: false, y: false };
  /**
   * The scrollbars each scroll container showed in the pass before. When the page is laid out
   * again because its own scrollbars appeared, Chromium keeps every inner scroll container's
   * scrollbars as they were (they are frozen while a box is laid out again for its scrollbars):
   * probed, a `.table-responsive` that overflows only once the page's scrollbar narrows it shows
   * none, and one that overflowed only before keeps its scrollbar.
   */
  let frozen: Map<FixtureNode, { x: boolean; y: boolean; close?: boolean }> | undefined;
  for (;;) {
    const shown = new Map<FixtureNode, { x: boolean; y: boolean; close?: boolean }>();
    const l = layoutWith(model, fixture, width, bars, frozen, shown);
    frozen ??= shown;
    if (!SB) return l;
    const windowH = model.page?.windowHeight ?? 800;
    const layoutW = width - (bars.y ? SB : 0);
    const x = !model.page?.clipX && l.extent.w - layoutW >= 0.5 - EPS;
    const y = !model.page?.clipY && l.extent.h - (windowH - (bars.x || x ? SB : 0)) >= 0.5 - EPS;
    if ((x && !bars.x) || (y && !bars.y)) {
      bars.x ||= x;
      bars.y ||= y;
      continue;
    }
    const { extent: _, ...out } = l;
    return out;
  }
}

function layoutWith(
  model: Model,
  fixture: Fixture,
  width: number,
  rootBars: { x: boolean; y: boolean },
  pageFrozen: Map<FixtureNode, { x: boolean; y: boolean; close?: boolean }> | undefined,
  shown: Map<FixtureNode, { x: boolean; y: boolean; close?: boolean }>,
): Layout & { extent: { w: number; h: number } } {
  /** Scroll containers' scrollbars kept as they were while a box is laid out again for its own (see layout). */
  let frozen = pageFrozen;
  const issues: Issue[] = [];
  /** Advice in Cadesa's terms, or in CSS terms on a page lifted from its CSS. */
  const say = (cadesa: string, css: string) => (model.css ? css : cadesa);
  const arrangement = new WeakMap<Box, Arrangement>();
  const collapse = new WeakMap<Box, Collapse>();

  /**
   * Block flow: children one under another, each as wide as the content box minus its margins.
   * Adjoining vertical margins collapse to the largest: between siblings, through empty blocks, and
   * (throughTop / throughBottom) with the parent's own margins when nothing separates them.
   */
  function flow(boxes: Box[], cell: number, throughTop: boolean, end: "escape" | "drop" | "keep"): FlowResult {
    let cursor = 0;
    let pending: Strut = NONE;
    let atTop = true;
    let top: Strut = NONE;
    for (const b of boxes) {
      const c = collapse.get(b)!;
      b.x = offsetX(b, cell, true);
      if (c.empty) {
        b.y = atTop && throughTop ? 0 : cursor + sum(join(pending, c.at));
        pending = join(pending, c.top);
        continue;
      }
      if (atTop && throughTop) {
        top = join(pending, c.top);
        b.y = 0;
      } else b.y = cursor + sum(join(pending, c.top));
      atTop = false;
      cursor = b.y + b.h;
      pending = c.bottom;
    }
    if (atTop) return { boxes, contentH: throughTop ? 0 : Math.max(0, sum(pending)), top: pending, bottom: NONE, empty: true, pending };
    return { boxes, contentH: Math.max(0, end === "keep" ? cursor + sum(pending) : cursor), top, bottom: end === "escape" ? pending : NONE, empty: false, pending: NONE };
  }
  /**
   * Whether a box makes a block formatting context of its own (its floats stay inside it, and it
   * sits beside the floats around it): a float, flow-root, a scroll container, layout or paint
   * containment, a flex, grid or table container, a table part, a flex or grid item, an
   * out-of-flow box; and a replaced element or form control, which avoids floats as one does.
   */
  const establishes = (n: FixtureNode, p: ResolvedProps, parent: ParentKind) =>
    !!p.float || (p.root?.value === false && (parent === "flow" || parent === "page") ? false : p.root?.value === true || scrolls(p.overflow?.value) || containsLayout(p.contain?.value) || (!!p.pattern && p.pattern.value !== "flow") || !!p.part ||
    (parent !== "flow" && parent !== "page") || CONTROLS.has(n.tag) || MEDIA.has(n.tag));
  /** Whether anything inside an element floats (at this width). */
  const floatMemo = new Map<FixtureNode, boolean>();
  const floatsInside = (n: FixtureNode, c: Component): boolean => {
    let r = floatMemo.get(n);
    if (r === undefined) {
      r = n.children.some((k) => {
        const ch = childOf(k, c, true);
        return !!ch.comp && (!!resolveElement(model, ch.comp, ch.slot, width).float || floatsInside(k, ch.comp));
      });
      floatMemo.set(n, r);
    }
    return r;
  };
  /** A text box's classed children when every one of them floats (floats among its text), else none. */
  const textFloatsOf = (n: FixtureNode, c: Component, p: ResolvedProps): Kid[] => {
    if (!p.text || !n.runMeta.some((r) => r.floats?.length)) return [];
    const kids = classedOf(n, c).map((k) => ({ node: k, ...childOf(k, c, true) }));
    return kids.length && kids.every((k) => k.comp && resolveElement(model, k.comp, k.slot, width).float) ? (kids as Kid[]) : [];
  };
  /** Boxes that float: out of their parent's block flow (their margins collapse with nothing). */
  const floated = new WeakSet<Box>();

  /**
   * Block flow in a block formatting context with floats (any above this container's top that
   * reach into it, any among its children or inside them): children are laid out one after the
   * other where they end up, as Chromium's LayoutNG does. A float is placed where it occurs (below
   * the content before it and the margins pending there; at the container's top while nothing in
   * it has come down from its top yet), as CSS 2.1 §9.5.1 places it; a box with `clear` goes below
   * the floats it clears unless it is already lower; a box that makes a formatting context of its
   * own goes in the first room beside the floats (from its place down) that it fits, as wide as that
   * room when its width is auto. Everything else is laid out where it is, so its lines go around
   * the floats. Without floats it is `flow`.
   */
  function flowKids(kids: Kid[], cell: number, throughTop: boolean, end: "escape" | "drop" | "keep", ctx: Bfc, kind: "flow" | "page"): FlowResult {
    const kp = kids.map((k) => resolveElement(model, k.comp, k.slot, width));
    const seq = ctx.ex.bottom > ctx.y + EPS || kids.some((k, i) => kp[i].float || kp[i].clear || floatsInside(k.node, k.comp));
    if (!seq) return flow(kids.map((k) => measure(k.node, k.comp, k.slot, cell, kind)), cell, throughTop, end);
    let cursor = 0;
    let pending: Strut = NONE;
    let atTop = true;
    let top: Strut = NONE;
    const boxes: Box[] = [];
    const L = ctx.x;
    const R = ctx.x + cell;
    const save = () => ({ auto, issues: issues.length, abs: absQueue.length, ex: ctx.ex.mark() });
    const restore = (u: ReturnType<typeof save>) => {
      auto = u.auto;
      issues.length = u.issues;
      absQueue.length = u.abs;
      ctx.ex.reset(u.ex);
    };
    kids.forEach((k, i) => {
      const p = atBase(kp[i], cell);
      const m0 = marginOf(p);
      // Where the content so far ends, with the margins pending there (at the top: the container's own top).
      const here = atTop ? (throughTop ? 0 : sum(pending)) : cursor + sum(pending);
      if (p.float) {
        const b = measure(k.node, k.comp, k.slot, cell, kind);
        const m = marginOf(b.props);
        // A float that clears goes below the floats it clears too.
        const from = Math.max(ctx.y + here, p.clear ? ctx.ex.clearance(p.clear.value) : -Infinity);
        const at = ctx.ex.place(p.float.value, m.left + b.w + m.right, m.top + b.h + m.bottom, from, L, R);
        b.x = at.x - ctx.x + m.left;
        b.y = at.y - ctx.y + m.top;
        // (A float's auto margins are 0, CSS 2.1 §10.3.5: it goes to its side whatever they are.)
        // One capped by a max-width without a width of its own is as wide as its content up to
        // it, which the lift's maxWidth (as wide as its container up to it) doesn't say.
        if (p.maxWidth && p.width === undefined) b.assumptions.push("a float with a max-width and no width (as wide as its content up to it) isn't modelled");
        collapse.set(b, { top: NONE, bottom: NONE, empty: true, at: NONE });
        floated.add(b);
        boxes.push(b);
        return;
      }
      const clearTo = p.clear ? ctx.ex.clearance(p.clear.value) - ctx.y : -Infinity;
      const first = atTop && throughTop;
      if (establishes(k.node, p, kind)) {
        // Its own margins collapse with those before it (not with what is inside it).
        const hyp = first ? 0 : cursor + sum(join(pending, strut(m0.top)));
        let Y = ctx.y + Math.max(hyp, clearTo);
        let b: Box | undefined;
        let x = 0;
        const auto0 = p.width === undefined && !p.maxWidth && !p.aspect && !p.float;
        for (let guard = 0; !b && guard < 200; guard++) {
          // The rooms beside the floats at Y, widest (shortest) first.
          const tops = [...new Set(ctx.ex.floats.map((f) => f.t).filter((t) => t > Y + EPS))].sort((a, z) => a - z);
          const opps: { l: number; r: number; h: number; beside: boolean }[] = [];
          for (const t of [...tops, Infinity]) {
            const bd = ctx.ex.band(Y, isFinite(t) ? t - Y : 1e9, L, R);
            const last = opps.at(-1);
            if (last && Math.abs(bd.l - last.l) < EPS && Math.abs(bd.r - last.r) < EPS) last.h = t - Y;
            else opps.push({ ...bd, h: t - Y });
          }
          for (const o of opps) {
            const u = save();
            const ox = Math.max(o.l, L + m0.left);
            const lim = Math.min(o.r, R - m0.right);
            const kb = auto0 ? measure(k.node, k.comp, k.slot, Math.max(0, lim - ox) + m0.left + m0.right, kind, undefined, undefined, cell) : measure(k.node, k.comp, k.slot, cell, kind);
            // (A room past the container's end, beyond a float wider than it, is as wide as nothing.)
            if (!o.beside || (kb.w <= Math.max(0, lim - ox) + EPS && kb.h <= o.h + EPS)) {
              b = kb;
              x = o.beside ? ox - ctx.x : offsetX(kb, cell, true);
              break;
            }
            restore(u);
          }
          if (!b) {
            const below = Math.min(...ctx.ex.floats.map((f) => f.b).filter((v) => v > Y + EPS));
            if (!isFinite(below)) break;
            Y = below;
          }
        }
        b ??= measure(k.node, k.comp, k.slot, cell, kind);
        b.x = x;
        b.y = Y - ctx.y;
        if (ctx.ex.floats.length) b.afterFloats = true;
        if (first && b.y > EPS) b.assumptions.push("the first box of a block whose top margin collapses with it, moved down by floats (or clearance), isn't modelled");
        if (Math.abs(b.x - offsetX(b, cell, true)) > EPS && (m0.autoLeft || m0.autoRight || p.maxWidth)) b.assumptions.push("a box beside floats with auto margins isn't modelled");
        if (first) top = join(pending, collapse.get(b)!.top);
        atTop = false;
        cursor = b.y + b.h;
        pending = collapse.get(b)!.bottom;
        boxes.push(b);
        return;
      }
      // A block in this formatting context: laid out where it goes (first where it would go if its
      // first child's top margin added nothing to its own; again if it ends up elsewhere).
      const u = save();
      const bottom0 = ctx.ex.bottom;
      const gy = first ? 0 : cursor + sum(join(pending, strut(m0.top)));
      const gx = m0.left;
      let b = measure(k.node, k.comp, k.slot, cell, kind, undefined, undefined, undefined, undefined, undefined, { ex: ctx.ex, x: ctx.x + gx, y: ctx.y + gy });
      let c = collapse.get(b)!;
      const x = offsetX(b, cell, true);
      let y = c.empty ? (first ? 0 : cursor + sum(join(pending, c.at))) : first ? 0 : cursor + sum(join(pending, c.top));
      const cleared = clearTo > y + EPS;
      if (cleared) y = clearTo;
      if ((Math.abs(x - gx) > EPS || Math.abs(y - gy) > EPS) && (ctx.ex.floats.length > u.ex[0] || bottom0 > ctx.y + Math.min(y, gy) + EPS)) {
        restore(u);
        b = measure(k.node, k.comp, k.slot, cell, kind, undefined, undefined, undefined, undefined, undefined, { ex: ctx.ex, x: ctx.x + x, y: ctx.y + y });
        c = collapse.get(b)!;
      }
      b.x = x;
      b.y = y;
      if (ctx.ex.floats.length) b.afterFloats = true;
      boxes.push(b);
      if (cleared && first && (c.top.pos !== 0 || c.top.neg !== 0)) b.assumptions.push("clearance on the first box of a block whose top margin collapses with it isn't modelled");
      if (c.empty && !cleared) {
        pending = join(pending, c.top);
        return;
      }
      if (first && !cleared) top = join(pending, c.top);
      atTop = false;
      cursor = b.y + b.h;
      pending = c.bottom;
    });
    if (atTop) return { boxes, contentH: throughTop ? 0 : Math.max(0, sum(pending)), top: pending, bottom: NONE, empty: true, pending };
    return { boxes, contentH: Math.max(0, end === "keep" ? cursor + sum(pending) : cursor), top, bottom: end === "escape" ? pending : NONE, empty: false, pending: NONE };
  }

  /** Absolutely positioned or fixed: out of flow. */
  const outOfFlow = (c: Component, slot: string | undefined) => {
    const t = resolveElement(model, c, slot, width).position?.value.type;
    return t === "absolute" || t === "fixed";
  };
  /** Out-of-flow boxes waiting for their containing block's final geometry, parents first. */
  const absQueue: {
    k: { node: FixtureNode; comp: Component; slot: string | undefined };
    parent: Box | undefined;
    /** Its static position from its parent's content box corner (before its own margins), or undefined when it isn't known. */
    at?: { x: number; y: number };
  }[] = [];
  /** Each placed out-of-flow box: its containing block (undefined: the window) and whether it sits at its static position. */
  const absInfo = new Map<Box, { cb?: Box; parent?: Box; staticPos: boolean }>();
  /** A classic scrollbar's thickness (0 where scrollbars are overlaid). */
  const SB = scrollbarPx();
  /** The window (fixed boxes, and absolute ones with no positioned ancestor, are placed in it): its height, and the part of it the page is laid out in (less its own scrollbars). */
  const windowH = (model.page?.windowHeight ?? 800) - (rootBars.x ? SB : 0);
  const layoutW = width - (rootBars.y ? SB : 0);

  /** Elements of the fixture (component roots and slots) that aren't laid out at all, with their descendants. */
  const skippedEls = new Map<FixtureNode, { id: string; tag: string; line?: number }>();
  const isBox = (n: FixtureNode) => n.classes.some((k) => k.startsWith(model.prefix) && (k.includes("__") || model.components.has(k.slice(model.prefix.length))));
  const notLaidOut = (n: FixtureNode) => {
    if (isBox(n) && !skippedEls.has(n)) skippedEls.set(n, { id: n.fixtureId ?? n.tag, tag: n.tag, ...(n.line && { line: n.line }) });
    n.children.forEach(notLaidOut);
  };
  /** Boxes the engine can't guarantee beyond their own assumptions and errors, and why. */
  const sources = new Map<Box, string>();
  let auto = 0;
  const idOf = (n: FixtureNode) => n.fixtureId ?? `${n.tag}#${++auto}`;

  /** Measure the text of a leaf box. Returns undefined when the font has no metrics. */
  function text(n: FixtureNode, props: ResolvedProps, id: string, assumptions: string[]) {
    const t = props.text!.value;
    const m = metricsFor(t.font, !!t.italic);
    const raw = n.runs.length ? n.runs : [n.text];
    // Inter draws an "x" between digits as a multiplication sign (its contextual alternates): measured as "×".
    const inter = m?.family === "Inter" && !t.letterSpacing;
    const runs = raw.map((r, i) => (t.uppercase ? r.toUpperCase() : inter ? interTimes(r, n.runMeta[i]?.spans) : r));
    const shown = [...runs, ...n.runMeta.flatMap((r) => (r.lead ? [r.lead.text] : []))].join(" ").replaceAll("\uFFFC", "");
    // Runs in another font: that font's metrics, for the characters in it, at its weights.
    const runFonts = n.runMeta.flatMap((r, i) => (r.spans ?? []).filter((sp) => sp.font !== undefined || (sp.italic !== undefined && sp.italic !== !!t.italic)).map((sp) => ({ sp, text: [...(runs[i] ?? "")].slice(sp.from, sp.to).join("").replaceAll("\uFFFC", "") })));
    const runWhy = runFonts
      .map(({ sp, text }) => {
        const rm = metricsFor(sp.font ?? t.font, sp.italic ?? !!t.italic);
        const fam = `${(sp.font ?? t.font ?? "inherited").split(",")[0].trim()}${(sp.italic ?? t.italic) ? " italic" : ""}`;
        if (!rm) return `font "${fam}" has no Cadesa metrics; cadesa fonts (MCP: cadesa_fonts) finds the page's fonts and measures them`;
        const un = rm.unsupported(text);
        if (un.length) return `characters outside the measured set of "${fam}": ${un.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ")}`;
        return undefined;
      })
      .find(Boolean);
    const why = !m
      ? `font "${(t.font ?? "inherited").split(",")[0]}${t.italic ? " italic" : ""}" has no Cadesa metrics; cadesa fonts (MCP: cadesa_fonts) finds the page's fonts and measures them`
      : m.unsupported(shown).length
        ? `characters outside the measured set: ${m.unsupported(shown).map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ")}`
        : runWhy;
    if (why) {
      assumptions.push(`text height assumes a single line (${why})`);
      return undefined;
    }
    // Chromium drops letter-spacing from text that has a U+202F (narrow no-break space) and no
    // letter: the run's script resolves to Mongolian, a cursive script, which is never spaced out.
    const unspaced = (s: string) => s.includes(" ") && !/\p{L}/u.test(s);
    // Only its ordinary and no-break spaces keep their letter-spacing.
    const spacesOnly = !!t.letterSpacing && unspaced(shown);
    if (t.letterSpacing && !spacesOnly && runs.length > 1 && runs.some(unspaced))
      assumptions.push("letter-spacing may be dropped from a paragraph that has a U+202F and no letters");
    // Contextual alternates change glyphs (and widths) depending on their neighbours: Inter draws
    // "*" and "@" differently between capitals, and "x" between digits as "×".
    const contextual = /[*@<>\\]/.test(shown) ? shown.match(/[*@<>\\]/)![0] : (inter ? runs.some((r, i) => interTimes(r, n.runMeta[i]?.spans, true)) : /\d ?[xX] ?\d/.test(shown)) ? "x between digits" : undefined;
    if (contextual) assumptions.push(`text width is approximate: "${contextual}" has contextual forms that Cadesa doesn't measure`);
    // A font whose contextual forms can't be searched (a handwriting font): exact where each run
    // of its text was laid out whole in Chromium (`cadesa fonts --measure`) and stays on one line.
    const ctxWhy = `text width is approximate: font "${m!.family}" shapes more runs in context (contextual alternates) than were measured`;
    // A run holding atomic inlines (a badge in another font): Chromium shapes the text on either side
    // of each apart, so each part was laid out whole on its own; the run is as wide as its parts and
    // its atomic inlines.
    const wholeRun = (r: string, i: number): number | undefined => {
      const meta = n.runMeta[i];
      const cs = [...r];
      const atoms = (meta?.spans ?? []).filter((sp) => cs.slice(sp.from, sp.to).join("") === "\uFFFC" && sp.font === undefined && sp.size === undefined && sp.weight === undefined && sp.italic === undefined);
      if ((meta?.spans?.length ?? 0) !== atoms.length || (meta?.items ?? []).some((b) => cs[b - 1] !== "\uFFFC" && cs[b] !== "\uFFFC")) return undefined;
      const line = r.replace(/[ \t\n\r\f]+/g, " ").trim();
      if (!atoms.length) return m!.lineWidth(line, t.sizePx, t.weight);
      let total = atoms.reduce((s, sp) => s + (sp.open ?? (sp.openAt ? sp.openAt(t.sizePx) : 0)) + (sp.close ?? 0), 0);
      for (const part of line.split("\uFFFC").filter(Boolean)) {
        const w = m!.lineWidth(part, t.sizePx, t.weight);
        if (w === undefined) return undefined;
        total += w;
      }
      return total;
    };
    const whole = m!.info.contextualIncomplete && /\S/.test(shown) && !t.letterSpacing && !t.wrapAnywhere ? runs.map(wholeRun) : undefined;
    const wholeOk = !!whole && whole.every((x) => x !== undefined);
    // Where such a run wraps: every line it can break into, laid out in Chromium (FontMetrics.wraps),
    // for a run of plain text (no inline elements, floats or other break opportunities).
    const wraps = wholeOk && !t.nowrap && !t.breaks
      ? runs.map((r, i) => {
          const mt = n.runMeta[i];
          if (mt && (mt.spans?.length || mt.items.length || mt.floats?.length || mt.lead)) return undefined;
          const line = r.replace(/[ \t\n\r\f]+/g, " ").trim();
          if (pieces(line).slice(0, -1).some((x) => !x.endsWith(" "))) return undefined;
          const w = m!.wraps(line, t.sizePx, t.weight);
          return w && { line, ...w };
        })
      : undefined;
    if (!contextual && m!.info.contextualIncomplete && /\S/.test(shown) && !wholeOk) assumptions.push(ctxWhy);
    // Whether a hanging space's kerning counts at a line end depends on the block that holds the
    // line: not when it paints a background, border or shadow (the text box itself; a <p> inside it
    // is its own, unpainted block) or its text is underlined. Under an underlined inline element
    // (<a href>, <u>...) it varies with where the element starts and ends, so both ways are tried
    // and the box is flagged when they disagree.
    const painted = (props.background && !transparent(props.background.value)) || props.backdrop || props.border || props.shadow;
    const meta = runs.map((_, i) => n.runMeta[i] ?? { inBlock: false, underlined: false, items: [] });
    // Inline element edges, moved for uppercasing that changes lengths ("ß" is "SS").
    const moved = (r: string, b: number) => (t.uppercase ? [...[...r].slice(0, b).join("").toUpperCase()].length : b);
    const items = raw.map((r, i) => meta[i].items.map((b) => moved(r, b)));
    // (An atomic inline sized in em: its width at this font size.)
    const spans = raw.map((r, i) => meta[i].spans?.filter((sp) => styled(sp) || sp.open || sp.close || sp.openAt).map(({ openAt, ...sp }) => ({ ...sp, ...(openAt && { open: openAt(t.sizePx) }), from: moved(r, sp.from), to: moved(r, sp.to) })));
    // A float at the start of a run: as wide as its text (rounded up to a layout unit) plus its edges.
    const leads = meta.map((r) => {
      if (!r.lead) return undefined;
      const lt = t.uppercase ? r.lead.text.toUpperCase() : r.lead.text;
      const one = layoutText(m!, lt, t.sizePx, r.lead.weight ?? t.weight, Infinity, { letterSpacing: t.letterSpacing, hangKern: false });
      return Math.ceil(one.maxContent * 64 - TEXT_EPS) / 64 + r.lead.extra;
    });
    // Inline boxes that may reach past the strut: lines are sized around the baseline, from the
    // font's vertical metrics (the leading split as Chromium splits it, floor(leading / 2) above).
    let strut: { above: number; below: number } | undefined;
    if (n.runMeta.some((r) => r.spans?.some((sp) => sp.above !== undefined || sp.below !== undefined || sp.byExtent))) {
      const v = m!.vertical(t.sizePx, t.weight);
      if (!v) assumptions.push(`font-family: ${m!.family}: re-measure: cadesa fonts … --measure${m!.info.machineSpecific ? " --system" : ""}; its metrics table has no vertical metrics, so its line heights assume the strut`);
      else {
        const lh = lineHeightPx(t.sizePx, t.lineHeight);
        const leading = Math.round((lh - v.ascent - v.descent) * 64);
        const above = v.ascent + Math.floor(Math.trunc(leading / 2) / 64);
        strut = { above, below: lh - above };
      }
    }
    let ambiguous = false;
    let anywhereFlagged = false;
    // A <button> centers its text unless the role says otherwise (the reset leaves text-align alone).
    const align = props.textAlign?.value ?? (n.tag === "button" ? "center" : "start");
    // Each run (paragraph, list item, line after <br>) starts on a new line.
    // Beside floats (band): each run's lines go on from where the run before it ended.
    // Floats among the text (inlineFloat: the width of one, and where it goes) are placed as its lines are.
    return (maxWidth: number, band?: Band, inlineFloat?: (index: number) => { w: number; fitsAt: (top: number) => boolean; place: (top: number) => void }) => {
      const lineH = lineHeightPx(t.sizePx, t.lineHeight);
      let off = 0;
      // Measured whole: exact while each run fits on one line, or where it wraps was measured too.
      if (wholeOk && !assumptions.includes(ctxWhy) && (band || (isFinite(maxWidth) && whole!.some((x, i) => x! > maxWidth + 1 / 64 + TEXT_EPS && !wraps?.[i])))) assumptions.push(ctxWhy);
      // Its room in layout units (as Chromium's line breaker has it).
      const room = Math.floor(maxWidth * 64 + 1e-6) / 64;
      const parts = runs.map((r, i) => {
        const runBand: Band | undefined = band && ((top, h, fits) => {
          const at = band(top + off, h, fits);
          return { ...at, top: at.top - off };
        });
        const floats = inlineFloat && meta[i].floats?.map((f) => {
          const g = inlineFloat(f.index);
          return { at: moved(raw[i], f.at), w: g.w, ...(f.edge && { edge: true }), fitsAt: (top: number) => g.fitsAt(top + off), place: (top: number) => g.place(top + off) };
        });
        const opts = { letterSpacing: t.letterSpacing, spacesOnly, wrapAnywhere: t.wrapAnywhere, breakWord: t.breakWord, ...(t.breaks && { breaks: t.breaks }), items: items[i], spans: spans[i], lead: leads[i], strut, ...(runBand && { band: runBand, lineH }), ...(floats?.length && { floats }) };
        /** Lines beside floats: placed from the content box's top. */
        const done = <T extends { lines: Line[] }>(x: T): T => {
          if (!band) return x;
          for (const l of x.lines) l.top = (l.top ?? 0) + off;
          const last = x.lines.at(-1);
          if (last) off = last.top! + (last.h ?? lineH);
          return x;
        };
        const wr = wraps?.[i];
        if (wr && !runBand) {
          // Greedy, as Chromium's line breaker: from each line's start, the farthest break
          // opportunity it reaches in the room (at least one word).
          const lines: Line[] = [];
          let minContent = 0;
          let widestPiece = "";
          let unknown = false;
          for (let a = 0; a < wr.opps.length - 1; ) {
            const row = wr.fit[a];
            let b = a + 1;
            while (b + 1 < wr.opps.length && row[b - a] !== undefined && row[b - a] <= room + 1e-9) b++;
            // A row cut short (wider lines than were measured) where the room is wider still.
            if (b + 1 < wr.opps.length && row[b - a] === undefined) unknown = true;
            const width = wr.width[a][b - a - 1];
            if (width === undefined) unknown = true;
            lines.push({ text: wr.line.slice(wr.opps[a], wr.opps[b]).trimEnd(), width: width ?? 0, at: wr.opps[a] });
            a = b;
          }
          for (let a = 0; a < wr.opps.length - 1; a++) {
            const w = wr.width[a][0];
            if (w === undefined) unknown = true;
            else if (w > minContent) (minContent = w), (widestPiece = wr.line.slice(wr.opps[a], wr.opps[a + 1]).trim());
          }
          if (unknown && !assumptions.includes(ctxWhy)) assumptions.push(ctxWhy);
          // One line: as wide as the run measured whole.
          if (lines.length === 1) lines[0].width = whole![i]!;
          return done({ lines, maxContent: whole![i]!, minContent, widestPiece });
        }
        // white-space: nowrap: the paragraph is one line, and its min-content is its whole width.
        if (t.nowrap) {
          const one = layoutText(m!, r, t.sizePx, t.weight, Infinity, { ...opts, band: undefined, wrapAnywhere: false, hangKern: false });
          if (runBand) {
            const at = runBand(0, lineH, (w) => one.maxContent <= w + 1 / 64 + TEXT_EPS);
            for (const l of one.lines) Object.assign(l, { x: at.l, room: at.r - at.l, top: at.top });
          }
          return done({ ...one, minContent: one.maxContent, widestPiece: r.trim() });
        }
        // Centered or end-aligned lines measure their hanging space's kerning out too.
        const plain = t.underline || (!!painted && !meta[i].inBlock) || align !== "start" || t.nowrap;
        const a = layoutText(m!, r, t.sizePx, t.weight, maxWidth, { ...opts, hangKern: !plain });
        if (a.approximate && !anywhereFlagged) {
          anywhereFlagged = true;
          assumptions.push(`line breaks are approximate: ${a.approximate}`);
        }
        if (!plain && meta[i].underlined && !ambiguous) {
          // (Its floats were placed by the first pass: not again.)
          const b = layoutText(m!, r, t.sizePx, t.weight, maxWidth, { ...opts, hangKern: false, ...(opts.floats && { floats: opts.floats.map((f) => ({ ...f, place: () => {} })) }) });
          if (b.lines.length !== a.lines.length || b.lines.some((l, k) => l.text !== a.lines[k].text) || Math.abs(b.minContent - a.minContent) > 1e-9) {
            ambiguous = true;
            assumptions.push("line breaks are approximate: a space at a line end inside underlined inline text (a link) changes the line's width");
          }
        }
        return done(a);
      });
      const widest = parts.reduce((a, b) => (b.minContent > a.minContent ? b : a));
      return {
        lines: parts.flatMap((p) => p.lines),
        maxContent: Math.max(...parts.map((p) => p.maxContent)),
        minContent: widest.minContent,
        widestPiece: widest.widestPiece,
      };
    };
  }

  const stackGrow = new WeakMap<Box, StackGrow>();
  const intrinsicCache = new Map<FixtureNode, Intrinsic>();
  const contentCache = new Map<FixtureNode, Intrinsic>();
  /** Intrinsic widths are rounded up to a layout unit, so content fits the box it sizes. */
  const up = (v: number) => Math.ceil(v * 64 - TEXT_EPS) / 64;
  /**
   * A box's content-sized widths once its own percentage padding is resolved (a flex item, an
   * absolutely positioned box: the containing block's width is known). Intrinsic sizes count those
   * percentages as 0, as Chromium does; the box itself adds its resolved padding to its content.
   */
  const withOwnPct = (it: Intrinsic, raw: ResolvedProps, resolved: ResolvedProps): Intrinsic => {
    if (it.why || raw === resolved) return it;
    const a = insets(raw);
    const b = insets(resolved);
    const d = b.left + b.right - (a.left + a.right);
    return d ? { ...it, min: it.min + d, max: it.max + d } : it;
  };

  /** Children that are Cadesa slots or components; anything else inside a text box is inline text. */
  const classedOf = (n: FixtureNode, c: Component) =>
    n.children.filter((k) => k.classes.some((cl) => cl.startsWith(model.prefix) && (cl.startsWith(`${model.prefix}${c.name}__`) || model.components.has(cl.slice(model.prefix.length)))));

  // Tables (table.ts): what doesn't depend on the table's width is worked out once per table.
  const grids = new Map<FixtureNode, Grid>();
  const tableHooks: TableHooks = {
    props: (k) => resolveElement(model, k.comp, k.slot, width),
    kids: (n, c) =>
      n.children.map((k) => {
        const r = childOf(k, c);
        return { node: k, comp: r.comp, slot: r.slot, out: !!r.comp && outOfFlow(r.comp, r.slot) };
      }),
    content: (k, cell) => {
      // (A cell's content is measured inside the cell: a table in it doesn't count its column percentages.)
      if (cell) flexAncestors++;
      const it = intrinsic(k.node, k.comp, k.slot, true);
      if (cell) flexAncestors--;
      if (it.why) return it;
      const ins = insets(resolveElement(model, k.comp, k.slot, width));
      return { min: it.min - ins.left - ins.right, max: it.max - ins.left - ins.right };
    },
    measure: (k, avail, w, over) => measure(k.node, k.comp, k.slot, avail, "table", w, over),
    box: (k, over) => ({
      id: idOf(k.node),
      tag: k.node.tag,
      component: k.comp.name,
      slot: k.slot,
      sourcePath: k.slot ? `${k.comp.path}.slots.${k.slot}` : k.comp.path,
      fixtureLine: k.node.line,
      attrs: k.node.attrs,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      props: { ...resolveElement(model, k.comp, k.slot, width), ...over },
      assumptions: [],
      children: [],
    }),
    lineHeight: lineHeightPx,
    skip: (n) => notLaidOut(n),
    doubtful: (b) => {
      for (const x of walk([b])) {
        const why = x.assumptions[0] ?? issues.find((i) => i.severity === "error" && i.id === x.id)?.message;
        if (why) return why;
      }
      return undefined;
    },
  };
  /** Flex and grid containers and table cells being laid out around what's measured now. */
  let flexAncestors = 0;
  const gridOf = (n: FixtureNode, c: Component, props: ResolvedProps) => {
    let g = grids.get(n);
    if (!g) grids.set(n, (g = tableGrid(tableHooks, n, c, props)));
    return g;
  };

  /**
   * Chromium's LineFlexer (line_flexer.cc): the items of a line share its free space. Growing, in
   * proportion to their grow factors (float); shrinking (a line too full, which only a
   * non-wrapping cluster has), in proportion to shrink × content size. The last item goes first,
   * each taking its fraction of what is left (rounded to a layout unit) so the shares add up
   * exactly; an item pushed past its minimum or maximum is frozen there and the rest shared again.
   * Everything in layout units; `out` is an item's margins, `pad` its padding and border. Returns
   * each item's size, or undefined when the line neither grows nor shrinks.
   */
  function flexLine(
    items: { base: number; hyp: number; factor: number; shrink: number; pad: number; min: number; max: number; out: number }[],
    inner: number,
    gap: number,
  ): number[] | undefined {
    const n = items.length;
    const grow = items.reduce((t, it) => t + it.hyp + it.out, 0) + gap * (n - 1) < inner;
    const factor = (i: number) => (grow ? items[i].factor : items[i].shrink);
    if (!items.some((_, i) => factor(i) > 0)) return undefined;
    const st = items.map((it, i) => ({ frozen: factor(i) === 0 || (grow ? it.base > it.hyp : it.base < it.hyp), size: it.hyp, frac: 0, viol: 0 }));
    let total = 0;
    let free = 0;
    const freeze = (should: (i: number) => boolean) => {
      total = 0;
      let weighted = 0;
      free = inner;
      items.forEach((it, i) => {
        if (st[i].frozen || should(i)) {
          st[i].frozen = true;
          free -= st[i].size + it.out + gap;
          return;
        }
        st[i].size = it.hyp;
        const f = Math.fround(factor(i));
        total += f;
        if (grow) st[i].frac = f / total;
        else {
          // Shrinking is weighted by the content size (the flex base size without padding and border).
          const w = f * (it.base - it.pad);
          weighted += w;
          st[i].frac = w / weighted;
        }
        free -= it.base + it.out + gap;
      });
      free += gap;
    };
    freeze(() => false);
    const initial = free;
    // FromDoubleRound: halves away from zero.
    const round = (x: number) => Math.sign(x) * Math.round(Math.abs(x));
    for (let loop = 0; loop <= n; loop++) {
      // Factors that add up to less than 1 share only that fraction of the free space.
      if (total > 0 && total < 1) {
        const part = Math.trunc(initial * total);
        if (Math.abs(part) < Math.abs(free)) free = part;
      }
      if (grow ? free <= 0 : free >= 0) break;
      let violation = 0;
      for (let i = n - 1; i >= 0; i--) {
        if (st[i].frozen) continue;
        const raw = free * st[i].frac;
        const extra = st[i].frac === 1 ? free : isFinite(raw) ? round(raw) : 0;
        free -= extra;
        const size = items[i].base + extra;
        const clamped = Math.max(Math.min(size, items[i].max), items[i].min);
        st[i].size = clamped;
        st[i].viol = clamped - size;
        violation += clamped - size;
      }
      if (!violation) break;
      freeze((i) => (violation > 0 ? st[i].viol > 0 : st[i].viol < 0));
    }
    return st.map((x) => x.size);
  }

  /**
   * An element's min-content and max-content widths (border box), as Chromium computes them for a
   * box sized by its content: text measured; block flow, stacks and layers the widest child (with
   * its margins); a cluster's min the widest child, its max all of them side by side with the gaps.
   */
  function intrinsic(n: FixtureNode, c: Component, slot: string | undefined, contentOnly = false): Intrinsic {
    const cache = contentOnly ? contentCache : intrinsicCache;
    let r = cache.get(n);
    if (!r) {
      r = intrinsicOf(n, c, slot, contentOnly);
      cache.set(n, r);
    }
    return r;
  }
  /** contentOnly: the content's own sizes, whatever width the box sets (a flex item's content size suggestion). */
  function intrinsicOf(n: FixtureNode, c: Component, slot: string | undefined, contentOnly: boolean): Intrinsic {
    const raw = resolveElement(model, c, slot, width);
    // A vertical scrollbar that is always there (overflow-y: scroll) takes width next to the content.
    const p = SB && raw.overflow?.value.y === "scroll" ? { ...raw, scrollbar: { value: { x: 0, y: SB }, display: `${SB}px`, steps: raw.overflow.steps } } : raw;
    const ins = insets(p);
    const insX = ins.left + ins.right;
    const unknown = (why: string): Intrinsic => ({ min: 0, max: 0, why });
    // A width or max width with a percentage in it is cyclic here (the box being sized holds this
    // one): for its intrinsic contribution the whole value counts as auto or none (CSS Sizing §5.2.1).
    const capOf = (r?: { value: number | { pct: number } }) => (r === undefined ? Infinity : typeof r.value === "number" ? r.value : Infinity);
    // (A content size suggestion: the caller clamps it by the box's own max width, which may be a percentage.)
    const cap = contentOnly ? Infinity : Math.min(capOf(p.maxWidth), capOf(p.measure));
    const pw = contentOnly || (typeof p.width?.value === "object") ? undefined : p.width?.value;
    // A table: its columns' widths (never narrower than their minimum, whatever its width says).
    if (p.pattern?.value === "table") {
      // (Its column percentages count only where no flex or grid container or table cell is around it.)
      const t = tableIntrinsic(gridOf(n, c, p), flexAncestors === 0);
      if (t.why) return unknown(t.why);
      const w = typeof pw === "number" ? Math.max(pw, t.min) : undefined;
      return w !== undefined ? { min: w, max: w } : { min: t.min, max: Math.max(t.min, Math.min(t.max, cap)) };
    }
    if (typeof pw === "number") {
      const w = Math.max(insX, Math.min(pw, cap));
      return { min: w, max: w };
    }
    // width: max-content or min-content: that content width, whatever the room.
    if (pw === "max-content" || pw === "min-content") {
      const it = intrinsic(n, c, slot, true);
      if (it.why) return it;
      const v = Math.max(insX, Math.min(cap, pw === "max-content" ? it.max : it.min));
      return { min: v, max: v };
    }
    // A form field or replaced element with a percentage width or max-width is compressible: its
    // min-content contribution is its padding and border; its max-content one, its intrinsic size, isn't known.
    if (!contentOnly && /^(input|select|textarea|img|svg|video|canvas|iframe|object|embed)$/.test(n.tag) && (typeof p.width?.value === "object" || p.width?.value === "fill" || typeof p.maxWidth?.value === "object"))
      return n.controlWidth !== undefined ? { min: insX, max: Math.max(insX, Math.min(cap, n.controlWidth + insX)) } : { min: insX, max: insX, why: `<${n.tag}> has an intrinsic size of its own`, minKnown: true };
    if (pw !== undefined && pw !== "fit") return unknown(`<${n.tag}> has a ${pw === "fill" ? "fill" : "percentage"} width, which depends on the box being sized`);
    if (p.aspect && !contentOnly) return unknown(`<${n.tag}> has an aspect ratio`);
    // Size containment (size or inline-size): as wide as if it were empty.
    if (p.contain?.value.size) return { min: insX, max: insX };
    let min = 0;
    let max = 0;
    let wraps = false;
    const isText = !!p.text && classedOf(n, c).length === 0;
    if (isText) {
      if (n.text) {
        const mt = text(n, p, "", []);
        if (!mt) return unknown(`the text of <${n.tag}> can't be measured`);
        const t = mt(Infinity);
        min = up(t.minContent);
        max = up(t.maxContent);
      }
    } else if (n.children.length) {
      // Absolutely positioned children don't size their parent.
      const kids = n.children.map((k) => ({ node: k, ...childOf(k, c, true) })).filter((k) => !k.comp || !outOfFlow(k.comp, k.slot));
      if (kids.some((k) => k.comp === null)) return unknown(`<${n.tag}> has children the engine doesn't lay out`);
      const pat = p.pattern?.value;
      if (!pat) return unknown(`<${n.tag}> has children but no layout`);
      if (pat === "grid" && fullGrid(p, kids as Kid[])) {
        const r = gridIntrinsic(p, kids as Kid[]);
        if ("why" in r) return unknown(r.why);
        return { min: Math.max(insX, Math.min(cap, up(r.min) + insX)), max: Math.max(insX, Math.min(cap, up(Math.max(r.max, r.min)) + insX)) };
      }
      if (pat === "grid") {
        // Explicit tracks: under a min-content constraint a minmax(0, <n>fr) column is 0 and an
        // <n>fr one its items' min-content width; at max-content every flexible column is its
        // share of the widest item per fr (CSS Grid §12.7.1, an indefinite free space).
        const ts = p.columns?.value;
        if (!ts || ts.some((t) => "size" in t && typeof t.size !== "number")) return unknown("a grid's width from its content isn't modelled (repeat(auto-fill), or a percentage column)");
        const n = ts.length;
        const cols = ts.map(() => ({ min: 0, max: 0 }));
        for (const [j, k] of kids.entries()) {
          const ki = intrinsic(k.node, k.comp!, k.slot);
          if (ki.why) return ki;
          const km = marginOf(resolveElement(model, k.comp!, k.slot, width));
          const c = cols[j % n];
          c.min = Math.max(c.min, ki.min + km.left + km.right);
          c.max = Math.max(c.max, ki.max + km.left + km.right);
        }
        const gaps = (p.gap?.value ?? 0) * (n - 1);
        const fraction = Math.max(0, ...ts.map((t, i) => ("fr" in t ? Math.max(t.auto ? cols[i].min : 0, cols[i].max) / Math.max(1, t.fr) : 0)));
        min = gaps + ts.reduce((s, t, i) => s + ("size" in t ? (t.size as number) : t.auto ? cols[i].min : 0), 0);
        max = gaps + ts.reduce((s, t, i) => s + ("size" in t ? (t.size as number) : Math.max(t.auto ? cols[i].min : 0, fraction * t.fr)), 0);
        return { min: Math.max(insX, Math.min(cap, up(min) + insX)), max: Math.max(insX, Math.min(cap, up(Math.max(max, min)) + insX)) };
      }
      let row = 0;
      let rowMin = 0;
      // Content whose min-content width alone is known (a compressible field): this box's is too.
      let partial: string | undefined;
      for (const k of kids) {
        const ki = intrinsic(k.node, k.comp!, k.slot);
        if (ki.why && !ki.minKnown) return ki;
        if (ki.why) partial ??= ki.why;
        const km = marginOf(resolveElement(model, k.comp!, k.slot, width));
        const mm = km.left + km.right;
        min = Math.max(min, ki.min + mm);
        if (pat === "cluster") {
          row += ki.max + mm;
          rowMin += ki.min + mm;
        } else max = Math.max(max, ki.max + mm);
        wraps ||= !!ki.wraps;
      }
      if (pat === "cluster") {
        const gaps = (p.gap?.value ?? 0) * (kids.length - 1);
        max = row + gaps;
        // One line: its min-content is every item's side by side.
        if (p.wrap?.value === false) min = rowMin + gaps;
        else wraps ||= kids.length > 1;
      }
      // A layer's one column is minmax(0, 1fr): under a min-content constraint it's 0 wide.
      if (pat === "layer") min = 0;
      if (partial) {
        const m = Math.max(insX, Math.min(cap, Math.max(0, min) + insX));
        return { min: m, max: m, why: partial, minKnown: true };
      }
    } else if (CONTROLS.has(n.tag) && n.controlWidth !== undefined) {
      // A form control of known intrinsic width (a select's widest option, a field's characters...).
      min = max = n.controlWidth;
    } else if (MEDIA.has(n.tag) || CONTROLS.has(n.tag)) return unknown(`<${n.tag}> has an intrinsic size of its own`);
    min = Math.max(0, min);
    max = Math.max(max, min);
    return { min: Math.max(insX, Math.min(cap, min + insX)), max: Math.max(insX, Math.min(cap, max + insX)), ...(wraps && { wraps }) };
  }

  /**
   * A cluster (a wrapping flex row): each item's flex base size (its width, or its max-content
   * width), lines broken on those, then per line Chromium's flexing (grow; a lone item too wide for
   * its line shrinks to it, down to its min-content width), auto margins and justify. Items are
   * laid out at their final widths.
   */
  function cluster(kids: { node: FixtureNode; comp: Component; slot: string | undefined }[], innerW: number, gap: number, justify: string, nowrap: boolean): Box[][] {
    const items = kids.map((k) => {
      const p0 = resolveElement(model, k.comp, k.slot, width);
      // Percentage padding and margins: of the flex container's width.
      const p = atBase(p0, innerW);
      const km: Margins = { ...marginOf(p) };
      const out = km.left + km.right;
      // (A table with collapsed borders: half its outer collapsed borders, and no padding.)
      const tg = p.pattern?.value === "table" ? gridOf(k.node, k.comp, p) : undefined;
      const kins = tg?.collapse ? insets({ border: { value: { color: "", widths: tableInsets(tg).border }, display: "", steps: [] } }) : insets(p);
      const insX = kins.left + kins.right;
      /** Errors, reported against the item's box once it's laid out (its id is known then). */
      const errors: { path: string; message: (id: string) => string }[] = [];
      const kpath = k.slot ? `${k.comp.path}.slots.${k.slot}` : k.comp.path;
      const notes: string[] = [];
      const cap = Math.min(p.maxWidth ? sizeAt(p.maxWidth.value, innerW) : Infinity, p.measure ? sizeAt(p.measure.value, innerW) : Infinity);
      // maxWidth is width: 100% (unless a width is set), the max-width, and auto inline margins,
      // which take the line's free space like any other auto margins.
      if (p.maxWidth) Object.assign(km, { autoLeft: true, autoRight: true });
      const pw = p.width?.value ?? (p.maxWidth ? "fill" : undefined);
      const g = p.grow?.value;
      let base = 0;
      let min = insX;
      // Its automatic minimum (min-width: auto) is known: content-sized, or grows from zero.
      let minKnown = false;
      let wraps = false;
      let intr: Intrinsic | undefined;
      // The content's own sizes: the item's max width (maybe a percentage of this line) is applied below.
      const content = () => (intr ??= withOwnPct(intrinsic(k.node, k.comp, k.slot, true), p0, p));
      const cannot = (why: string) => {
        errors.push({ path: kpath, message: (id) => (g?.basis === "zero" && pw !== undefined ? `#${id} grows from zero in a cluster, and the minimum width of its content can't be measured (${why})` : `#${id} sits in a cluster without a width, and its content can't be measured (${why}); ${say("give it a size token width", "give it a width in px or rem")}`) });
      };
      if (typeof pw === "number") base = pw;
      else if (pw !== undefined && typeof pw === "object") base = sizeAt(pw, innerW);
      else if (pw === "fill") {
        if (p.width) errors.push({ path: p.width.steps.at(-1)!.path, message: (id) => say(`#${id} has width: fill inside a cluster; fill only stretches inside a stack`, `#${id} is as wide as its flex row (width: 100%) next to other items`) });
        base = innerW;
      } else if (pw === "fit" || pw === "max-content" || pw === "min-content") {
        const it = content();
        if (it.why) cannot(it.why);
        else base = pw === "max-content" ? it.max : pw === "min-content" ? it.min : Math.min(it.max, Math.max(it.min, innerW - out));
      } else if (p.aspect) {
        // aspect compiles to width: 100%. With inline margins (or siblings, in a row that doesn't
        // wrap) the line is too full, and the item shrinks, but no narrower than its automatic
        // minimum: its min-content width, at most the 100%. That is measured for a text run only.
        base = innerW;
        const isText = !!p.text && classedOf(k.node, k.comp).length === 0;
        const it = isText && k.node.text ? content() : undefined;
        // (In a one-line cluster its minimum may also follow its stretched height: not modelled.)
        if (it && !it.why && !nowrap) {
          min = Math.max(insX, Math.min(innerW, it.min));
          minKnown = true;
        }
      } else if (!g || g.basis === "content") {
        // flex-basis: auto → max-content; an item too wide for its line shrinks, down to min-content.
        const it = content();
        if (it.why) cannot(it.why);
        else {
          base = it.max;
          min = it.min;
          minKnown = true;
          wraps = !!it.wraps;
        }
      }
      if (g && g.basis === "zero") {
        // flex-basis: 0, never below the automatic minimum: the content's min-content width, capped by a set width.
        const it = withOwnPct(intrinsic(k.node, k.comp, k.slot, true), p0, p);
        const specified = typeof pw === "number" ? pw : pw !== undefined && typeof pw === "object" ? sizeAt(pw, innerW) : pw === "fill" ? innerW : Infinity;
        if (it.why) cannot(it.why);
        else {
          min = Math.max(insX, Math.min(it.min, specified));
          minKnown = true;
        }
        base = insX;
      }
      // flex-shrink: 1 unless a width is set (Cadesa compiles flex: none with it); shrink sets it.
      const sized = typeof pw === "number" || (pw !== undefined && typeof pw === "object") || (pw === "fill" && !!p.width) || pw === "fit" || pw === "max-content" || pw === "min-content";
      const shrink = p.shrink?.value ?? (sized ? 0 : 1);
      // A box with a width that shrinks: its automatic minimum width is its content's min-content
      // width, at most that width (the specified size suggestion).
      if (sized && shrink > 0 && !(g && g.basis === "zero")) {
        const it = content();
        if (!it.why) {
          min = Math.max(insX, Math.min(it.min, base));
          minKnown = true;
        }
      }
      // A scroll container's automatic minimum width is 0: it shrinks below its content (which then scrolls or is clipped).
      // (A textarea is one too: it scrolls its text.)
      if (scrolls(p.overflow?.value) || k.node.tag === "textarea") {
        min = insX;
        minKnown = true;
      }
      min = Math.min(min, Math.max(cap, insX));
      // The flex base size is never below the padding and border (its content size is at least 0).
      base = Math.max(base, insX);
      // A table is never narrower than its columns' minimum, whatever its width or flex basis says.
      const tableMin = p.pattern?.value === "table" && !content().why ? content().min : 0;
      if (tableMin) {
        min = Math.max(min, tableMin);
        minKnown = true;
      }
      const hyp = Math.max(Math.min(base, cap), g?.basis === "zero" ? min : 0, insX, tableMin);
      // An aspect box that grows: its minimum width also follows its height, which isn't modelled.
      if (g && p.aspect) notes.push("grow on a box with an aspect ratio: its minimum width also follows its height, which isn't modelled");
      return { k, p, km, out, base, hyp, min, cap, insX, shrink, shrinkUnknown: shrink > 0 && !minKnown, wraps, intr, factor: g?.factor ?? 0, notes, errors };
    });

    type Item = (typeof items)[number];
    const lines: Item[][] = [];
    let line: Item[] = [];
    let lineW = 0;
    for (const it of items) {
      const outer = it.hyp + it.out;
      const needed = line.length ? lineW + gap + outer : outer;
      if (line.length && needed > innerW + EPS && !nowrap) {
        lines.push(line);
        line = [];
      }
      lineW = line.length ? lineW + gap + outer : outer;
      line.push(it);
    }
    if (line.length) lines.push(line);

    return lines.map((ln) => {
      const n = ln.length;
      const flexed = flexLine(
        ln.map((it) => ({ base: U(it.base), hyp: U(it.hyp), factor: it.factor, shrink: it.shrink, pad: U(it.insX), min: U(it.min), max: it.cap === Infinity ? Infinity : U(it.cap), out: U(it.out) })),
        U(innerW),
        U(gap),
      );
      const sizes = flexed ? flexed.map(PX) : ln.map((it) => it.hyp);
      ln.forEach((it, i) => {
        if (it.shrinkUnknown && sizes[i] < it.hyp - EPS) it.notes.push(`it shrinks in its row, down to a minimum width the engine doesn't measure (${it.p.aspect ? "an aspect ratio" : "its content's min-content width"})`);
      });
      ln.forEach((it, i) => {
        if (it.wraps && it.intr && sizes[i] < it.intr.max - EPS) it.notes.push("its width comes from its content, and a row inside it wraps there: the browser sizes it from the wrapped lines");
      });
      // Items wanted more than the line (they shrank, or would if they could).
      const overfull = ln.reduce((t, it) => t + it.hyp + it.out, 0) + gap * (n - 1) > innerW + EPS;
      let free = U(innerW) - ln.reduce((t, it, i) => t + U(sizes[i]) + U(it.out), 0) - U(gap) * (n - 1);
      const autos = ln.reduce((t, it) => t + (it.km.autoLeft ? 1 : 0) + (it.km.autoRight ? 1 : 0), 0);
      // Auto margins take the free space first (justify then has none to place).
      const auto = autos && free > 0 ? diffuser(free, autos) : () => 0;
      if (autos && free > 0) free = 0;
      let offset = 0;
      let between = () => 0;
      if (justify === "end") offset = free;
      else if (justify === "center") offset = Math.trunc(free / 2);
      else if (justify !== "start") {
        const buckets = justify === "between" ? n - 1 : justify === "evenly" ? n + 1 : n;
        if (free > 0) {
          offset = justify === "between" ? 0 : Math.trunc(free / (justify === "around" ? 2 * n : n + 1));
          if (n > 1) between = diffuser(free, buckets);
        } else if (justify !== "between") offset = Math.max(0, Math.trunc(free / 2));
      }
      let x = offset;
      return ln.map((it, i) => {
        const b = measure(it.k.node, it.k.comp, it.k.slot, innerW, "cluster", sizes[i]);
        b.assumptions.push(...it.notes);
        if (overfull) b.overfull = true;
        for (const e of it.errors) issues.push({ severity: "error", id: b.id, path: e.path, message: e.message(b.id) });
        const al = it.km.autoLeft ? auto() : 0;
        const ar = it.km.autoRight ? auto() : 0;
        b.x = PX(x + al + U(it.km.left));
        x += al + U(it.km.left) + U(sizes[i]) + U(it.km.right) + ar + U(gap) + between();
        return b;
      });
    });
  }

  /**
   * repeat(auto-fill, minmax(min, 1fr)): as many columns as fit at `min` (Chromium counts a track
   * under 1px as 1px, so a 0 minimum gives one column per px rather than infinitely many), the 1fr
   * columns sharing the space in layout units: column i ends at floor((i + 1) × share).
   */
  function autoFill(min: number, innerW: number, gap: number): { colW: number[]; colX: number[] } {
    const cols = Math.min(10000, Math.max(1, Math.floor((innerW + gap + EPS) / (Math.max(min, 1) + gap))));
    const share = Math.round((innerW - gap * (cols - 1)) * 64) / cols;
    const edge = (i: number) => Math.floor(i * share + 1e-6);
    const colW = Array.from({ length: cols }, (_, i) => (cols === 1 ? innerW : (edge(i + 1) - edge(i)) / 64));
    const colX = colW.map((_, i) => (cols === 1 ? 0 : edge(i) / 64 + i * gap));
    return { colW, colX };
  }

  /**
   * Explicit column tracks (grid-template-columns), items auto-placed one per cell, row by row. Fixed
   * tracks take their size; flexible ones share what is left (CSS Grid §12.7 "find the size of an
   * fr"): a `<n>fr` track (auto minimum) never goes below its items' min-content width, and one
   * that would is sized to it while the rest share again. The shares are cut in layout units, each
   * flexible track ending at floor(its cumulative fraction × the space).
   */
  function tracks(ts: Track[], kids: { node: FixtureNode; comp: Component; slot: string | undefined }[], innerW: number, gap: number, notes: string[]): { colW: number[]; colX: number[] } {
    const n = ts.length;
    const base = ts.map(() => 0);
    ts.forEach((t, i) => {
      if (!("fr" in t) || !t.auto) return;
      for (let j = i; j < kids.length; j += n) {
        const k = kids[j];
        const kp = resolveElement(model, k.comp, k.slot, width);
        // A scroll container's automatic minimum is 0.
        if (scrolls(kp.overflow?.value)) continue;
        // A table's contribution to a grid column isn't its min-content width in Chromium (not modelled).
        if (kp.pattern?.value === "table") notes.push("a table's minimum contribution to a grid column isn't modelled");
        const it = intrinsic(k.node, k.comp, k.slot);
        if (it.why && !it.minKnown) {
          notes.push(`a ${t.fr}fr column is at least as wide as its items' min-content width, which can't be measured here (${it.why})`);
          continue;
        }
        const km = marginOf(kp);
        base[i] = Math.max(base[i], it.min + km.left + km.right);
      }
    });
    const size: number[] = ts.map((t) => ("size" in t ? U(sizeAt(t.size, innerW)) : 0));
    const space = U(innerW) - U(gap) * (n - 1);
    const flexible = new Set(ts.flatMap((t, i) => ("fr" in t ? [i] : [])));
    let leftover = 0;
    let sumFr = 0;
    for (;;) {
      leftover = space - size.reduce((s, x, i) => s + (flexible.has(i) ? 0 : x), 0);
      sumFr = [...flexible].reduce((s, i) => s + (ts[i] as { fr: number }).fr, 0);
      const fr = leftover / Math.max(1, sumFr);
      const frozen = [...flexible].filter((i) => U(base[i]) > fr * (ts[i] as { fr: number }).fr + 1e-6);
      if (!frozen.length) break;
      for (const i of frozen) {
        flexible.delete(i);
        size[i] = U(base[i]);
      }
    }
    let acc = 0;
    let prev = 0;
    for (const i of [...flexible].sort((a, b) => a - b)) {
      const f = (ts[i] as { fr: number }).fr;
      acc += f;
      const edge = sumFr >= 1 ? Math.floor((acc / sumFr) * Math.max(0, leftover) + 1e-6) : Math.floor(acc * Math.max(0, leftover) + 1e-6);
      size[i] = Math.max(U(base[i]), edge - prev);
      prev = edge;
    }
    const colW = size.map(PX);
    const colX: number[] = [];
    let x = 0;
    for (const w of colW) {
      colX.push(x);
      x += w + gap;
    }
    return { colW, colX };
  }

  // ---- grids with a template, placed items or auto margins (CSS Grid's own algorithm, in grid.ts)

  type Kid = { node: FixtureNode; comp: Component; slot: string | undefined };
  /** A grid laid out by templateGrid: places its items again once its height is final. */
  const gridArrange = new WeakMap<Box, (contentH: number) => void>();

  /** Whether a grid needs CSS Grid's full algorithm (a template, placed items, auto margins on an item). */
  const fullGrid = (p: ResolvedProps, kids: Kid[]) =>
    !!p.grid ||
    p.rowGap?.pct !== undefined ||
    kids.some((k) => {
      const kp = resolveElement(model, k.comp, k.slot, width);
      const m = marginOf(kp);
      return !!kp.place || m.autoLeft || m.autoRight || m.autoTop || m.autoBottom;
    });

  /** The template of a grid, its items' placements and the explicit grid (old-style columns and min as track lists too). */
  function gridSetup(p: ResolvedProps, kids: Kid[], innerW: number | undefined, colGap: number, rowGap: number, innerH: number | undefined, sub?: { widths: number[] } | { span: number }) {
    const spec: GridSpec = p.grid?.value ?? { autoColumns: [{ min: "auto", max: "auto" }], autoRows: [{ min: "auto", max: "auto" }], dense: false, justifyContent: "normal", alignContent: "normal" };
    let columns: TrackList | undefined = spec.columns;
    // A subgrid's columns: the ones it spans in its parent (their widths once the parent sized them).
    if (spec.subgridColumns && sub) {
      const tracks: TrackSize[] = "widths" in sub ? sub.widths.map((w) => ({ min: { len: w }, max: { len: w } })) : Array.from({ length: sub.span }, () => ({ min: "auto" as const, max: "auto" as const }));
      columns = { tracks, names: tracks.map(() => []).concat([[]]) };
    }
    if (!columns && p.columns) {
      const tracks: TrackSize[] = p.columns.value.map((t) => ("size" in t ? { min: { len: t.size }, max: { len: t.size } } : { min: t.auto ? "auto" : { len: 0 }, max: { fr: t.fr } }));
      columns = { tracks, names: tracks.map(() => []).concat([[]]) };
    } else if (!columns && p.min) {
      const min = Math.min(p.min.value, innerW ?? p.min.value);
      columns = { tracks: [], names: [[], []], repeat: { type: "auto-fill", at: 0, tracks: [{ min: { len: min }, max: { fr: 1 } }], names: [[], []] } };
    }
    const cols = columns ? expandTracks(columns, innerW, colGap) : { tracks: [], names: [[]] };
    const rowsT = spec.rows ? expandTracks(spec.rows, innerH, rowGap) : { tracks: [], names: [[]] };
    const areas = spec.areas;
    const ex: Explicit = {
      cols: Math.max(cols.tracks.length, areas?.cols ?? 0),
      rows: Math.max(rowsT.tracks.length, areas?.rows ?? 0),
      colNames: cols.names,
      rowNames: rowsT.names,
      ...(areas && { areas: areas.areas }),
    };
    const places = kids.map((k) => resolveElement(model, k.comp, k.slot, width).place?.value);
    const auto = { start: { auto: true as const }, end: { auto: true as const } };
    const placed = gridPlace(ex, places.map((pl) => ({ row: pl?.row ?? auto, column: pl?.column ?? auto })), spec.dense, !!spec.column);
    return { spec, cols, rowsT, ex, places, placed };
  }

  /** The track list of one axis: implicit tracks before, the explicit ones, implicit tracks after (grid-auto-*, cycled). */
  const axisTracks = (explicit: TrackSize[], count: number, offset: number, auto: TrackSize[]) =>
    Array.from({ length: count }, (_, i) => {
      const e = i - offset;
      if (e >= 0 && e < explicit.length) return explicit[e];
      const k = e < 0 ? ((e % auto.length) + auto.length) % auto.length : (e - explicit.length) % auto.length;
      return auto[k] ?? { min: "auto" as const, max: "auto" as const };
    });

  /** An item's column contributions (outer: margins in; percentages of the grid area count as 0 here). */
  function colContribution(k: Kid, a: number, b: number): Contribution & { why?: string; minOnly?: boolean } {
    const kp = resolveElement(model, k.comp, k.slot, width);
    const m = marginOf(kp);
    const it = intrinsic(k.node, k.comp, k.slot);
    if (it.why && !it.minKnown) return { a, b, minContent: 0, maxContent: 0, minimum: 0, why: it.why };
    const ins = insets(kp);
    const mx = m.left + m.right;
    // A scroll container's automatic minimum width is 0 (its padding and border remain).
    const minimum = scrolls(kp.overflow?.value) ? ins.left + ins.right : it.min;
    return { a, b, minContent: it.min + mx, maxContent: it.max + mx, minimum: minimum + mx, minimumSpanningFlex: ins.left + ins.right + mx, ...(it.why && { why: it.why, minOnly: true }) };
  }

  /** Subgrids' column widths, set by their parent grid before it lays them out. */
  const subgridCols = new WeakMap<FixtureNode, { widths: number[]; gap: number }>();

  /**
   * A subgrid's inline edges and gap (CSS Grid §9.6): its margin, border and padding on each side
   * (an extra margin for its items at that edge), and its own column gap (half the difference from
   * its parent's on each side of a gutter inside it). undefined where they aren't lengths.
   */
  function subgridEdges(kp: ResolvedProps, parentGap: number): { start: number; end: number; gap: number } | undefined {
    const ins = insets(kp);
    const m = marginOf(kp);
    if (m.autoLeft || m.autoRight || kp.padding?.pct?.left !== undefined || kp.padding?.pct?.right !== undefined || kp.margin?.pct?.left !== undefined || kp.margin?.pct?.right !== undefined || kp.gap?.pct !== undefined) return undefined;
    const own = kp.gap !== undefined && kp.gap.display !== "0px (no gap)";
    return { start: m.left + ins.left, end: m.right + ins.right, gap: own ? kp.gap!.value : parentGap };
  }

  /**
   * The column contributions of a grid's items: a subgrid's own items contribute to the parent's
   * columns they are in, with its edges and the half gap differences as extra margins (subgridEdges).
   */
  function gridColItems(kids: Kid[], areas: { c0: number; c1: number }[], colGap: number): (Contribution & { why?: string; minOnly?: boolean })[] {
    return kids.flatMap((k, i) => {
      const a = areas[i];
      const kp = resolveElement(model, k.comp, k.slot, width);
      if (!kp.grid?.value.subgridColumns) return [colContribution(k, a.c0, a.c1)];
      const subKids = k.node.children.map((n) => ({ node: n, ...childOf(n, k.comp, true) })).filter((x) => x.comp !== null) as Kid[];
      const e = subgridEdges(kp, colGap);
      if (!e) return [{ a: a.c0, b: a.c1, minContent: 0, maxContent: 0, minimum: 0, why: "a subgrid with inline padding or margins in percentages, or auto margins, isn't modelled" }];
      const g = gridSetup(kp, subKids, undefined, e.gap, 0, undefined, { span: a.c1 - a.c0 });
      if ("why" in g.placed) return [{ a: a.c0, b: a.c1, minContent: 0, maxContent: 0, minimum: 0, why: g.placed.why }];
      if (g.placed.cols > a.c1 - a.c0 || g.placed.colOffset) return [{ a: a.c0, b: a.c1, minContent: 0, maxContent: 0, minimum: 0, why: "a subgrid's items past the columns it spans aren't modelled" }];
      const placed = g.placed;
      const n = a.c1 - a.c0;
      const half = (e.gap - colGap) / 2;
      const extraOf = (c0: number, c1: number) => (c0 === 0 ? e.start : half) + (c1 === n ? e.end : half);
      const items = subKids.map((sk, j) => {
        const { c0, c1 } = placed.areas[j];
        const c = colContribution(sk, a.c0 + c0, a.c0 + c1);
        const extra = extraOf(c0, c1);
        return extra ? { ...c, minContent: c.minContent + extra, maxContent: c.maxContent + extra, minimum: c.minimum + extra } : c;
      });
      // A track of the subgrid no item is in still takes the subgrid's edge at either end (not a gap's difference, as Chromium sizes it).
      for (let j = 0; j < n; j++) {
        const extra = (j === 0 ? e.start : 0) + (j === n - 1 ? e.end : 0);
        if (extra > 0 && !placed.areas.some((ar) => ar.c0 <= j && j < ar.c1)) items.push({ a: a.c0 + j, b: a.c0 + j + 1, minContent: extra, maxContent: extra, minimum: extra });
      }
      return items;
    });
  }

  /** A grid's own min-content and max-content widths (its columns sized under that constraint). */
  function gridIntrinsic(p: ResolvedProps, kids: Kid[]): { min: number; max: number } | { why: string } {
    const gap = p.gap?.pct !== undefined ? 0 : (p.gap?.value ?? 0);
    // (Auto-filled columns of min(<min>, 100%): a percentage of a size being found; not modelled.)
    if (p.min) return { why: "a grid's width from its content isn't modelled (repeat(auto-fill))" };
    const g = gridSetup(p, kids, undefined, gap, 0, undefined);
    if ("why" in g.placed) return { why: g.placed.why };
    const { placed, spec } = g;
    const tracks = axisTracks(g.cols.tracks, placed.cols, placed.colOffset, spec.autoColumns);
    const items = gridColItems(kids, placed.areas, gap);
    const bad = items.find((it) => it.why && tracks.slice(it.a, it.b).some((t) => !(typeof t.min === "object" && "len" in t.min && typeof t.max === "object" && "len" in t.max)));
    if (bad) return { why: bad.why! };
    const sum = (s: number[]) => s.reduce((t, x) => t + x, 0) + gap * Math.max(0, s.length - 1);
    return { min: sum(sizeTracks(tracks, items, gap, "min-content", false)), max: sum(sizeTracks(tracks, items, gap, "max-content", false)) };
  }

  /**
   * A grid by CSS Grid's algorithm: items placed (template, lines, areas, auto-placement), columns
   * sized from the items' widths, items laid out in their columns, rows sized from their heights,
   * then each item aligned in its area (stretched, or start, center or end; auto margins). The rows
   * are sized again once the grid's height is final (gridArrange).
   */
  function templateGrid(box: { props: ResolvedProps; node?: FixtureNode }, kids: Kid[], innerW: number, colGap: number, notes: string[]): { boxes: Box[]; contentH: number; arrange: (contentH: number) => void } {
    const p = box.props;
    // A subgrid laid out in its parent: the parent's column widths and gap.
    const sub = p.grid?.value.subgridColumns ? (box.node && subgridCols.get(box.node)) : undefined;
    if (p.grid?.value.subgridColumns && !sub) notes.push("a subgrid outside a grid that sizes its columns isn't modelled");
    const rowGapPct = p.rowGap?.pct;
    // (A subgrid's own row gap: its rows aren't the parent's.)
    const rowGap = rowGapPct !== undefined ? 0 : (p.rowGap?.value ?? (p.gap?.pct !== undefined ? 0 : colGap));
    if (sub) colGap = sub.gap;
    const innerH = p.height ? Math.max(0, p.height.value - insets(p).top - insets(p).bottom) : undefined;
    let g = gridSetup(p, kids, innerW, colGap, rowGap, innerH, sub ? { widths: sub.widths } : undefined);
    if ("why" in g.placed) {
      notes.push(`its grid placement isn't modelled (${g.placed.why})`);
      const auto = { start: { auto: true as const }, end: { auto: true as const } };
      g = { ...g, placed: gridPlace(g.ex, kids.map(() => ({ row: auto, column: auto })), g.spec.dense, !!g.spec.column) };
    }
    const placed = g.placed as Exclude<typeof g.placed, { why: string }>;
    const { spec } = g;
    // auto-fit: repeated tracks no item is in collapse (they and their gaps take no space).
    let colTracks = axisTracks(g.cols.tracks, placed.cols, placed.colOffset, spec.autoColumns);
    let areas = placed.areas.map((a) => ({ ...a }));
    if (g.cols.autoFit) {
      const fit = new Set(g.cols.autoFit.map((i) => i + placed.colOffset));
      const empty = new Set([...fit].filter((i) => !areas.some((a) => a.c0 <= i && i < a.c1)));
      if (empty.size) {
        const keep = colTracks.map((_, i) => !empty.has(i));
        const idx = (line: number) => keep.slice(0, line).filter(Boolean).length;
        areas = areas.map((a) => ({ ...a, c0: idx(a.c0), c1: idx(a.c1) }));
        colTracks = colTracks.filter((_, i) => keep[i]);
      }
    }
    const rowTracks = axisTracks(g.rowsT.tracks, placed.rows, placed.rowOffset, spec.autoRows);
    if (p.min && colTracks.length > g.cols.tracks.length) notes.push("items placed past auto-filled columns (in implicit columns) aren't modelled");
    const fixed = (t: TrackSize) => typeof t.min === "object" && "len" in t.min && typeof t.max === "object" && "len" in t.max;

    // Columns.
    const colItems = gridColItems(kids, areas, colGap);
    colItems.forEach((it) => {
      // (An item whose min-content width alone is known only matters to tracks sized up to its max-content.)
      const needsMax = (t: TrackSize) => t.max === "auto" || t.max === "max-content" || t.fit !== undefined;
      if (it.why && colTracks.slice(it.a, it.b).some((t) => (it.minOnly ? needsMax(t) : !fixed(t) && !(typeof t.max === "object" && "fr" in t.max && typeof t.min === "object" && "len" in t.min))))
        notes.push(`a grid column sized by its items is as wide as their content, which can't be measured here (${it.why})`);
    });
    const colW = sizeTracks(colTracks, colItems, colGap, innerW, /^(normal|stretch)$/.test(spec.justifyContent));
    const colX = trackStarts(colW, colGap, innerW, spec.justifyContent);
    // Columns that overflow the grid while an item spans a flexible one: how Chromium shares them out then isn't pinned down.
    const colSum = colW.reduce((s, x) => s + x, 0) + colGap * Math.max(0, colW.length - 1);
    if (colSum > innerW + EPS && colItems.some((it) => it.b - it.a > 1 && colTracks.slice(it.a, it.b).some((t) => typeof t.max === "object" && "fr" in t.max))) notes.push("grid columns wider than the grid, with an item spanning a flexible one: not modelled");
    const span = (x: number[], w: number[], a: number, b: number) => x[b - 1] + w[b - 1] - x[a];

    // Items at their area's width (stretched, or fit-content when aligned or with auto inline margins).
    const justify = (i: number) => g.places[i]?.justify ?? p.justifyItems?.value ?? "stretch";
    const boxes = kids.map((k, i) => {
      const a = areas[i];
      const cw = span(colX, colW, a.c0, a.c1);
      const rk = resolveElement(model, k.comp, k.slot, width);
      // A subgrid's columns: the ones it spans, less its edges at either end and half its gap's
      // difference from this one's at each gutter inside it.
      const se = rk.grid?.value.subgridColumns ? subgridEdges(rk, colGap) : undefined;
      if (se) {
        const n = a.c1 - a.c0;
        const half = (se.gap - colGap) / 2;
        subgridCols.set(k.node, { widths: colW.slice(a.c0, a.c1).map((w, j) => Math.max(0, w - (j === 0 ? se.start : half) - (j === n - 1 ? se.end : half))), gap: se.gap });
      }
      const kp = atBase(resolveElement(model, k.comp, k.slot, width), cw);
      const km = marginOf(kp);
      const j = justify(i);
      const own = kp.width?.value !== undefined && kp.width.value !== "fit";
      let b: Box;
      // Stretched; or width: 100% (an aspect ratio, a maxWidth: compiled so); or a width of its own.
      if ((j === "stretch" && !km.autoLeft && !km.autoRight) || kp.aspect || own || kp.maxWidth) b = measure(k.node, k.comp, k.slot, cw, "grid");
      else {
        const raw = resolveElement(model, k.comp, k.slot, width);
        const it = withOwnPct(intrinsic(k.node, k.comp, k.slot, true), raw, kp);
        if (it.why) {
          b = measure(k.node, k.comp, k.slot, cw, "grid");
          b.assumptions.push(`it is as wide as its content in its grid area, which can't be measured (${it.why})`);
        } else {
          const cap = kp.measure ? sizeAt(kp.measure.value, cw) : Infinity;
          const ins = insets(kp);
          b = measure(k.node, k.comp, k.slot, cw, "grid", Math.max(ins.left + ins.right, Math.min(cap, it.max, Math.max(it.min, cw - km.left - km.right))));
          if (it.wraps && b.w < it.max - EPS) b.assumptions.push("its width comes from its content, and a row inside it wraps there: the browser sizes it from the wrapped lines");
        }
      }
      // Across its area: auto margins, else justify-self.
      const m = marginOf(b.props);
      const free = U(cw) - U(b.w) - U(m.left) - U(m.right);
      // (maxWidth is centered by auto inline margins.)
      const autos = b.props.maxWidth && !m.left && !m.right ? 2 : (m.autoLeft ? 1 : 0) + (m.autoRight ? 1 : 0);
      const off = autos ? (free > 0 ? (autos === 2 ? Math.trunc(free / 2) : m.autoLeft ? free : 0) : 0) : j === "center" ? Math.trunc(free / 2) : j === "end" ? free : 0;
      b.x = colX[a.c0] + m.left + PX(off);
      return b;
    });
    // The natural (content) heights the rows are sized from.
    const natural = boxes.map((b) => b.h);
    const rowItems = (): Contribution[] =>
      boxes.map((b, i) => {
        const m = marginOf(b.props);
        const iy = insets(b.props);
        const h = natural[i] + m.top + m.bottom;
        return { a: areas[i].r0, b: areas[i].r1, minContent: h, maxContent: h, minimum: scrolls(b.props.overflow?.value) && !b.props.height ? iy.top + iy.bottom + m.top + m.bottom : h };
      });
    const stretchRows = /^(normal|stretch)$/.test(spec.alignContent);
    const sizeRows = (avail: number | undefined) => sizeTracks(rowTracks, rowItems(), rowGap, avail ?? "max-content", stretchRows);
    let rowH = sizeRows(innerH);
    const sum = (s: number[], gap: number) => s.reduce((t, x) => t + x, 0) + gap * Math.max(0, s.length - 1);
    const contentH = sum(rowH, rowGap);
    const alignOf = (i: number) => g.places[i]?.align ?? p.align?.value ?? "stretch";

    const arrangeAt = (finalH: number) => {
      // A taller grid (a set or stretched height, a min-height): its rows are sized for it.
      if (innerH === undefined && finalH > contentH + EPS) {
        rowH = sizeRows(finalH);
        // A percentage row gap of a grid stretched past its content, or held up by a min-height, between rows: not modelled.
        if (rowGapPct !== undefined && rowH.length > 1 && !notes.some((x) => x.startsWith("a percentage row gap"))) notes.push("a percentage row gap of a grid whose height is stretched or set by a min-height is not modelled");
      }
      const gap = rowGapPct !== undefined ? sizeAt({ pct: rowGapPct }, Math.max(0, finalH)) : rowGap;
      const rowY = trackStarts(rowH, gap, finalH, spec.alignContent);
      boxes.forEach((b, i) => {
        const a = areas[i];
        const areaH = rowY[a.r1 - 1] + rowH[a.r1 - 1] - rowY[a.r0];
        const m = marginOf(b.props);
        const al = alignOf(i);
        if (m.autoTop || m.autoBottom) {
          const space = Math.max(0, U(areaH) - U(outerH(b)));
          b.y = rowY[a.r0] + m.top + PX(m.autoTop && m.autoBottom ? Math.trunc(space / 2) : m.autoTop ? space : 0);
          return;
        }
        // (An item with an aspect ratio stretches too, as in the other grids.)
        if (al === "stretch" && !b.props.height) {
          const target = areaH - m.top - m.bottom;
          // In tracks with no auto minimum an item may be stretched shorter than its content (which overflows).
          const autoMin = rowTracks.slice(a.r0, a.r1).some((t) => t.min === "auto");
          if (target < b.h && !autoMin) {
            b.h = Math.max(target, insets(b.props).top + insets(b.props).bottom);
            arrange(b);
          } else grow(b, target);
          fillPct(b);
        }
        const space = U(areaH) - U(outerH(b));
        b.y = rowY[a.r0] + m.top + PX(al === "center" ? Math.trunc(space / 2) : al === "end" ? space : 0);
      });
    };
    return { boxes, contentH, arrange: arrangeAt };
  }

  /**
   * Absolute and fixed boxes, once every box is in place (page coordinates): the containing block
   * is the padding box of the nearest positioned ancestor (fixed, or none: the window). Offsets in
   * px or a percentage of it; a width from left and right, else its own, else shrink-to-fit; a
   * height from top and bottom, else its own or its content's. With no offset on an axis it sits
   * at its static position (see measure: below the in-flow boxes before it in block flow, at the
   * start of a flexbox, at the padding box corner of a grid).
   */
  function placeAbsolute(parentOf: Map<Box, Box>, pageX: number, pageY: number) {
    while (absQueue.length) {
      const a = absQueue.shift()!;
      const p0 = resolveElement(model, a.k.comp, a.k.slot, width);
      const pos = p0.position!.value;
      let cbBox: Box | undefined;
      for (let x = a.parent; x; x = parentOf.get(x))
        if (containingBlock(x, pos.type)) {
          cbBox = x;
          break;
        }
      const bw = (b: Box) => b.props.border?.value.widths ?? { top: 0, right: 0, bottom: 0, left: 0 };
      const cb = cbBox ? { x: cbBox.x + bw(cbBox).left, y: cbBox.y + bw(cbBox).top, w: cbBox.w - bw(cbBox).left - bw(cbBox).right, h: cbBox.h - bw(cbBox).top - bw(cbBox).bottom } : { x: 0, y: 0, w: layoutW, h: windowH };
      const at = (v: number | { pct: number } | undefined, base: number) => (v === undefined ? undefined : sizeAt(v, base));
      const [l, r, t, b] = [at(pos.left, cb.w), at(pos.right, cb.w), at(pos.top, cb.h), at(pos.bottom, cb.h)];
      // Percentage padding and margins: of the containing block's width.
      const p = atBase(p0, cb.w);
      const m = marginOf(p);
      const ins = insets(p);
      const notes: string[] = [];
      // Width.
      const pw = p.width?.value;
      const cap = p.maxWidth ? sizeAt(p.maxWidth.value, cb.w) : p.measure ? sizeAt(p.measure.value, cb.w) : Infinity;
      let w: number;
      if (typeof pw === "number" || (pw !== undefined && typeof pw === "object")) w = sizeAt(pw, cb.w);
      else if (pw === "fill") w = cb.w;
      else if (l !== undefined && r !== undefined && pw === undefined) w = cb.w - l - r - m.left - m.right;
      else {
        const avail = pw === "max-content" ? Infinity : pw === "min-content" ? 0 : cb.w - (l ?? 0) - (r ?? 0) - m.left - m.right;
        const it = withOwnPct(intrinsic(a.k.node, a.k.comp, a.k.slot, true), p0, p);
        if (it.why) {
          notes.push(`an absolutely positioned box is as wide as its content, which can't be measured here (${it.why})`);
          w = Math.max(0, avail);
        } else w = Math.min(it.max, Math.max(it.min, avail));
      }
      w = Math.max(ins.left + ins.right, Math.min(w, cap));
      if (p.aspect) notes.push("an absolutely positioned box with an aspect ratio isn't modelled");
      const box = measure(a.k.node, a.k.comp, a.k.slot, w, "abs", w, undefined, cb.w);
      box.assumptions.push(...notes);
      // Height: a percentage of the containing block's, or stretched between top and bottom when it has none of its own.
      if (pos.height !== undefined && !p.height) {
        box.h = Math.max(ins.top + ins.bottom, sizeAt(pos.height, cb.h));
        arrange(box);
      } else if (!p.height && !p.aspect && t !== undefined && b !== undefined) {
        const target = Math.max(ins.top + ins.bottom, cb.h - t - b - m.top - m.bottom);
        if (target > box.h) grow(box, target);
        else if (target < box.h) {
          box.h = target;
          arrange(box);
        }
      }
      // Position: by its offsets, else where it would be in flow.
      const parent = a.parent;
      const pin = parent ? insets(parent.props) : undefined;
      const sx = (parent ? parent.x + pin!.left : pageX) + (a.at?.x ?? 0);
      const sy = (parent ? parent.y + pin!.top : pageY) + (a.at?.y ?? 0);
      const staticOk = !!a.at;
      let staticPos = false;
      const x = l !== undefined ? cb.x + l + m.left : r !== undefined ? cb.x + cb.w - r - box.w - m.right : ((staticPos = true), sx + m.left);
      const y = t !== undefined ? cb.y + t + m.top : b !== undefined ? cb.y + cb.h - b - box.h - m.bottom : ((staticPos = true), sy + m.top);
      if (staticPos && !staticOk) box.assumptions.push("an absolutely positioned box without offsets sits where it would be in flow, which isn't modelled here (after content the engine doesn't lay out, after empty blocks whose margins collapse through the parent, or aligned in a flex row or grid)");
      box.x = 0;
      box.y = 0;
      place(box, x, y, cb.w, cb.h);
      const home = parent ?? undefined;
      if (home) {
        home.children.push(box);
        parentOf.set(box, home);
      } else boxes.push(box);
      for (const d of walk([box])) for (const k of d.children) parentOf.set(k, d);
      absInfo.set(box, { cb: cbBox, parent, staticPos });
    }
  }

  function measure(
    n: FixtureNode,
    c: Component,
    slot: string | undefined,
    avail: number,
    parent: ParentKind,
    forcedW?: number,
    over?: Partial<ResolvedProps>,
    cbW?: number,
    stackAlign?: "start" | "center" | "end" | "stretch",
    bars?: { x: boolean; y: boolean },
    bfc?: Bfc,
  ): Box {
    // (What a pass leaves behind, undone when the box is laid out again with its scrollbars.)
    const undo = { auto, issues: issues.length, abs: absQueue.length, ex: bfc?.ex.mark() };
    const id = idOf(n);
    let rawProps = resolveElement(model, c, slot, width);
    // A table cell's border as its table lays it out (table.ts); a collapsed table's own border and padding.
    if (over) rawProps = { ...rawProps, ...over };
    // Percentage padding and margins: of the containing block's width.
    const pctProps = atBase(rawProps, cbW ?? avail);
    let props = pctProps;
    const grid = props.pattern?.value === "table" ? gridOf(n, c, props) : undefined;
    if (grid?.collapse) {
      const t = tableInsets(grid);
      props = { ...props, padding: undefined, border: props.border || Object.values(t.border).some(Boolean) ? { value: { color: props.border?.value.color ?? "transparent", widths: t.border }, display: "collapsed", steps: props.border?.steps ?? [] } : undefined };
    }
    const sourcePath = slot ? `${c.path}.slots.${slot}` : c.path;
    const assumptions: string[] = [];
    // Classic scrollbars: overflow: scroll always shows one; auto shows one when its content
    // overflows on that axis, found once its content is laid out (then it is laid out again with it).
    const ovs = props.overflow?.value;
    // Inside a box laid out again for its scrollbars, a scroll container keeps the ones it had.
    const kept = !bars && SB && ovs ? frozen?.get(n) : undefined;
    const barX = SB && (ovs?.x === "scroll" || (bars ?? kept)?.x) ? SB : 0;
    const barY = SB && (ovs?.y === "scroll" || (bars ?? kept)?.y) ? SB : 0;
    if (barX || barY) props = { ...props, scrollbar: { value: { x: barX, y: barY }, display: `${SB}px`, steps: props.overflow!.steps } };
    const ins = insets(props);
    const insX = ins.left + ins.right;
    const insY = ins.top + ins.bottom;

    const classed = classedOf(n, c);
    // Floats among a text box's text: boxes of their own, placed on the lines where they occur.
    const textFloats = textFloatsOf(n, c, props);
    const isText = !!props.text && (classed.length === 0 || textFloats.length > 0);
    const measureText = isText && n.text ? text(n, props, id, assumptions) : undefined;

    const m = marginOf(props);
    if (props.maxWidth && (m.left || m.right || m.autoLeft || m.autoRight))
      issues.push({
        severity: "error",
        id,
        path: props.margin!.steps.at(-1)!.path,
        message: say(`#${id} has maxWidth (centered by auto inline margins) and a left or right margin; keep one of them`, `#${id} has a max-width centered by auto margins and a left or right margin, which Cadesa doesn't combine`),
      });
    if (parent === "layer" && (m.autoLeft || m.autoRight))
      issues.push({ severity: "error", id, path: props.margin!.steps.at(-1)!.path, message: `#${id} has an auto margin in a ${parent}; auto margins are modelled in block flow, stacks and clusters` });

    // ---- width
    let w: number;
    const pw = props.width?.value;
    const maxW = Math.min(props.maxWidth ? sizeAt(props.maxWidth.value, avail) : Infinity, props.measure ? sizeAt(props.measure.value, avail) : Infinity);
    /** fit-content in `room`: the content's max-content width, at most the room, at least its min-content. */
    let fromContent = false;
    const fit = (room: number, what: string): number => {
      fromContent = true;
      // (Only the percentage padding resolved here: a collapsed table's own border is in its intrinsic widths already.)
      const it0 = withOwnPct(intrinsic(n, c, slot, true), rawProps, pctProps);
      // A vertical scrollbar that appeared (overflow-y: auto) is next to the content: it adds to its width.
      const it = barY && ovs?.y !== "scroll" ? { ...it0, min: it0.min + barY, max: it0.max + barY } : it0;
      if (it.why) {
        issues.push({ severity: "error", id, path: props.width?.steps.at(-1)?.path ?? sourcePath, message: `#${id} ${what}, and its content can't be measured (${it.why})` });
        return room;
      }
      const f = Math.min(it.max, Math.max(it.min, room));
      if (it.wraps && f < it.max - EPS) assumptions.push("its width comes from its content, and a row inside it wraps there: the browser sizes it from the wrapped lines");
      return f;
    };
    if (forcedW !== undefined) w = forcedW;
    else {
      if (typeof pw === "number") w = pw;
      else if (pw !== undefined && typeof pw === "object") w = sizeAt(pw, avail);
      else if (pw === "fit" || pw === "max-content" || pw === "min-content") {
        w = fit(pw === "max-content" ? Infinity : pw === "min-content" ? 0 : Math.max(0, avail - m.left - m.right), `is as wide as its content (width: ${pw})`);
        if (props.aspect) assumptions.push("width: fit with an aspect ratio: the browser also sizes it from its height, which isn't modelled");
      }
      // Auto margins across a stack (a column flexbox) switch off stretching: it's as wide as its content.
      else if (parent === "stack" && pw === undefined && (m.autoLeft || m.autoRight) && !props.maxWidth && !props.aspect)
        w = fit(Math.max(0, avail - m.left - m.right), "has an auto margin in a stack, which sizes it to its content");
      // In block flow, justify-self other than stretch: fit-content, placed by offsetX.
      else if ((parent === "flow" || parent === "page") && pw === undefined && props.place?.value.justify && props.place.value.justify !== "stretch" && !props.maxWidth && !props.aspect && !m.autoLeft && !m.autoRight)
        w = fit(Math.max(0, avail - m.left - m.right), `is aligned ${props.place.value.justify} in block flow (justify-self), which sizes it to its content`);
      // A stack that doesn't stretch its children (align-items: center, start, end): fit-content.
      else if (parent === "stack" && pw === undefined && stackAlign && stackAlign !== "stretch" && !props.maxWidth && !props.aspect)
        w = fit(Math.max(0, avail - m.left - m.right), `sits in a stack aligned ${stackAlign}, which sizes it to its content`);
      // A float without a width is as wide as its content (shrink-to-fit in its containing block).
      else if (props.float && pw === undefined && !props.aspect && !props.maxWidth) w = fit(Math.max(0, avail - m.left - m.right), "floats, which sizes it to its content");
      else if (pw === "fill" || props.aspect || props.maxWidth) w = avail; // width: 100%
      // A table without a width is as wide as its columns want (fit-content), unless a flex column or grid stretches it.
      else if (grid && pw === undefined && parent !== "stack" && parent !== "grid" && parent !== "layer") w = fit(Math.max(0, avail - m.left - m.right), "is a table as wide as its content");
      // A form control of known intrinsic width in block flow isn't stretched: it is that wide (and may overflow).
      else if ((parent === "flow" || parent === "page") && pw === undefined && CONTROLS.has(n.tag) && n.controlWidth !== undefined && !m.autoLeft && !m.autoRight) w = n.controlWidth + insX;
      else w = Math.max(0, avail - m.left - m.right); // page, flow, stack, grid cell, layer: stretch inside the margins
      if (w > maxW) w = maxW;
      // box-sizing: border-box never makes a box narrower than its padding and border.
      w = Math.max(w, insX);
    }

    let innerW = Math.max(0, w - insX);

    // ---- content
    const children: Box[] = [];
    let contentH = 0;
    let contentW = 0;
    let lines: Line[] | undefined;
    const pattern = props.pattern?.value;
    // Inside a flex or grid container or a table cell, a table's column percentages don't size it (table_node.cc).
    const formatsKids = (!!pattern && pattern !== "flow" && pattern !== "table") || props.part?.value.part === "cell";
    if (formatsKids) flexAncestors++;
    // A percentage gap: of the content width (intrinsic sizes count it as 0, as Chromium does).
    const gap = props.gap?.pct !== undefined ? sizeAt({ pct: props.gap.pct }, innerW) : (props.gap?.value ?? 0);
    // Between the rows of a grid or the lines of a cluster (row-gap), when it differs from the column gap.
    const rowGap = props.rowGap?.value ?? (props.gap?.pct !== undefined ? 0 : gap);
    const allKids = isText ? [] : n.children.map((k) => ({ node: k, ...childOf(k, c) }));
    const placed = allKids.filter((k) => k.comp !== null) as { node: FixtureNode; comp: Component; slot: string | undefined }[];
    // Absolute and fixed children are out of flow: placed once everything else is (see placeAbsolute).
    const kids = placed.filter((k) => !outOfFlow(k.comp, k.slot));
    const outKids = placed.filter((k) => outOfFlow(k.comp, k.slot));
    const skipped = allKids.filter((k) => k.comp === null).map((k) => k.node);

    if (!isText && n.ownText && n.children.length) {
      issues.push({
        severity: "error",
        id,
        path: sourcePath,
        message: `#${id} has loose text ("${n.ownText.slice(0, 40)}") next to its child elements; the engine doesn't lay it out${say(". Wrap it in a slot element", "")}`,
      });
    }
    if (!isText && n.text && !n.children.length) {
      issues.push({
        severity: "error",
        id,
        path: sourcePath,
        message: say(`#${id} contains text but has no text role; add text: <role> so it can be measured`, `the text of #${id} can't be measured: its font-size, line-height (a number or a length, or normal in a font with vertical metrics), font-weight or color isn't one Cadesa reads`),
      });
    }

    if (kids.length && !pattern) {
      issues.push({
        severity: "error",
        id,
        path: sourcePath,
        message: say(`#${id} has child slots but no layout; add layout: { pattern: stack | cluster | grid | layer }`, `the children of #${id} aren't laid out: its display (or grid template) has no Cadesa equivalent`),
      });
    }
    for (const k of [...skipped, ...(pattern ? [] : kids.map((k) => k.node))]) notLaidOut(k);

    /** Rows of children (grid rows, cluster lines, the layer cell) whose heights `arrange` distributes. */
    let rows: Box[][] | undefined;
    // Block flow in block flow: with no padding or border in between, this box's top margin and
    // its first child's are one margin (likewise at the bottom while its height is auto).
    const inFlow = parent === "flow" || parent === "page";
    // overflow other than visible or clip: a scroll container, a new block formatting context that
    // keeps its children's margins inside.
    const ov = props.overflow?.value;
    // So does layout or paint containment (an independent formatting context).
    const scroller = scrolls(ov) || containsLayout(props.contain?.value);
    // A float, a scroll container, flow-root, a flex or grid container or item, a table and its
    // cells, an out-of-flow box: a block formatting context of its own, which holds its floats.
    const ownContext = establishes(n, props, parent);
    const throughTop = inFlow && ins.top === 0 && !ownContext;
    const throughBottom = inFlow && ins.bottom === 0 && !props.height && !props.minHeight && !props.aspect && !ownContext;
    /** Where this box's content box sits in its block formatting context (its own, or the one it is in). */
    const flowCtx: Bfc = ownContext || !bfc ? { ex: new Exclusions(), x: ins.left, y: ins.top } : { ex: bfc.ex, x: bfc.x + ins.left, y: bfc.y + ins.top };
    let escaped: FlowResult | undefined;
    let grows: StackGrow | undefined;
    let gridArr: ((contentH: number) => void) | undefined;
    /** A table's border box height, captions included (table.ts). */
    let tableH: number | undefined;

    if (grid) {
      // Given its width by a flex or grid container (not shrunk to fit): its columns share exactly that.
      const fixedW = forcedW !== undefined && (parent === "cluster" || parent === "grid" || parent === "layer" || parent === "stack");
      const cssH = props.height || props.minHeight ? Math.max(props.height?.value ?? 0, props.minHeight?.value ?? 0) : undefined;
      const stretchedW = fixedW || ((parent === "stack" || parent === "grid" || parent === "layer") && pw === undefined);
      let t = layoutTable(grid, w, stretchedW, cssH);
      // A flex or grid item is laid out again at the height its container gives it (its own, here):
      // a table then shares that height between its row groups, which (as Chromium sums them before
      // rowspans grow their rows) may make some taller.
      if (!grid.why && t.gridH > (cssH ?? 0) && (parent === "stack" || parent === "grid" || parent === "layer" || parent === "cluster")) {
        const again = layoutTable(grid, w, stretchedW, t.gridH);
        // In a column flexbox it always is (its box keeps that height; rows a rowspan grew may then
        // overflow it); in a row or a grid only when stretched (not modelled here).
        if (parent === "stack") t = { ...again, h: t.h };
        else if (Math.abs(again.h - t.h) > EPS) t.assumptions.push("a table stretched by its flex or grid container shares its height between its row groups again, which isn't modelled when rowspans grew its rows");
      }
      w = t.w;
      innerW = Math.max(0, w - insX);
      tableH = t.h;
      assumptions.push(...t.assumptions);
      if (grid.why) for (const k of kids) notLaidOut(k.node);
      // Children are placed from the content box (place() adds the insets back).
      for (const b of t.children) {
        b.x -= ins.left;
        b.y -= ins.top;
      }
      children.push(...t.children);
      contentH = Math.max(0, t.h - insY);
    } else if (kids.length && pattern === "grid" && fullGrid(props, kids)) {
      const tg = templateGrid({ props, node: n }, kids, innerW, gap, assumptions);
      children.push(...tg.boxes);
      contentH = tg.contentH;
      gridArr = tg.arrange;
    } else if (kids.length && pattern === "grid") {
      const { colW, colX } = props.columns ? tracks(props.columns.value, kids, innerW, gap, assumptions) : autoFill(props.min!.value, innerW, gap);
      const cols = colW.length;
      const justify = props.justifyItems?.value ?? "stretch";
      const measured = kids.map((k, j) => {
        const cw = colW[j % cols];
        if (justify === "stretch") return measure(k.node, k.comp, k.slot, cw, "grid");
        // Not stretched: as wide as its content (fit-content in its column), unless it sets a width.
        const kp = atBase(resolveElement(model, k.comp, k.slot, width), cw);
        const km = marginOf(kp);
        if (kp.width?.value !== undefined && kp.width.value !== "fit") return measure(k.node, k.comp, k.slot, cw, "grid");
        const it = intrinsic(k.node, k.comp, k.slot);
        if (it.why) {
          const b = measure(k.node, k.comp, k.slot, cw, "grid");
          b.assumptions.push(`justify-items: ${justify} sizes it to its content, which can't be measured (${it.why})`);
          return b;
        }
        return measure(k.node, k.comp, k.slot, cw, "grid", Math.max(0, Math.min(it.max, Math.max(it.min, cw - km.left - km.right))));
      });
      rows = [];
      for (let r = 0; r < measured.length; r += cols) {
        const row = measured.slice(r, r + cols);
        row.forEach((b, i) => {
          const m = marginOf(b.props);
          const free = U(colW[i]) - U(b.w) - U(m.left) - U(m.right);
          b.x = colX[i] + (justify === "stretch" ? offsetX(b, colW[i]) : m.left + (justify === "center" ? PX(Math.trunc(free / 2)) : justify === "end" ? PX(free) : 0));
        });
        rows.push(row);
      }
    } else if (kids.length && pattern === "layer") {
      const measured = kids.map((k) => measure(k.node, k.comp, k.slot, innerW, "layer"));
      for (const b of measured) b.x = offsetX(b, innerW);
      rows = [measured];
    } else if (kids.length && pattern === "stack") {
      // A column flexbox: margins add to each item's outer size and never collapse.
      let y = 0;
      const align = props.align?.value ?? "stretch";
      kids.forEach((k, i) => {
        // Its own alignment (align-self) wins over the stack's.
        const own = (resolveElement(model, k.comp, k.slot, width).place?.value.align ?? align) as "start" | "center" | "end" | "stretch";
        const b = measure(k.node, k.comp, k.slot, innerW, "stack", undefined, undefined, undefined, own);
        const km = marginOf(b.props);
        // Aligned across the stack by its margin box (auto inline margins win over align-items).
        const free = U(innerW) - U(b.w) - U(km.left) - U(km.right);
        b.x = own === "stretch" || km.autoLeft || km.autoRight || b.props.maxWidth ? offsetX(b, innerW) : km.left + PX(own === "center" ? Math.trunc(free / 2) : own === "end" ? free : 0);
        b.y = y + km.top;
        y += km.top + b.h + km.bottom + (i < kids.length - 1 ? gap : 0);
        children.push(b);
      });
      contentH = y;
      // Children that grow, or auto top and bottom margins, take the extra height once it's known (placeStack).
      if (children.some((b) => b.props.grow || marginOf(b.props).autoTop || marginOf(b.props).autoBottom)) grows = { kids: children, gap, insetTop: ins.top, insetY: insY, natural: children.map((b) => b.h) };
    } else if (kids.length && pattern === "flow") {
      // A box sized by its aspect ratio keeps its last child's bottom margin neither inside nor out (Chromium drops it).
      const end = throughBottom ? "escape" : inFlow && !scroller && ins.bottom === 0 && props.aspect && !props.height ? "drop" : "keep";
      const f = flowKids(kids, innerW, throughTop, end, flowCtx, "flow");
      children.push(...f.boxes);
      contentH = f.contentH;
      escaped = f;
    } else if (kids.length && pattern === "cluster") {
      rows = cluster(kids, innerW, gap, props.justify?.value ?? "start", props.wrap?.value === false);
    } else if (isText && n.text) {
      const t = props.text!.value;
      const lineH = lineHeightPx(t.sizePx, t.lineHeight);
      if (measureText) {
        // Its floats, laid out first (each as wide as its content in this box, unless set), placed
        // when their line is (see layoutText's floats).
        const fboxes = textFloats.map((k) => measure(k.node, k.comp, k.slot, innerW, "flow"));
        for (const b of fboxes) {
          floated.add(b);
          collapse.set(b, { top: NONE, bottom: NONE, empty: true, at: NONE });
        }
        children.push(...fboxes);
        const inlineFloat = (index: number) => {
          const b = fboxes[index];
          const fm = marginOf(b.props);
          const fw = fm.left + b.w + fm.right;
          const fh = fm.top + b.h + fm.bottom;
          return {
            w: fw,
            // Whether it can go right at a line's top (beside what is there), or would end up lower.
            fitsAt: (top: number) => {
              const from = Math.max(flowCtx.y + top, b.props.clear ? flowCtx.ex.clearance(b.props.clear.value) : -Infinity);
              return flowCtx.ex.find(Math.max(from, flowCtx.ex.lastTop), Math.max(0, fh), flowCtx.x, flowCtx.x + innerW, (room) => fw <= room + EPS).top <= flowCtx.y + top + EPS;
            },
            place: (top: number) => {
              const from = Math.max(flowCtx.y + top, b.props.clear ? flowCtx.ex.clearance(b.props.clear.value) : -Infinity);
              const at = flowCtx.ex.place(b.props.float!.value, fw, fm.top + b.h + fm.bottom, from, flowCtx.x, flowCtx.x + innerW);
              b.x = at.x - flowCtx.x + fm.left;
              b.y = at.y - flowCtx.y + fm.top;
            },
          };
        };
        // Beside floats (any below its top in its formatting context): each line in the room they leave.
        const beside = fboxes.length > 0 || flowCtx.ex.bottom > flowCtx.y + EPS;
        const band: Band | undefined = beside
          ? (top, h, fits) => {
              const at = flowCtx.ex.find(flowCtx.y + top, h, flowCtx.x, flowCtx.x + innerW, fits);
              return { top: at.top - flowCtx.y, l: at.l - flowCtx.x, r: at.r - flowCtx.x };
            }
          : undefined;
        const tl = measureText(innerW, band, fboxes.length ? inlineFloat : undefined);
        lines = tl.lines;
        const last = lines.at(-1);
        contentH = band && last?.top !== undefined ? last.top + (last.h ?? lineH) : lines.reduce((s, l) => s + (l.h ?? lineH), 0);
        contentW = Math.max(...lines.map((l) => l.width));
        // Text in a box that clips or scrolls it (overflow-x other than visible) doesn't spill out: check reports it as clipped.
        if (tl.minContent > innerW + 0.5 && !t.nowrap && !t.wrapAnywhere && (!ov || ov.x === "visible") && !props.contain?.value.paint) {
          issues.push({
            severity: "warning",
            id,
            path: props.text!.steps.at(-1)!.path,
            message: `"${tl.widestPiece}" in #${id} can't wrap and overflows by ${fmtPx(tl.minContent - innerW)}px at ${width}px`,
          });
        }
      } else contentH = lineH;
    }
    if (rows) {
      children.push(...rows.flat());
      contentH = rows.reduce((s, r) => s + rowHeight(r, props.align?.value), 0) + rowGap * (rows.length - 1);
    }
    // A block formatting context's root is as tall as the floats in it (CSS 2.1 §10.6.7).
    if (ownContext && !flowCtx.ex.empty && (pattern === undefined || pattern === "flow")) contentH = Math.max(contentH, flowCtx.ex.bottom - ins.top);

    // aspect: the height follows the width. Media elements take exactly that; other boxes grow if
    // their content needs more (aspect-ratio's automatic minimum size). In a stack (a column
    // flexbox) that minimum is capped by the max-width converted through the ratio.
    const media = MEDIA.has(n.tag);
    // Size containment: as tall as if it were empty (its content is laid out, and overflows).
    const sizeContained = props.contain?.value.size === "both";
    if (sizeContained && (rows || grows || (kids.length && !containsLayout(props.contain!.value) && (throughTop || throughBottom))))
      assumptions.push("size containment on a flex, grid or block container without layout containment: how its content sizes against its empty height isn't modelled");
    const ownH = sizeContained ? 0 : contentH;
    let h = tableH ?? props.height?.value ?? ownH + insY;
    if (props.aspect && !props.height) {
      const ratioH = w / props.aspect.value;
      const contentMin = parent === "stack" ? Math.min(ownH + insY, maxW / props.aspect.value) : ownH + insY;
      h = media ? ratioH : Math.max(ratioH, contentMin);
      // A one-line cluster with an aspect ratio whose content is taller: Chromium sometimes keeps the ratio.
      if (!media && pattern === "cluster" && props.wrap?.value === false && contentMin > ratioH + EPS) assumptions.push("a one-line cluster with an aspect ratio whose content is taller than the ratio: its height isn't modelled");
      // A grid sized by its aspect ratio whose rows need more: Chromium sizes the rows within the ratio's height (not modelled).
      if (gridArr && contentMin > ratioH + EPS) assumptions.push("a grid with an aspect ratio whose content is taller than the ratio: its height isn't modelled");
    }
    // min-height: never shorter (border-box; content taller than it makes the box taller as usual).
    if (props.minHeight && tableH === undefined) h = Math.max(h, props.minHeight.value);
    h = Math.max(h, insY);
    // A box shorter than its content shrinks the items that may shrink: an <hr> clips its overflow
    // (overflow: hidden), so its automatic minimum height is 0 and a stack, grid or layer that is
    // too short squeezes it. The engine doesn't model that.
    const tallKids = rows ? rows.reduce((s, r) => s + Math.max(0, ...r.map(outerH)), 0) + rowGap * (rows.length - 1) : contentH;
    // Nor how a box whose height is set (height, aspect) sizes around one.
    if (tallKids + insY > h + EPS || props.height || props.aspect)
      for (const k of rows ? rows.flat() : children)
        if (k.tag === "hr") k.assumptions.push("an <hr> in a box with a set height may shrink (it clips its overflow)");
        else if (scrolls(k.props.overflow?.value) && pattern === "stack") k.assumptions.push(`a box with overflow: ${k.props.overflow!.display} in a stack with a set height may shrink (its minimum height is 0)`);
    // A scroll container's content overflowing it: by its children's border and margin boxes (the
    // padding at its end included, so past its content box), and their own overflow. Chromium shows
    // a scrollbar for overflow of half a pixel or more (its scroll size is pixel-snapped).
    let scrollbar = !!(barX || barY) || (!!ovs && (ovs.x === "scroll" || ovs.y === "scroll"));
    if (ovs && (ovs.x === "auto" || ovs.y === "auto")) {
      const kidRight = (b: Box) => {
        const kov = b.props.overflow?.value;
        const spill = b.overflowX && (!kov || kov.x === "visible") && !b.props.contain?.value.paint ? b.x + b.w - insets(b.props).right + b.overflowX : -Infinity;
        return Math.max(b.x + b.w, b.x + b.w + marginOf(b.props).right, spill);
      };
      const extentX = Math.max(lines ? contentW : 0, ...children.map(kidRight));
      const roomY = props.height && tableH === undefined ? props.height.value - insY : undefined;
      const overX = ovs.x === "auto" && extentX - innerW >= 0.5 - EPS;
      const overY = ovs.y === "auto" && roomY !== undefined && contentH - roomY >= 0.5 - EPS;
      if (SB && !kept && ((overX && !barX) || (overY && !barY))) {
        if (formatsKids) flexAncestors--;
        auto = undo.auto;
        issues.length = undo.issues;
        absQueue.length = undo.abs;
        if (undo.ex) bfc!.ex.reset(undo.ex);
        // Laid out again with its scrollbars: the scroll containers inside it keep theirs (from `shown`, this pass's).
        const outer = frozen;
        frozen ??= shown;
        try {
          return measure(n, c, slot, avail, parent, forcedW, over, cbW, stackAlign, { x: !!barX || overX, y: !!barY || overY }, bfc);
        } finally {
          frozen = outer;
        }
      }
      if (!kept && (overX || overY)) scrollbar = true;
      if (SB) {
        // Where Chromium's choice hinges on a fraction of a pixel, or on what isn't laid out here.
        const close = kept ? !!kept.close : (ovs.x === "auto" && Math.abs(extentX - innerW - 0.5) < 1 / 64) || (roomY !== undefined && ovs.y === "auto" && Math.abs(contentH - roomY - 0.5) < 1 / 64);
        if (!kept) shown.set(n, { x: !!barX, y: !!barY, ...(close && { close }) });
        if (close) assumptions.push("its content overflows it by about half a pixel: whether a scrollbar appears isn't known");
        if (children.some((b) => b.props.transform || b.props.position?.value.type === "relative") || outKids.length)
          assumptions.push("a scroll container with a positioned or transformed child: what it scrolls (and so its scrollbars) isn't modelled");
        // A width from its content (fit-content) grows by the scrollbar; one given by a flex or grid container's sizing would too.
        if (barY && ovs.y !== "scroll" && !fromContent && forcedW !== undefined) assumptions.push("its vertical scrollbar adds to its width, as its flex or grid container sizes it: not modelled");
      }
    }
    // Without aspect (whose width: 100% wins), a media element with only a height takes its width
    // from its width attribute, or at the page level from the file's own ratio, instead of stretching.
    if (media && props.height && !props.aspect && (pw === undefined || pw === "fill") && !props.maxWidth && parent !== "cluster") {
      if (n.attrs.width) assumptions.push(`its width comes from the width="${n.attrs.width}" attribute, not the layout; ${say("add aspect or a width token", "give it a width or an aspect-ratio")}`);
      else if (parent === "page" || parent === "flow") assumptions.push(`${parent === "page" ? "at the page level" : "in block flow"} its width follows the image file; ${say("add aspect or a width token", "give it a width or an aspect-ratio")}`);
    }
    // A form control is as wide as its content unless something sets its width.
    if ((parent === "page" || parent === "flow") && CONTROLS.has(n.tag) && (pw === "fill" || (pw === undefined && n.controlWidth === undefined)) && !props.maxWidth)
      assumptions.push(`a <${n.tag}> ${parent === "page" ? "at the page level" : "in block flow"} is as wide as its content; ${say("give it a width token or maxWidth", "give it a width")}`);
    if (media && !props.aspect && !props.height)
      issues.push({
        severity: "warning",
        id,
        path: sourcePath,
        message: `<${n.tag}> #${id} has no aspect or height, so its size depends on ${n.attrs.width || n.attrs.height ? "its width/height attributes and the file" : "the file"} and can't be predicted; ${say(`add aspect: "16:9" (or height)`, "give it an aspect-ratio (or a height)")}`,
      });
    if (media && !props.aspect && !props.height) assumptions.push("its size depends on the image file (no aspect or height)");
    // Lifted from line boxes (see Props.root): beside a float, those lines would be shortened.
    if (props.root?.value === false && bfc && bfc.ex.band(bfc.y, Math.max(h, 1), bfc.x, bfc.x + w).beside)
      assumptions.push("inline content laid out from its line boxes, beside a float, isn't modelled");
    const box: Box = {
      id,
      tag: n.tag,
      component: c.name,
      slot,
      sourcePath,
      fixtureLine: n.line,
      attrs: n.attrs,
      ...(n.controlBaseline !== undefined && { controlBaseline: n.controlBaseline }),
      x: 0,
      y: 0,
      w,
      h,
      props,
      text: isText ? n.text || undefined : undefined,
      lines,
      ...(isText && runFontsOf(n, props).length && { runFonts: runFontsOf(n, props) }),
      ...(isText && metricsFor(props.text?.value.font, !!props.text?.value.italic)?.info.contextualIncomplete && { runTexts: (n.runs.length ? n.runs : [n.text]).map((r) => (props.text?.value.uppercase ? r.toUpperCase() : r)) }),
      assumptions,
      children,
      ...(n.anonymous && { anonymous: true }),
      ...(scrollbar && { scrollbar: true }),
    };
    // A block with nothing in it (no height, padding, border, lines or non-empty child) lets its
    // own top and bottom margins collapse through it (an aspect-ratio box that comes out 0 tall too).
    // Flex and grid containers, form controls,
    // media and <hr> (overflow: hidden) never do.
    const empty =
      h === 0 && insY === 0 && !props.height && !media && !CONTROLS.has(n.tag) && n.tag !== "hr" && !ownContext &&
      !(isText && n.text) && (pattern === undefined ? !kids.length : pattern === "flow" && !!escaped?.empty);
    const inner = escaped?.empty ? escaped.pending : NONE;
    const mt = strut(m.top);
    const mb = strut(m.bottom);
    collapse.set(
      box,
      empty
        ? { top: join(mt, mb, inner), bottom: join(mt, mb, inner), empty: true, at: join(mt, inner) }
        : {
            top: throughTop && escaped ? join(mt, escaped.top) : mt,
            bottom: throughBottom && escaped ? join(mb, escaped.bottom) : mb,
            empty: false,
            at: NONE,
          },
    );
    if (skipped.length)
      sources.set(box, `contains ${skipped.map((k) => `<${k.tag}>`).join(", ")} that the engine doesn't lay out`);
    if (grows) stackGrow.set(box, grows);
    if (rows)
      arrangement.set(box, {
        rows,
        heights: rows.map((r) => rowHeight(r, props.align?.value)),
        gap: rowGap,
        ...(props.rowGap?.pct !== undefined && { gapPct: props.rowGap.pct }),
        align: props.align?.value ?? (pattern === "cluster" ? "center" : "stretch"),
        insetTop: ins.top,
        insetY: insY,
        flexLines: pattern === "cluster",
        oneLine: pattern === "cluster" && props.wrap?.value === false,
      });
    if (gridArr) gridArrange.set(box, gridArr);
    if (rows || grows || gridArr) arrange(box);
    for (const k of outKids) {
      // Its static position (where it would be with no offsets): in block flow, below the in-flow
      // boxes before it and the margins pending there (those before it only: what follows can't
      // collapse with it), as if it were the only item in a flexbox, at the padding box corner of a grid.
      const at = n.children.indexOf(k.node);
      const before = kids.flatMap((x, i) => (n.children.indexOf(x.node) < at ? [i] : []));
      const skippedBefore = skipped.some((x) => n.children.indexOf(x) < at);
      let pos: { x: number; y: number } | undefined;
      const flowLike = pattern === undefined || pattern === "flow";
      if (skippedBefore) pos = undefined;
      else if (!before.length && (flowLike || pattern === "stack")) pos = { x: 0, y: 0 };
      else if (pattern === "stack") pos = { x: 0, y: 0 };
      else if (pattern === "cluster") pos = (props.justify?.value ?? "start") === "start" && /^(start|stretch)$/.test(props.align?.value ?? "center") ? { x: 0, y: 0 } : undefined;
      else if (pattern === "grid" || pattern === "layer") pos = /^(start|stretch)$/.test(props.align?.value ?? "stretch") && /^(start|stretch)$/.test(props.justifyItems?.value ?? "stretch") ? { x: -(ins.left - (props.border?.value.widths.left ?? 0)), y: -(ins.top - (props.border?.value.widths.top ?? 0)) } : undefined;
      else if (flowLike) {
        const boxesBefore = before.map((i) => children[i]);
        let last = -1;
        boxesBefore.forEach((b, i) => {
          if (!collapse.get(b)!.empty) last = i;
        });
        const empties = boxesBefore.slice(last + 1).map((b) => collapse.get(b)!.top);
        if (last >= 0) {
          const lb = boxesBefore[last];
          pos = { x: 0, y: lb.y + lb.h + sum(join(collapse.get(lb)!.bottom, ...empties)) };
        } else if (!throughTop) pos = { x: 0, y: sum(join(...empties)) };
      }
      absQueue.push({ k, parent: box, at: pos });
    }

    // Overflow: past the content box on the right (a negative right margin may pull a child past it on purpose).
    const widest = Math.max(contentW, ...children.map((b) => b.x + b.w + Math.min(0, marginOf(b.props).right)));
    // A box that clips or scrolls its content horizontally: what doesn't fit is cut off or scrolls,
    // it doesn't spill out (check reports clipped text). Scrollbars take space only where they
    // aren't overlaid (Windows, many Linux setups); Cadesa predicts overlay scrollbars.
    const clipsX = (!!ov && ov.x !== "visible") || !!props.contain?.value.paint;
    if (clipsX && widest > innerW + 0.5) box.overflowX = widest - innerW;
    else if (widest > innerW + 0.5 && children.some((b) => b.x + b.w + Math.min(0, marginOf(b.props).right) > innerW + EPS)) {
      box.overflowX = widest - innerW;
      const culprit = children.find((b) => b.x + b.w + Math.min(0, marginOf(b.props).right) > innerW + EPS)!;
      issues.push({
        severity: "warning",
        id,
        path: culprit.props.width?.steps.at(-1)?.path ?? culprit.sourcePath,
        message: `#${culprit.id} overflows #${id} by ${fmtPx(box.overflowX)}px at ${width}px`,
      });
    } else if (widest > innerW + 0.5) {
      box.overflowX = widest - innerW;
      // white-space: nowrap text wider than its box spills out of it.
      if (lines && props.text?.value.nowrap && contentW > innerW + 0.5)
        issues.push({
          severity: "warning",
          id,
          path: props.text.steps.at(-1)!.path,
          message: `the text of #${id} doesn't wrap (white-space: nowrap) and overflows it by ${fmtPx(contentW - innerW)}px at ${width}px`,
        });
    }
    const clipsY = (!!ov && ov.y !== "visible") || !!props.contain?.value.paint;
    if (props.height && contentH > props.height.value - insY + 0.5 && clipsY) box.overflowY = contentH - (props.height.value - insY);
    else if (props.height && contentH > props.height.value - insY + 0.5) {
      box.overflowY = contentH - (props.height.value - insY);
      issues.push({
        severity: "warning",
        id,
        path: props.height.steps.at(-1)!.path,
        message: `content of #${id} needs ${fmtPx(contentH + insY)}px but its height is ${fmtPx(props.height.value)}px at ${width}px${lines ? ` (${lines.length} lines)` : ""}`,
      });
    }
    // A height of its own is definite: percentages of it resolve.
    if (props.height) fillPct(box);
    if (formatsKids) flexAncestors--;
    return box;
  }

  /**
   * Place the rows of a grid, cluster or layer inside its final height. A container taller than its
   * content (a fixed height, an aspect ratio, or stretched by its own parent) shares the extra
   * height equally between its rows: grid auto tracks stretch, and so do the lines of a wrapping
   * flex container (align-content: normal). Children are then aligned within their row.
   */
  function arrange(b: Box) {
    const ga = gridArrange.get(b);
    if (ga) {
      const ib = insets(b.props);
      ga(Math.max(0, b.h - ib.top - ib.bottom));
      return;
    }
    placeStack(b);
    const a = arrangement.get(b);
    if (!a) return;
    // A percentage row gap resolves against the final content height (Chromium sized the rows without it; they may overflow).
    const gap = a.gapPct !== undefined ? sizeAt({ pct: a.gapPct }, Math.max(0, b.h - a.insetY)) : a.gap;
    const natural = a.heights.reduce((s, h) => s + h, 0) + gap * (a.rows.length - 1);
    const free = Math.max(0, b.h - a.insetY - natural);
    const next = a.flexLines ? diffuser(U(free), a.rows.length) : () => U(free / a.rows.length);
    let y = 0;
    a.rows.forEach((row, r) => {
      // A one-line cluster's line is exactly as tall as its content box, even when shorter than its items.
      const rowH = a.oneLine ? b.h - a.insetY : a.heights[r] + (a.flexLines ? PX(next()) : free / a.rows.length);
      for (const c of row) {
        // Items are aligned by their margin boxes.
        const m = marginOf(c.props);
        // Auto top or bottom margins take the row's free space (none: the item sits at the start), and switch off stretching.
        if (m.autoTop || m.autoBottom) {
          const space = Math.max(0, U(rowH) - U(outerH(c)));
          c.y = y + m.top + PX(m.autoTop && m.autoBottom ? Math.trunc(space / 2) : m.autoTop ? space : 0);
          continue;
        }
        // Its own alignment (align-self) wins over the container's.
        const al = c.props.place?.value.align ?? a.align;
        // stretch grows every item without a fixed height, aspect ratio or not.
        if (al === "stretch" && !c.props.height) {
          // In a one-line cluster the line may be shorter than the item: stretching then shrinks it (its content overflows).
          const target = rowH - m.top - m.bottom;
          if (a.oneLine && target < c.h) {
            c.h = Math.max(target, insets(c.props).top + insets(c.props).bottom);
            arrange(c);
          } else grow(c, target);
          // A stretched item's height is definite: percentages of it resolve.
          fillPct(c);
        }
        if (al === "baseline") {
          // Its first baseline on the line's: the line's highest item (above its baseline) at the top.
          const top = Math.max(...row.filter((x) => (x.props.place?.value.align ?? a.align) === "baseline" && !marginOf(x.props).autoTop && !marginOf(x.props).autoBottom).map(itemBaseline));
          c.y = y + m.top + top - itemBaseline(c);
          continue;
        }
        const space = rowH - outerH(c);
        c.y = y + m.top + (al === "center" ? space / 2 : al === "end" ? space : 0);
      }
      y += rowH + gap;
    });
  }

  /**
   * A stack taller than its content: children with grow take the extra height (Chromium's
   * flex-grow in a column; see growLine), and the ones after them move down.
   */
  function placeStack(b: Box) {
    const g = stackGrow.get(b);
    if (!g) return;
    const inner = b.h - g.insetY;
    const items = g.kids.map((k, i) => {
      const m = marginOf(k.props);
      const gr = k.props.grow?.value;
      const iy = insets(k.props);
      const natural = g.natural[i];
      // Grows from its own height (basis content) or from nothing (zero), never below its content (min-height: auto).
      const base = gr && gr.basis === "zero" ? iy.top + iy.bottom : k.props.height ? k.props.height.value : natural;
      return { base: U(base), hyp: U(natural), factor: gr?.factor ?? 0, shrink: 0, pad: U(iy.top + iy.bottom), min: U(natural), max: Infinity, out: U(m.top + m.bottom) };
    });
    const sizes = g.kids.some((k) => k.props.grow) ? flexLine(items, U(inner), U(g.gap)) : undefined;
    g.kids.forEach((k, i) => {
      const h = sizes ? PX(sizes[i]) : g.natural[i];
      if (h > k.h) grow(k, h);
    });
    // Auto top and bottom margins take what free space is left (before justify-content), shared as the
    // line's auto margins are (Chromium's diffuser, in layout units).
    const autos = g.kids.reduce((t, k) => t + (marginOf(k.props).autoTop ? 1 : 0) + (marginOf(k.props).autoBottom ? 1 : 0), 0);
    const free = U(inner) - g.kids.reduce((t, k) => t + U(outerH(k)), 0) - U(g.gap) * (g.kids.length - 1);
    const auto = autos && free > 0 ? diffuser(free, autos) : () => 0;
    let y = 0;
    g.kids.forEach((k) => {
      const m = marginOf(k.props);
      const at = m.autoTop ? PX(auto()) : 0;
      const ab = m.autoBottom ? PX(auto()) : 0;
      k.y = y + at + m.top;
      y += at + m.top + k.h + m.bottom + ab + g.gap;
    });
  }

  /**
   * Where a flex item's first baseline sits below its margin box's top (px), for align-items:
   * baseline: its first line's (or its first child's that has one), else one synthesized at the
   * bottom of its border box. An item whose baseline can't be told is placed as if at its bottom,
   * and flagged.
   */
  function itemBaseline(c: Box): number {
    const m = marginOf(c.props);
    const fb = firstBaseline({ lineHeight: lineHeightPx }, c);
    if (fb === "unknown") {
      if (!c.assumptions.some((a) => a.startsWith("its baseline")))
        c.assumptions.push(`its baseline (for align-items: baseline) isn't known: ${say("a cluster, grid or scrolling box inside", "a flex row, grid or scroll container inside")} gives it one Cadesa doesn't compute`);
      return m.top + c.h;
    }
    return m.top + (fb === undefined ? c.h : PX(fb));
  }
  /** The natural height of a flex line: its tallest item, or with baseline alignment the most any item reaches above the line's baseline plus the most any reaches below it. */
  function rowHeight(r: Box[], align: string | undefined): number {
    let tall = 0;
    let above = -Infinity;
    let below = -Infinity;
    for (const c of r) {
      const al = c.props.place?.value.align ?? align;
      if (al !== "baseline" || marginOf(c.props).autoTop || marginOf(c.props).autoBottom) tall = Math.max(tall, outerH(c));
      else {
        const a = itemBaseline(c);
        above = Math.max(above, a);
        below = Math.max(below, outerH(c) - a);
      }
    }
    return Math.max(0, tall, above + below);
  }

  /** A box stretched taller after its own layout: its rows (if any) are placed again. */
  /** A <button>'s height before it was stretched, and how far its content has been moved down. */
  const buttonCentered = new WeakMap<Box, { natural: number; moved: number }>();
  function grow(b: Box, newH: number) {
    if (newH <= b.h) return;
    // A table stretched taller shares the height between its rows, which isn't modelled.
    if (b.props.pattern?.value === "table" && newH > b.h + EPS) b.assumptions.push("a table stretched taller than its rows (by a flex or grid container) shares the extra height between them, which isn't modelled");
    const c0 = buttonCentered.get(b) ?? { natural: b.h, moved: 0 };
    b.h = newH;
    arrange(b);
    // A <button> stretched taller than its content centers it (Chromium: its anonymous content
    // box has auto top and bottom margins, safe centering), half the free space in layout units.
    if (b.tag === "button" && !arrangement.has(b) && !gridArrange.has(b) && (b.props.pattern === undefined || b.props.pattern.value === "flow")) {
      const off = PX(Math.trunc(Math.max(0, U(newH) - U(c0.natural)) / 2));
      // (Its own text has no boxes of its own to move.)
      if (!b.lines?.length) for (const c of b.children) if (!absInfo.has(c)) c.y += off - c0.moved;
      buttonCentered.set(b, { natural: c0.natural, moved: off });
    }
  }

  /**
   * Children whose height is a percentage of this box's content height, once that height is
   * definite (the box is stretched by its row, or has a height of its own): they take it, taller
   * or shorter than their content, never shorter than their padding and border. In a stack, a
   * flex item never gets shorter than its content.
   */
  function fillPct(b: Box) {
    const ib = insets(b.props);
    const inner = Math.max(0, b.h - ib.top - ib.bottom);
    for (const c of b.children) {
      const hp = c.props.heightPct?.value;
      if (hp === undefined || absInfo.has(c)) continue;
      const ic = insets(c.props);
      let h = Math.max(sizeAt(hp, inner), ic.top + ic.bottom);
      if (b.props.pattern?.value === "stack") h = Math.max(h, c.h);
      if (h > c.h) grow(c, h);
      else if (h < c.h) {
        c.h = h;
        arrange(c);
      }
      fillPct(c);
    }
  }

  /**
   * What a child element of component `c` is: one of c's slots, or the root of another (nested)
   * component. Null (reported) if it can't be laid out.
   */
  function childOf(n: FixtureNode, c: Component, quiet = false): { comp: Component | null; slot: string | undefined } {
    const before = issues.length;
    const r = childOfLoud(n, c);
    if (quiet) issues.length = before;
    return r;
  }
  function childOfLoud(n: FixtureNode, c: Component): { comp: Component | null; slot: string | undefined } {
    const prefix = `${model.prefix}${c.name}__`;
    const slotCls = n.classes.find((k) => k.startsWith(prefix));
    const nested = n.classes
      .filter((k) => k.startsWith(model.prefix) && !k.includes("__"))
      .map((k) => model.components.get(k.slice(model.prefix.length)))
      .find(Boolean);
    if (slotCls && nested) {
      issues.push({
        severity: "error",
        id: idOf(n),
        message: `<${n.tag}> is both .${slotCls} and the root of .${model.prefix}${nested.name}; mixing a slot and a component on one element isn't modelled. Wrap the component in the slot element instead.`,
      });
      return { comp: null, slot: undefined };
    }
    if (nested) return { comp: nested, slot: undefined };
    const slot = slotOf(n, c);
    return { comp: slot === null ? null : c, slot: slot ?? undefined };
  }

  /** The slot name of a fixture element inside component `c`, or null (reported) if it can't be laid out. */
  function slotOf(n: FixtureNode, c: Component): string | null {
    const prefix = `${model.prefix}${c.name}__`;
    const cls = n.classes.find((k) => k.startsWith(prefix));
    if (!cls) {
      issues.push({
        severity: "error",
        id: idOf(n),
        message: `<${n.tag}> inside .${model.prefix}${c.name} has no ${prefix}<slot> class and isn't another component's root; the engine only lays out declared slots and components`,
      });
      return null;
    }
    const slot = cls.slice(prefix.length);
    if (!c.slots.has(slot)) {
      issues.push({
        severity: "error",
        id: n.fixtureId ?? n.tag,
        path: `${c.path}.slots`,
        message: `fixture uses slot "${slot}" but ${c.path}.slots does not declare it`,
        suggestion: closest(slot, c.slots.keys()),
      });
      return null;
    }
    return slot;
  }

  // The page: the root element's insets (outer), then the body's margin and padding.
  const pg = model.page;
  const tokenPx = (r?: Ref) => {
    if (!r) return 0;
    const t = model.tokens.get(tokenKey(r.kind, r.name))!;
    return layoutUnit(t.fluid ? t.fluid(width) : t.px!);
  };
  const sidesOf = (s?: PageSides) => ({ top: tokenPx(s?.top), right: tokenPx(s?.right), bottom: tokenPx(s?.bottom), left: tokenPx(s?.left) });
  const [outer, bodyMargin, bodyPad] = [sidesOf(pg?.outer), sidesOf(pg?.margin), sidesOf(pg?.padding)];
  const pageW = Math.max(0, layoutW - outer.left - outer.right - bodyMargin.left - bodyMargin.right - bodyPad.left - bodyPad.right);

  const boxes: Box[] = [];
  const pageKids: Kid[] = [];
  let unknownOnPage: string | undefined;
  /** Page-level absolute boxes after in-flow ones: their static position is known once the body's flow is. */
  const pageAbs: { entry: (typeof absQueue)[number]; before: number }[] = [];
  for (const n of fixture.body) {
    const p = model.prefix;
    const candidates = n.classes.filter((k) => k.startsWith(p) && !k.includes("__")).map((k) => k.slice(p.length));
    const name = candidates.find((k) => model.components.has(k));
    const c = name ? model.components.get(name) : undefined;
    if (!c) {
      const guess = p ? candidates[0] : undefined;
      issues.push({
        severity: "error",
        id: idOf(n),
        message: guess
          ? `fixture uses .${p}${guess} but styles.${guess} is not declared`
          : `<${n.tag}> at the page level has no Cadesa component class`,
        suggestion: guess ? closest(guess, model.components.keys()) : undefined,
      });
      notLaidOut(n);
      unknownOnPage ??= `<${n.tag}> on the page isn't a Cadesa component; its height and margins are unknown`;
      continue;
    }
    if (outOfFlow(c, undefined)) {
      const entry: (typeof absQueue)[number] = { k: { node: n, comp: c, slot: undefined }, parent: undefined, ...(!pageKids.length && { at: { x: 0, y: 0 } }) };
      absQueue.push(entry);
      if (pageKids.length && !unknownOnPage) pageAbs.push({ entry, before: pageKids.length });
      continue;
    }
    pageKids.push({ node: n, comp: c, slot: undefined });
  }
  // The body is block flow: page-level boxes stack, their margins collapsing. Its own top margin
  // collapses with theirs unless its padding separates them, so the body starts below the largest
  // (below all of them when every page-level box is empty); the root element contains it, and is
  // the block formatting context of the page's floats.
  const through = bodyPad.top === 0;
  const body = flowKids(pageKids, pageW, through, "escape", { ex: new Exclusions(), x: 0, y: 0 }, "page");
  boxes.push(...body.boxes);
  const top = through ? sum(join(strut(bodyMargin.top), body.empty ? body.pending : body.top)) : bodyMargin.top + bodyPad.top;
  // Below the page-level boxes before it and the margins pending there (as in measure).
  for (const { entry, before } of pageAbs) {
    const prior = boxes.slice(0, before);
    let last = -1;
    prior.forEach((b, i) => {
      if (!collapse.get(b)!.empty) last = i;
    });
    const empties = prior.slice(last + 1).map((b) => collapse.get(b)!.top);
    const base = bodyPad.top ? bodyMargin.top + bodyPad.top : 0;
    if (last >= 0) entry.at = { x: 0, y: top + prior[last].y + prior[last].h + sum(join(collapse.get(prior[last])!.bottom, ...empties)) - base };
    else if (!through) entry.at = { x: 0, y: top + sum(join(...empties)) - base };
  }
  for (const b of boxes) {
    b.y += outer.top + top;
    b.x += outer.left + bodyMargin.left + bodyPad.left;
  }
  // Its margins can collapse through empty boxes above it too, so every page-level box is unsure.
  if (unknownOnPage) for (const b of boxes) sources.set(b, unknownOnPage);

  // Convert relative positions to page coordinates. A relatively positioned box is shifted by its
  // offsets (a percentage of its parent's width or height), with what is inside it; nothing else moves.
  const place = (b: Box, ox: number, oy: number, cbW: number, cbH: number) => {
    b.x += ox;
    b.y += oy;
    const pos = b.props.position?.value;
    if (pos && (pos.type === "relative" || pos.type === "sticky")) {
      const at = (v: number | { pct: number } | undefined, base: number) => (v === undefined ? undefined : sizeAt(v, base));
      const [l, r, t, bt] = [at(pos.left, cbW), at(pos.right, cbW), at(pos.top, cbH), at(pos.bottom, cbH)];
      if (pos.type === "relative") {
        b.x += l ?? (r !== undefined ? -r : 0);
        b.y += t ?? (bt !== undefined ? -bt : 0);
      }
    }
    const inset = insets(b.props);
    for (const k of b.children) place(k, b.x + inset.left, b.y + inset.top, b.w - inset.left - inset.right, b.h - inset.top - inset.bottom);
  };
  const pageX = outer.left + bodyMargin.left + bodyPad.left;
  for (const b of boxes) place(b, 0, 0, pageW, windowH);
  const parentOf = new Map<Box, Box>();
  for (const b of walk(boxes)) for (const k of b.children) parentOf.set(k, b);
  placeAbsolute(parentOf, pageX, outer.top + (bodyPad.top ? bodyMargin.top + bodyPad.top : 0));
  // An inline box laid out as the block of its lines (Props.inlineBox): its rectangle is the union
  // of its text's content area on each line, from where its text starts on the line (aligned in
  // the line's room as text-align says, in layout units; an overflowing line at the start) to where
  // it ends (its width rounded up to a layout unit, as Chromium sizes a text fragment).
  for (const b of walk(boxes)) {
    const ib = b.props.inlineBox?.value;
    if (!ib || !b.lines?.length || !b.props.text) continue;
    const bi = insets(b.props);
    const innerW = b.w - bi.left - bi.right;
    const t = b.props.text.value;
    const lh = lineHeightPx(t.sizePx, t.lineHeight);
    const align = b.props.textAlign?.value ?? "start";
    let next = 0;
    let [x0, x1, y0, y1] = [Infinity, -Infinity, 0, 0];
    b.lines.forEach((l, i) => {
      const top = l.top ?? next;
      const room = l.room ?? innerW;
      const lw = Math.ceil(l.width * 64 - TEXT_EPS) / 64;
      const free = Math.max(0, room - lw);
      const off = (l.x ?? 0) + (align === "center" ? Math.trunc((free * 64) / 2) / 64 : align === "end" ? free : 0);
      x0 = Math.min(x0, off);
      x1 = Math.max(x1, off + lw);
      if (i === 0) y0 = top + ib.top;
      y1 = top + ib.top + ib.height;
      next = top + (l.h ?? lh);
    });
    b.x += bi.left + x0;
    b.y += bi.top + y0;
    b.w = x1 - x0;
    b.h = y1 - y0;
  }

  // Transforms: each transformed box, and everything inside it, is drawn mapped by its matrix (and
  // its ancestors'); its rectangle is the bounding box of its mapped corners. Nothing else moves.
  // A 3D transform is projected: under its parent's perspective (perspective, perspective-origin),
  // flattened onto its parent's plane (transform-style: flat), as getBoundingClientRect() reports it.
  // A box whose parent preserves 3D (transform-style: preserve-3d) is in its 3D rendering context:
  // its transform composes with its parent's, unflattened (the context's root is flattened onto
  // its own parent's plane, as any box is).
  const drawTransformed = (b: Box, chain: Matrix4[], parent: Box | undefined) => {
    const t = b.props.transform?.value;
    const inContext = !!parent?.props.transform?.value.preserve3d;
    let next = chain;
    const own = t && t.list !== "none" ? boxMatrix4(t.list, t.origin, b.w, b.h) : undefined;
    // (A 3D rendering context's root with no transform of its own still takes its parent's perspective, for what composes with it.)
    if (own || (t?.preserve3d && !inContext)) {
      let local = own ? multiply4(multiply4(translate4(b.x, b.y), own), translate4(-b.x, -b.y)) : translate4(0, 0);
      const p = parent?.props.perspective?.value;
      if (p && parent) {
        const o = originOf(p.origin, parent.w, parent.h) ?? [parent.w / 2, parent.h / 2];
        const [ox, oy] = [parent.x + o[0], parent.y + o[1]];
        local = multiply4(multiply4(multiply4(translate4(ox, oy), perspective4(p.d)), translate4(-ox, -oy)), local);
      }
      next = inContext && chain.length ? [multiply4(chain[0], local), ...chain.slice(1)] : [local, ...chain];
    }
    for (const k of b.children) drawTransformed(k, next, b);
    if (next.length) {
      const r = projectRect(next, b.x, b.y, b.w, b.h);
      if (r) Object.assign(b, r);
      else b.assumptions.push("its 3D transform puts part of it behind the viewer, where Chromium clips it");
    }
  };
  for (const b of boxes) drawTransformed(b, [], undefined);

  // Uncertainty spreads: a box the engine can't guarantee (an assumption, an error, an element it
  // skipped) may have a different size, which moves its later siblings (every sibling in a cluster,
  // grid or layer, whose rows and lines it shares), resizes its parent, and so on up to the page.
  // Every box reached is flagged, so no prediction is presented as exact when it isn't.
  for (const b of walk(boxes)) {
    if (b.assumptions.length) sources.set(b, sources.get(b) ?? b.assumptions[0]);
    const e = issues.find((i) => i.severity === "error" && i.id === b.id);
    if (e) sources.set(b, sources.get(b) ?? e.message);
  }
  const flagged = new Map<Box, string>();
  const flag = (b: Box, why: string, deep: boolean) => {
    if (!flagged.has(b)) flagged.set(b, why);
    if (deep) for (const k of b.children) flag(k, why, true);
  };
  const spread: [Box, string, boolean][] = [...sources].map(([b, r]) => [b, r, true] as [Box, string, boolean]);
  for (const [src, reason, deep] of spread) {
    const why = `geometry depends on #${src.id}, which the engine can't guarantee (${reason})`;
    flag(src, `${reason}`, deep);
    for (let b: Box | undefined = src; b; b = parentOf.get(b)) {
      const parent = parentOf.get(b);
      const sibs = parent ? parent.children : boxes;
      // Siblings in a cluster, grid or layer share rows and lines; in a stack where some grow they share its extra height.
      const loose = parent && (!inLine(parent) || parent.children.some((k) => k.props.grow));
      const i = sibs.indexOf(b);
      sibs.forEach((s, j) => (j > i || (loose && j !== i)) && !absInfo.has(s) && flag(s, why, true));
      // An out-of-flow box doesn't resize or move what's around it.
      if (absInfo.has(b)) break;
      // A parent that is resized also moves its whole subtree when its own parent aligns it by size
      // (cluster lines, grid rows and the layer cell); in a stack or on the page it stays put.
      const grand = parent && parentOf.get(parent);
      if (parent) flag(parent, why, !!grand && !inLine(grand));
    }
  }
  // A transform maps everything inside its box about an origin that depends on the box's size (and
  // percentages of it): a transformed box that isn't guaranteed takes its whole subtree with it.
  for (const b of walk(boxes)) if (b.props.transform && flagged.has(b)) flag(b, flagged.get(b)!, true);
  // An out-of-flow box moves with its containing block (and its parent, at its static position).
  for (let changed = true; changed; ) {
    changed = false;
    for (const [b, a] of absInfo) {
      if (flagged.has(b)) continue;
      // (A page-level one at its static position sits below the page's in-flow boxes: any of them that isn't guaranteed moves it.)
      const pageDep = a.staticPos && !a.parent ? boxes.find((x) => x !== b && !absInfo.has(x) && flagged.has(x)) : undefined;
      // (At its static position it sits below the in-flow boxes before it in its parent: any of them that isn't guaranteed moves it too.)
      const sibDep = a.staticPos && a.parent ? a.parent.children.find((x) => x !== b && !absInfo.has(x) && flagged.has(x)) : undefined;
      const dep = (a.cb && flagged.has(a.cb) ? a.cb : undefined) ?? (a.staticPos && a.parent && flagged.has(a.parent) ? a.parent : undefined) ?? sibDep ?? pageDep;
      if (dep) {
        flag(b, `geometry depends on #${dep.id}, which the engine can't guarantee (${flagged.get(dep)})`, true);
        changed = true;
      }
    }
  }
  // (A box with an error of its own carries it as its reason, so every report counts it as approximate.)
  for (const [b, why] of flagged) if (!b.assumptions.length) b.assumptions.push(issues.find((i) => i.severity === "error" && i.id === b.id)?.message ?? why);


  // A box past the right edge of the viewport makes the page scroll sideways, unless a box around
  // it (or the page itself) clips or scrolls what doesn't fit. Reported once, on the outermost.
  if (!pg?.clipX) {
    const past = (b: Box) => b.x + b.w > layoutW + 0.5;
    // A box already reported as overflowing its parent isn't reported again.
    const overflowing = new Set(issues.flatMap((i) => /^#(\S+) overflows #/.exec(i.message)?.[1] ?? []));
    const visit = (b: Box) => {
      if (past(b) && overflowing.has(b.id)) return;
      // A fixed box stays in the window: it never makes the page scroll.
      if (b.props.position?.value.type === "fixed") return;
      if (past(b)) {
        const m = marginOf(b.props);
        const path = (m.right < 0 || m.left < 0 ? b.props.margin?.steps.at(-1)?.path : undefined) ?? b.props.width?.steps.at(-1)?.path ?? b.sourcePath;
        issues.push({
          severity: "warning",
          id: b.id,
          path,
          message: `#${b.id} extends ${fmtPx(b.x + b.w - layoutW)}px past the right edge of the viewport at ${width}px (to ${fmtPx(b.x + b.w)}px): the page scrolls sideways`,
        });
        return;
      }
      const ov = b.props.overflow?.value;
      if (ov && ov.x !== "visible") return;
      b.children.forEach(visit);
    };
    boxes.forEach(visit);
  }

  // What the page scrolls (its scrollable overflow): the root's box, its bottom margin included, and
  // every box in it a box around it doesn't clip or scroll (fixed boxes stay in the window).
  const extent = { w: 0, h: 0 };
  if (SB) {
    const pageEnd = bodyPad.bottom ? bodyPad.bottom + bodyMargin.bottom : sum(join(strut(bodyMargin.bottom), body.empty ? NONE : body.bottom));
    extent.h = outer.top + top + body.contentH + pageEnd + outer.bottom;
    const visit = (b: Box) => {
      if (b.props.position?.value.type === "fixed") return;
      extent.w = Math.max(extent.w, b.x + b.w);
      extent.h = Math.max(extent.h, b.y + b.h);
      const ov = b.props.overflow?.value;
      if ((ov && ov.x !== "visible") || b.props.contain?.value.paint) return;
      b.children.forEach(visit);
    };
    boxes.forEach(visit);
  }

  const pageBg = model.page?.background;
  return {
    width,
    active: activeBreakpoints(model, width).map((b) => b.name),
    boxes,
    issues,
    page: pageBg ? { background: model.tokens.get(`color.${pageBg.name}`)!.raw, path: pageBg.path } : undefined,
    notLaidOut: [...skippedEls.values()],
    scrollbar: SB,
    extent,
  };
}

export function* walk(boxes: Box[]): Generator<Box> {
  for (const b of boxes) {
    yield b;
    yield* walk(b.children);
  }
}
