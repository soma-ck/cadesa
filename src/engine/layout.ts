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
import type { Fixture, FixtureNode } from "../fixture.js";
import { containsLayout, scrolls, tokenKey, type Component, type Model, type PageSides, type Pattern, type Ref } from "../model.js";
import { activeBreakpoints, fmtPx, insets, layoutUnit, resolveElement, sizeAt, type Margins, type ResolvedProps, type Sides, type Track } from "../resolve.js";
import { layoutText, metricsFor, TEXT_EPS, type Line } from "./text.js";
import { layoutTable, tableGrid, tableInsets, tableIntrinsic, type Grid, type TableHooks } from "./table.js";

const EPS = 0.001;

export interface Box {
  id: string;
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
  /** Px this box's content extends past its content box horizontally. */
  overflowX?: number;
  /** Px this box's content extends past its fixed height. */
  overflowY?: number;
  assumptions: string[];
  children: Box[];
  /** A run of text the browser wraps in an anonymous box: laid out, but not an element (no DOM box to compare). */
  anonymous?: boolean;
  /** A cluster item on a line its items overfill (by their flex base sizes): they shrink, or overflow. */
  overfull?: boolean;
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
function offsetX(b: Box, cell: number): number {
  const m = marginOf(b.props);
  const free = cell - b.w - m.left - m.right;
  if (b.props.maxWidth && b.w < cell) return (cell - b.w) / 2;
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
  align: "start" | "center" | "end" | "stretch";
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
}

export function layout(model: Model, fixture: Fixture, width: number): Layout {
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
      b.x = offsetX(b, cell);
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
  /** The window's height: fixed boxes, and absolute ones with no positioned ancestor, are placed in it. */
  const windowH = model.page?.windowHeight ?? 800;

  /** Elements of the fixture (component roots and slots) that aren't laid out at all, with their descendants. */
  const skippedEls = new Map<FixtureNode, { id: string; tag: string; line?: number }>();
  const isBox = (n: FixtureNode) => n.classes.some((k) => k.startsWith(model.prefix) && (k.includes("__") || model.components.has(k.slice(model.prefix.length))));
  const notLaidOut = (n: FixtureNode) => {
    if (isBox(n) && !skippedEls.has(n)) skippedEls.set(n, { id: n.fixtureId ?? n.tag, tag: n.tag, ...(n.line && { line: n.line }) });
    n.children.forEach(notLaidOut);
  };
  /** Boxes the engine can't guarantee beyond their own assumptions and errors, and why. */
  const sources = new Map<Box, string>();
  /**
   * Scrollbars that take space where they aren't overlaid (Windows, many Linux setups; Cadesa
   * predicts overlay scrollbars, as on macOS and phones): a horizontal one makes its box taller (the
   * box and what's around it may move, not its content), a vertical one narrows its content.
   */
  const scrollbars = new Map<Box, { taller?: string; narrower?: string }>();
  let auto = 0;
  const idOf = (n: FixtureNode) => n.fixtureId ?? `${n.tag}#${++auto}`;

  /** Measure the text of a leaf box. Returns undefined when the font has no metrics. */
  function text(n: FixtureNode, props: ResolvedProps, id: string, assumptions: string[]) {
    const t = props.text!.value;
    const m = metricsFor(t.font);
    const raw = n.runs.length ? n.runs : [n.text];
    const runs = raw.map((r) => (t.uppercase ? r.toUpperCase() : r));
    const shown = [...runs, ...n.runMeta.flatMap((r) => (r.lead ? [r.lead.text] : []))].join(" ");
    const why = !m
      ? `font "${(t.font ?? "inherited").split(",")[0]}" has no Cadesa metrics; cadesa fonts (MCP: cadesa_fonts) finds the page's fonts and measures them`
      : m.unsupported(shown).length
        ? `characters outside the measured set: ${m.unsupported(shown).map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ")}`
        : [t.weight, ...n.runMeta.flatMap((r) => (r.spans ?? []).flatMap((sp) => (sp.weight === undefined ? [] : [sp.weight])))].map((wt) => m.weightIssue(wt)).find(Boolean);
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
    const contextual = /[*@<>\\]/.test(shown) ? shown.match(/[*@<>\\]/)![0] : /\d ?[xX] ?\d/.test(shown) ? "x between digits" : undefined;
    if (contextual) assumptions.push(`text width is approximate: "${contextual}" has contextual forms that Cadesa doesn't measure`);
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
    const spans = raw.map((r, i) => meta[i].spans?.map((sp) => ({ ...sp, from: moved(r, sp.from), to: moved(r, sp.to) })));
    // A float at the start of a run: as wide as its text (rounded up to a layout unit) plus its edges.
    const leads = meta.map((r) => {
      if (!r.lead) return undefined;
      const lt = t.uppercase ? r.lead.text.toUpperCase() : r.lead.text;
      const one = layoutText(m!, lt, t.sizePx, r.lead.weight ?? t.weight, Infinity, { letterSpacing: t.letterSpacing, hangKern: false });
      return Math.ceil(one.maxContent * 64 - TEXT_EPS) / 64 + r.lead.extra;
    });
    let ambiguous = false;
    let anywhereFlagged = false;
    // A <button> centers its text unless the role says otherwise (the reset leaves text-align alone).
    const align = props.textAlign?.value ?? (n.tag === "button" ? "center" : "start");
    // Each run (paragraph, list item, line after <br>) starts on a new line.
    return (maxWidth: number) => {
      const parts = runs.map((r, i) => {
        const opts = { letterSpacing: t.letterSpacing, spacesOnly, wrapAnywhere: t.wrapAnywhere, breakWord: t.breakWord, items: items[i], spans: spans[i], lead: leads[i] };
        // white-space: nowrap: the paragraph is one line, and its min-content is its whole width.
        if (t.nowrap) {
          const one = layoutText(m!, r, t.sizePx, t.weight, Infinity, { ...opts, wrapAnywhere: false, hangKern: false });
          return { ...one, minContent: one.maxContent, widestPiece: r.trim() };
        }
        // Centered or end-aligned lines measure their hanging space's kerning out too.
        const plain = t.underline || (!!painted && !meta[i].inBlock) || align !== "start" || t.nowrap;
        const a = layoutText(m!, r, t.sizePx, t.weight, maxWidth, { ...opts, hangKern: !plain });
        if (a.approximate && !anywhereFlagged) {
          anywhereFlagged = true;
          assumptions.push(`line breaks are approximate: ${a.approximate}`);
        }
        if (!plain && meta[i].underlined && !ambiguous) {
          const b = layoutText(m!, r, t.sizePx, t.weight, maxWidth, { ...opts, hangKern: false });
          if (b.lines.length !== a.lines.length || b.lines.some((l, k) => l.text !== a.lines[k].text) || Math.abs(b.minContent - a.minContent) > 1e-9) {
            ambiguous = true;
            assumptions.push("line breaks are approximate: a space at a line end inside underlined inline text (a link) changes the line's width");
          }
        }
        return a;
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
    content: (k) => {
      const it = intrinsic(k.node, k.comp, k.slot, true);
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
    const p = resolveElement(model, c, slot, width);
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
      const t = tableIntrinsic(gridOf(n, c, p), true);
      if (t.why) return unknown(t.why);
      const w = typeof pw === "number" ? Math.max(pw, t.min) : undefined;
      return w !== undefined ? { min: w, max: w } : { min: t.min, max: Math.max(t.min, Math.min(t.max, cap)) };
    }
    if (typeof pw === "number") {
      const w = Math.max(insX, Math.min(pw, cap));
      return { min: w, max: w };
    }
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
      for (const k of kids) {
        const ki = intrinsic(k.node, k.comp!, k.slot);
        if (ki.why) return ki;
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
      const p = resolveElement(model, k.comp, k.slot, width);
      const km: Margins = { ...marginOf(p) };
      const out = km.left + km.right;
      const kins = insets(p);
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
      const content = () => (intr ??= intrinsic(k.node, k.comp, k.slot, true));
      const cannot = (why: string) => {
        errors.push({ path: kpath, message: (id) => (g?.basis === "zero" && pw !== undefined ? `#${id} grows from zero in a cluster, and the minimum width of its content can't be measured (${why})` : `#${id} sits in a cluster without a width, and its content can't be measured (${why}); ${say("give it a size token width", "give it a width in px or rem")}`) });
      };
      if (typeof pw === "number") base = pw;
      else if (pw !== undefined && typeof pw === "object") base = sizeAt(pw, innerW);
      else if (pw === "fill") {
        if (p.width) errors.push({ path: p.width.steps.at(-1)!.path, message: (id) => say(`#${id} has width: fill inside a cluster; fill only stretches inside a stack`, `#${id} is as wide as its flex row (width: 100%) next to other items`) });
        base = innerW;
      } else if (pw === "fit") {
        const it = content();
        if (it.why) cannot(it.why);
        else base = Math.min(it.max, Math.max(it.min, innerW - out));
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
        const it = intrinsic(k.node, k.comp, k.slot, true);
        const specified = typeof pw === "number" ? pw : pw !== undefined && typeof pw === "object" ? sizeAt(pw, innerW) : pw === "fill" ? innerW : Infinity;
        if (it.why) cannot(it.why);
        else {
          min = Math.max(insX, Math.min(it.min, specified));
          minKnown = true;
        }
        base = insX;
      }
      // A scroll container's automatic minimum width is 0: it shrinks below its content (which then scrolls or is clipped).
      if (scrolls(p.overflow?.value)) {
        min = insX;
        minKnown = true;
      }
      min = Math.min(min, Math.max(cap, insX));
      // The flex base size is never below the padding and border (its content size is at least 0).
      base = Math.max(base, insX);
      const hyp = Math.max(Math.min(base, cap), g?.basis === "zero" ? min : 0, insX);
      // An aspect box that grows: its minimum width also follows its height, which isn't modelled.
      if (g && p.aspect) notes.push("grow on a box with an aspect ratio: its minimum width also follows its height, which isn't modelled");
      // flex-shrink: 1 unless a width is set (Cadesa compiles flex: none with it).
      const shrinkable = !(typeof pw === "number" || (pw !== undefined && typeof pw === "object") || (pw === "fill" && p.width) || pw === "fit");
      return { k, p, km, out, base, hyp, min, cap, insX, shrink: shrinkable, shrinkUnknown: shrinkable && !minKnown, wraps, intr, factor: g?.factor ?? 0, notes, errors };
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
        ln.map((it) => ({ base: U(it.base), hyp: U(it.hyp), factor: it.factor, shrink: it.shrink ? 1 : 0, pad: U(it.insX), min: U(it.min), max: it.cap === Infinity ? Infinity : U(it.cap), out: U(it.out) })),
        U(innerW),
        U(gap),
      );
      const sizes = flexed ? flexed.map(PX) : ln.map((it) => it.hyp);
      ln.forEach((it, i) => {
        if (it.shrinkUnknown && sizes[i] < it.hyp - EPS) it.notes.push("it shrinks in its row, down to a minimum width the engine doesn't measure (an aspect ratio)");
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
        const it = intrinsic(k.node, k.comp, k.slot);
        if (it.why) {
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
      const p = resolveElement(model, a.k.comp, a.k.slot, width);
      const pos = p.position!.value;
      let cbBox: Box | undefined;
      for (let x = a.parent; x; x = parentOf.get(x))
        if (containingBlock(x, pos.type)) {
          cbBox = x;
          break;
        }
      const bw = (b: Box) => b.props.border?.value.widths ?? { top: 0, right: 0, bottom: 0, left: 0 };
      const cb = cbBox ? { x: cbBox.x + bw(cbBox).left, y: cbBox.y + bw(cbBox).top, w: cbBox.w - bw(cbBox).left - bw(cbBox).right, h: cbBox.h - bw(cbBox).top - bw(cbBox).bottom } : { x: 0, y: 0, w: width, h: windowH };
      const at = (v: number | { pct: number } | undefined, base: number) => (v === undefined ? undefined : sizeAt(v, base));
      const [l, r, t, b] = [at(pos.left, cb.w), at(pos.right, cb.w), at(pos.top, cb.h), at(pos.bottom, cb.h)];
      const m = marginOf(p);
      const ins = insets(p);
      const notes: string[] = [];
      // Width.
      const pw = p.width?.value;
      const cap = p.maxWidth ? sizeAt(p.maxWidth.value, cb.w) : p.measure ? sizeAt(p.measure.value, cb.w) : Infinity;
      let w: number;
      if (typeof pw === "number" || (pw !== undefined && typeof pw === "object")) w = sizeAt(pw, cb.w);
      else if (pw === "fill") w = cb.w;
      else if (l !== undefined && r !== undefined && pw !== "fit") w = cb.w - l - r - m.left - m.right;
      else {
        const avail = cb.w - (l ?? 0) - (r ?? 0) - m.left - m.right;
        const it = intrinsic(a.k.node, a.k.comp, a.k.slot, true);
        if (it.why) {
          notes.push(`an absolutely positioned box is as wide as its content, which can't be measured here (${it.why})`);
          w = Math.max(0, avail);
        } else w = Math.min(it.max, Math.max(it.min, avail));
      }
      w = Math.max(ins.left + ins.right, Math.min(w, cap));
      if (p.aspect) notes.push("an absolutely positioned box with an aspect ratio isn't modelled");
      const box = measure(a.k.node, a.k.comp, a.k.slot, w, "abs", w);
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

  function measure(n: FixtureNode, c: Component, slot: string | undefined, avail: number, parent: ParentKind, forcedW?: number, over?: Partial<ResolvedProps>): Box {
    const id = idOf(n);
    let props = resolveElement(model, c, slot, width);
    // A table cell's border as its table lays it out (table.ts); a collapsed table's own border and padding.
    if (over) props = { ...props, ...over };
    const grid = props.pattern?.value === "table" ? gridOf(n, c, props) : undefined;
    if (grid?.collapse) {
      const t = tableInsets(grid);
      props = { ...props, padding: undefined, border: props.border || Object.values(t.border).some(Boolean) ? { value: { color: props.border?.value.color ?? "transparent", widths: t.border }, display: "collapsed", steps: props.border?.steps ?? [] } : undefined };
    }
    const sourcePath = slot ? `${c.path}.slots.${slot}` : c.path;
    const assumptions: string[] = [];
    const ins = insets(props);
    const insX = ins.left + ins.right;
    const insY = ins.top + ins.bottom;

    const classed = classedOf(n, c);
    const isText = !!props.text && classed.length === 0;
    const measureText = isText && n.text ? text(n, props, id, assumptions) : undefined;

    const m = marginOf(props);
    if (props.maxWidth && (m.left || m.right || m.autoLeft || m.autoRight))
      issues.push({
        severity: "error",
        id,
        path: props.margin!.steps.at(-1)!.path,
        message: say(`#${id} has maxWidth (centered by auto inline margins) and a left or right margin; keep one of them`, `#${id} has a max-width centered by auto margins and a left or right margin, which Cadesa doesn't combine`),
      });
    if ((parent === "grid" || parent === "layer") && (m.autoLeft || m.autoRight))
      issues.push({ severity: "error", id, path: props.margin!.steps.at(-1)!.path, message: `#${id} has an auto margin in a ${parent}; auto margins are modelled in block flow, stacks and clusters` });

    // ---- width
    let w: number;
    const pw = props.width?.value;
    const maxW = Math.min(props.maxWidth ? sizeAt(props.maxWidth.value, avail) : Infinity, props.measure ? sizeAt(props.measure.value, avail) : Infinity);
    /** fit-content in `room`: the content's max-content width, at most the room, at least its min-content. */
    const fit = (room: number, what: string): number => {
      const it = intrinsic(n, c, slot, true);
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
      else if (pw === "fit") {
        w = fit(Math.max(0, avail - m.left - m.right), "is as wide as its content (width: fit)");
        if (props.aspect) assumptions.push("width: fit with an aspect ratio: the browser also sizes it from its height, which isn't modelled");
      }
      // Auto margins across a stack (a column flexbox) switch off stretching: it's as wide as its content.
      else if (parent === "stack" && pw === undefined && (m.autoLeft || m.autoRight) && !props.maxWidth && !props.aspect)
        w = fit(Math.max(0, avail - m.left - m.right), "has an auto margin in a stack, which sizes it to its content");
      else if (pw === "fill" || props.aspect || props.maxWidth) w = avail; // width: 100%
      // A table without a width is as wide as its columns want (fit-content), unless a flex column or grid stretches it.
      else if (grid && pw === undefined && parent !== "stack" && parent !== "grid" && parent !== "layer") w = fit(Math.max(0, avail - m.left - m.right), "is a table as wide as its content");
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
    const throughTop = inFlow && ins.top === 0 && !scroller;
    const throughBottom = inFlow && ins.bottom === 0 && !props.height && !props.minHeight && !props.aspect && !scroller;
    let escaped: FlowResult | undefined;
    let grows: StackGrow | undefined;
    /** A table's border box height, captions included (table.ts). */
    let tableH: number | undefined;

    if (grid) {
      // Given its width by a flex or grid container (not shrunk to fit): its columns share exactly that.
      const fixedW = forcedW !== undefined && (parent === "cluster" || parent === "grid" || parent === "layer" || parent === "stack");
      const cssH = props.height || props.minHeight ? Math.max(props.height?.value ?? 0, props.minHeight?.value ?? 0) : undefined;
      const t = layoutTable(grid, w, fixedW || ((parent === "stack" || parent === "grid" || parent === "layer") && pw === undefined), cssH);
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
    } else if (kids.length && pattern === "grid") {
      const { colW, colX } = props.columns ? tracks(props.columns.value, kids, innerW, gap, assumptions) : autoFill(props.min!.value, innerW, gap);
      const cols = colW.length;
      const justify = props.justifyItems?.value ?? "stretch";
      const measured = kids.map((k, j) => {
        const cw = colW[j % cols];
        if (justify === "stretch") return measure(k.node, k.comp, k.slot, cw, "grid");
        // Not stretched: as wide as its content (fit-content in its column), unless it sets a width.
        const kp = resolveElement(model, k.comp, k.slot, width);
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
      kids.forEach((k, i) => {
        const b = measure(k.node, k.comp, k.slot, innerW, "stack");
        const km = marginOf(b.props);
        b.x = offsetX(b, innerW);
        b.y = y + km.top;
        y += km.top + b.h + km.bottom + (i < kids.length - 1 ? gap : 0);
        children.push(b);
      });
      contentH = y;
      if (children.some((b) => b.props.grow)) grows = { kids: children, gap, insetTop: ins.top, insetY: insY, natural: children.map((b) => b.h) };
    } else if (kids.length && pattern === "flow") {
      // A box sized by its aspect ratio keeps its last child's bottom margin neither inside nor out (Chromium drops it).
      const end = throughBottom ? "escape" : inFlow && !scroller && ins.bottom === 0 && props.aspect && !props.height ? "drop" : "keep";
      const f = flow(kids.map((k) => measure(k.node, k.comp, k.slot, innerW, "flow")), innerW, throughTop, end);
      children.push(...f.boxes);
      contentH = f.contentH;
      escaped = f;
    } else if (kids.length && pattern === "cluster") {
      rows = cluster(kids, innerW, gap, props.justify?.value ?? "start", props.wrap?.value === false);
    } else if (isText && n.text) {
      const t = props.text!.value;
      const lineH = lineHeightPx(t.sizePx, t.lineHeight);
      if (measureText) {
        const tl = measureText(innerW);
        lines = tl.lines;
        contentH = lines.length * lineH;
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
      contentH = rows.reduce((s, r) => s + Math.max(0, ...r.map(outerH)), 0) + rowGap * (rows.length - 1);
    }

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
    // Without aspect (whose width: 100% wins), a media element with only a height takes its width
    // from its width attribute, or at the page level from the file's own ratio, instead of stretching.
    if (media && props.height && !props.aspect && (pw === undefined || pw === "fill") && !props.maxWidth && parent !== "cluster") {
      if (n.attrs.width) assumptions.push(`its width comes from the width="${n.attrs.width}" attribute, not the layout; ${say("add aspect or a width token", "give it a width or an aspect-ratio")}`);
      else if (parent === "page" || parent === "flow") assumptions.push(`${parent === "page" ? "at the page level" : "in block flow"} its width follows the image file; ${say("add aspect or a width token", "give it a width or an aspect-ratio")}`);
    }
    // A form control is as wide as its content unless something sets its width.
    if ((parent === "page" || parent === "flow") && CONTROLS.has(n.tag) && (pw === undefined || pw === "fill") && !props.maxWidth)
      assumptions.push(`a <${n.tag}> ${parent === "page" ? "at the page level" : "in block flow"} is as wide as its content; ${say("give it a width token or maxWidth", "give it a width")}`);
    if (media && !props.aspect && !props.height)
      issues.push({
        severity: "warning",
        id,
        path: sourcePath,
        message: `<${n.tag}> #${id} has no aspect or height, so its size depends on ${n.attrs.width || n.attrs.height ? "its width/height attributes and the file" : "the file"} and can't be predicted; ${say(`add aspect: "16:9" (or height)`, "give it an aspect-ratio (or a height)")}`,
      });
    if (media && !props.aspect && !props.height) assumptions.push("its size depends on the image file (no aspect or height)");
    const box: Box = {
      id,
      tag: n.tag,
      component: c.name,
      slot,
      sourcePath,
      fixtureLine: n.line,
      attrs: n.attrs,
      x: 0,
      y: 0,
      w,
      h,
      props,
      text: isText ? n.text || undefined : undefined,
      lines,
      assumptions,
      children,
      ...(n.anonymous && { anonymous: true }),
    };
    // A block with nothing in it (no height, padding, border, lines or non-empty child) lets its
    // own top and bottom margins collapse through it (an aspect-ratio box that comes out 0 tall too).
    // Flex and grid containers, form controls,
    // media and <hr> (overflow: hidden) never do.
    const empty =
      h === 0 && insY === 0 && !props.height && !media && !CONTROLS.has(n.tag) && n.tag !== "hr" && !scroller &&
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
        heights: rows.map((r) => Math.max(0, ...r.map(outerH))),
        gap: rowGap,
        ...(props.rowGap?.pct !== undefined && { gapPct: props.rowGap.pct }),
        align: props.align?.value ?? (pattern === "cluster" ? "center" : "stretch"),
        insetTop: ins.top,
        insetY: insY,
        flexLines: pattern === "cluster",
        oneLine: pattern === "cluster" && props.wrap?.value === false,
      });
    if (rows || grows) arrange(box);
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
    const where = "where scrollbars aren't overlaid (Windows, many Linux setups)";
    const sb: { taller?: string; narrower?: string } = {};
    if (!props.height && !props.aspect && (ov?.x === "scroll" || (ov?.x === "auto" && widest > innerW + 0.5)))
      sb.taller = ov.x === "scroll" ? `overflow-x: scroll always shows a horizontal scrollbar, which adds height ${where}` : `its content is wider than it at ${width}px and scrolls (overflow-x: auto): a horizontal scrollbar adds height ${where}`;
    if (ov?.y === "scroll" || (ov?.y === "auto" && props.height && contentH > props.height.value - insY + 0.5))
      sb.narrower = ov.y === "scroll" ? `overflow-y: scroll always shows a vertical scrollbar, which takes width from its content ${where}` : `its content is taller than its height at ${width}px and scrolls (overflow-y: auto): a vertical scrollbar takes width from its content ${where}`;
    if (sb.taller || sb.narrower) scrollbars.set(box, sb);
    if (clipsX && widest > innerW + 0.5) box.overflowX = widest - innerW;
    else if (widest > innerW + 0.5 && children.length) {
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
    return box;
  }

  /**
   * Place the rows of a grid, cluster or layer inside its final height. A container taller than its
   * content (a fixed height, an aspect ratio, or stretched by its own parent) shares the extra
   * height equally between its rows: grid auto tracks stretch, and so do the lines of a wrapping
   * flex container (align-content: normal). Children are then aligned within their row.
   */
  function arrange(b: Box) {
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
        // stretch grows every item without a fixed height, aspect ratio or not.
        if (a.align === "stretch" && !c.props.height) {
          // In a one-line cluster the line may be shorter than the item: stretching then shrinks it (its content overflows).
          const target = rowH - m.top - m.bottom;
          if (a.oneLine && target < c.h) {
            c.h = Math.max(target, insets(c.props).top + insets(c.props).bottom);
            arrange(c);
          } else grow(c, target);
          // A stretched item's height is definite: percentages of it resolve.
          fillPct(c);
        }
        const space = rowH - outerH(c);
        c.y = y + m.top + (a.align === "center" ? space / 2 : a.align === "end" ? space : 0);
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
    const sizes = flexLine(items, U(inner), U(g.gap));
    let y = 0;
    g.kids.forEach((k, i) => {
      const m = marginOf(k.props);
      const h = sizes ? PX(sizes[i]) : g.natural[i];
      if (h > k.h) grow(k, h);
      k.y = y + m.top;
      y += m.top + k.h + m.bottom + g.gap;
    });
  }

  /** A box stretched taller after its own layout: its rows (if any) are placed again. */
  function grow(b: Box, newH: number) {
    if (newH <= b.h) return;
    // A table stretched taller shares the height between its rows, which isn't modelled.
    if (b.props.pattern?.value === "table" && newH > b.h + EPS) b.assumptions.push("a table stretched taller than its rows (by a flex or grid container) shares the extra height between them, which isn't modelled");
    b.h = newH;
    arrange(b);
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
  const pageW = Math.max(0, width - outer.left - outer.right - bodyMargin.left - bodyMargin.right - bodyPad.left - bodyPad.right);

  const boxes: Box[] = [];
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
      const entry: (typeof absQueue)[number] = { k: { node: n, comp: c, slot: undefined }, parent: undefined, ...(!boxes.length && { at: { x: 0, y: 0 } }) };
      absQueue.push(entry);
      if (boxes.length && !unknownOnPage) pageAbs.push({ entry, before: boxes.length });
      continue;
    }
    boxes.push(measure(n, c, undefined, pageW, "page"));
  }
  // The body is block flow: page-level boxes stack, their margins collapsing. Its own top margin
  // collapses with theirs unless its padding separates them, so the body starts below the largest
  // (below all of them when every page-level box is empty); the root element contains it.
  const through = bodyPad.top === 0;
  const body = flow(boxes, pageW, through, "escape");
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
  for (const [src, sb] of scrollbars) if (sb.narrower) for (const k of src.children) flag(k, `its width depends on #${src.id}'s scrollbar (${sb.narrower})`, true);
  const spread: [Box, string, boolean][] = [...[...sources].map(([b, r]) => [b, r, true] as [Box, string, boolean]), ...[...scrollbars].filter(([, sb]) => sb.taller).map(([b, sb]) => [b, sb.taller!, false] as [Box, string, boolean])];
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
  // An out-of-flow box moves with its containing block (and its parent, at its static position).
  for (let changed = true; changed; ) {
    changed = false;
    for (const [b, a] of absInfo) {
      if (flagged.has(b)) continue;
      const dep = (a.cb && flagged.has(a.cb) ? a.cb : undefined) ?? (a.staticPos && a.parent && flagged.has(a.parent) ? a.parent : undefined);
      if (dep) {
        flag(b, `geometry depends on #${dep.id}, which the engine can't guarantee (${flagged.get(dep)})`, true);
        changed = true;
      }
    }
  }
  for (const [b, why] of flagged) if (!b.assumptions.length && !issues.some((i) => i.severity === "error" && i.id === b.id)) b.assumptions.push(why);


  // A box past the right edge of the viewport makes the page scroll sideways, unless a box around
  // it (or the page itself) clips or scrolls what doesn't fit. Reported once, on the outermost.
  if (!pg?.clipX) {
    const past = (b: Box) => b.x + b.w > width + 0.5;
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
          message: `#${b.id} extends ${fmtPx(b.x + b.w - width)}px past the right edge of the viewport at ${width}px (to ${fmtPx(b.x + b.w)}px): the page scrolls sideways`,
        });
        return;
      }
      const ov = b.props.overflow?.value;
      if (ov && ov.x !== "visible") return;
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
  };
}

export function* walk(boxes: Box[]): Generator<Box> {
  for (const b of boxes) {
    yield b;
    yield* walk(b.children);
  }
}
