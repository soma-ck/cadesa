/** The validated Cadesa document. Every value remembers the YAML path it came from. */

export const ROOT_FONT_PX = 16;

export interface Length {
  raw: string;
  px: number;
  /** A length that follows the viewport width (vw, clamp()...): its px at a viewport width. `px` is its value at 1280px. */
  fluid?: (viewport: number) => number;
}

export type TokenCategory = "space" | "size" | "color" | "radius" | "font" | "paint" | "shadow";
export const TOKEN_CATEGORIES: TokenCategory[] = ["space", "size", "color", "radius", "font", "paint", "shadow"];
export const LENGTH_CATEGORIES = new Set<TokenCategory>(["space", "size", "radius"]);

export interface Token {
  category: TokenCategory;
  name: string;
  path: string;
  raw: string;
  /** Pixel value for length tokens (not for a percentage size token). */
  px?: number;
  /** A length token that follows the viewport width (vw, clamp()...): its px at a viewport width (`px` is its value at 1280px). */
  fluid?: (viewport: number) => number;
  /** A size token in percent ("50%"): of the containing block's content width. */
  pct?: number;
  /**
   * A size token with percentages inside calc(), min(), max() or clamp() ("min(440px, 100%)"): its
   * px at a viewport width for a containing block content width (`base`), as Chromium evaluates it.
   */
  calc?: (viewport: number, base: number) => number;
}

/** A size token that is (or has) a percentage of the containing block's width. */
export const relative = (t: Token) => t.pct !== undefined || !!t.calc;

export interface TextRole {
  name: string;
  path: string;
  font?: Ref;
  size: Length;
  weight: number;
  lineHeight: number;
  color: Ref;
  decoration?: "none" | "underline";
  /** In em; measured exactly (added after every character, as browsers do). */
  letterSpacing?: number;
  transform?: "uppercase" | "none";
  /**
   * "anywhere": a word too long for a line breaks between characters (overflow-wrap: anywhere), and
   * the text's min-content width counts single characters. "break-word": the same breaking, but the
   * min-content width counts whole words (overflow-wrap: break-word). "none": never wraps
   * (white-space: nowrap).
   */
  wrap?: "anywhere" | "break-word" | "none" | "normal";
}

export interface Breakpoint {
  name: string;
  path: string;
  length: Length;
}

/** A reference to a named token or text role. */
export interface Ref {
  kind: TokenCategory | "text";
  name: string;
  path: string;
}

export type GridTrack = { size: Ref } | { fr: number; auto: boolean };

/**
 * flow: block flow (display: block); vertical margins collapse between siblings and through the box.
 * table: a table (display: table); its children are table parts (see Props.part).
 */
export type Pattern = "stack" | "cluster" | "grid" | "layer" | "flow" | "table";

export type Align = "start" | "center" | "end" | "stretch";
/** Where a cluster puts the free space of each line (justify-content). */
export type Justify = "start" | "end" | "center" | "between" | "around" | "evenly";
export type TextAlign = "start" | "center" | "end";

export interface LayoutProp {
  path: string;
  pattern: Pattern;
  /** A space token, or for a cluster or grid a percentage size token: of its content width, between columns only (rows: rowGap, else 0). */
  gap?: Ref;
  /** Grid and cluster: the gap between rows (lines) when it differs from the gap between columns. */
  rowGap?: Ref;
  /** Cross-axis alignment: cluster (default center), grid and layer (default stretch). Not for stack. */
  align?: Align;
  /** Grid: minimum column width; columns auto-fill the row. Table: its minimum width (min-width). */
  min?: Ref;
  /**
   * Grid only, instead of min: the column tracks (grid-template-columns). A size token is a fixed
   * column; `{ fr }` shares what is left in proportion (minmax(0, <n>fr)); `{ fr, auto: true }` is
   * CSS's plain `<n>fr`, never narrower than its items' min-content width.
   */
  columns?: GridTrack[];
  /** Grid only: where items sit across their column (justify-items; default stretch). */
  justifyItems?: "start" | "center" | "end" | "stretch";
  /** Cluster only: where each line's free space goes (default start). */
  justify?: Justify;
  /** Cluster only: false keeps every item on one line, shrinking them to fit (flex-wrap: nowrap). */
  wrap?: boolean;
  /**
   * Grid only, instead of min or columns: CSS's grid template as written (tracks in px, %, fr,
   * auto, min-content, max-content, minmax(), fit-content(), repeat() and [line names]), placed
   * and sized as Chromium's grid does. Items may place themselves (`place`).
   */
  template?: GridTemplateProp;
  /** Table only: collapsed borders (border-collapse: collapse); no gap between cells then. */
  collapse?: boolean;
  /** Table only: column widths from the first row and the column elements (table-layout: fixed). */
  fixed?: boolean;
}

export interface GridTemplateProp {
  columns?: string;
  rows?: string;
  /** grid-template-areas, one string per row. */
  areas?: string[];
  autoColumns?: string;
  autoRows?: string;
  /** grid-auto-flow (row only; dense fills earlier holes). */
  dense?: boolean;
  /** justify-content / align-content: where the tracks sit when they don't fill the grid. */
  justifyContent?: string;
  alignContent?: string;
}

/** Where an item sits in its grid: grid-row and grid-column as CSS writes them ("1 / -1", "span 2", "sidebar"), and its own alignment. */
export interface PlaceProp {
  path: string;
  row?: string;
  column?: string;
  /** align-self and justify-self in a grid (start, center, end, stretch). */
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "stretch";
}

/** What a child of a table is (CSS's table display types). */
export type TablePart = "caption" | "column" | "column-group" | "header" | "body" | "footer" | "row" | "cell";
export const TABLE_PARTS: TablePart[] = ["caption", "column", "column-group", "header", "body", "footer", "row", "cell"];
/** Where a cell's content sits in its row (vertical-align). */
export type CellAlign = "baseline" | "top" | "middle" | "bottom";

/**
 * A part value: `cell middle`, `caption bottom`, `row`; undefined when invalid. A cell may also be
 * `content-box`: its width and height don't include its padding and border (CSS's box-sizing:
 * content-box), which in a table with collapsed borders depend on its neighbours'.
 */
export function parsePart(v: string): { part: TablePart; align?: CellAlign; side?: "top" | "bottom"; contentBox?: boolean } | undefined {
  const [part, ...mods] = v.trim().toLowerCase().split(/\s+/);
  if (!TABLE_PARTS.includes(part as TablePart)) return undefined;
  const out: { part: TablePart; align?: CellAlign; side?: "top" | "bottom"; contentBox?: boolean } = { part: part as TablePart };
  for (const m of mods) {
    if (part === "cell" && ["baseline", "top", "middle", "bottom"].includes(m) && !out.align) out.align = m as CellAlign;
    else if (part === "cell" && m === "content-box" && !out.contentBox) out.contentBox = true;
    else if (part === "caption" && (m === "top" || m === "bottom") && !out.side) out.side = m;
    else return undefined;
  }
  return out;
}

/**
 * Inner spacing per side (space tokens; a missing side is 0). `padding: s` sets every side,
 * `{ block, inline }` each axis, `{ top, right, bottom, left }` each side (a side beats its axis).
 */
export interface PaddingProp {
  path: string;
  top?: Ref;
  right?: Ref;
  bottom?: Ref;
  left?: Ref;
}

/**
 * A solid border. `border: line` is 1px on every side; `{ color, width, top, right, bottom, left }`
 * gives the widths (space tokens): `width` every side, a side beats it, a missing side is 0.
 */
export interface BorderProp {
  path: string;
  color: Ref;
  /** Per side; undefined: the 1px default (`border: <color>`). */
  sides?: { top?: Ref; right?: Ref; bottom?: Ref; left?: Ref };
}

/** A margin side: a space token (may be negative) or auto (left and right only). */
export type MarginSide = Ref | { auto: true; path: string };
export const isAuto = (m: MarginSide | undefined): m is { auto: true; path: string } => !!m && "auto" in m;

/**
 * Outer spacing per side (space tokens; a missing side is 0). `margin: s` sets every side,
 * `{ block, inline }` each axis, `{ top, right, bottom, left }` each side (a side beats its axis).
 */
export interface MarginProp {
  path: string;
  top?: MarginSide;
  right?: MarginSide;
  bottom?: MarginSide;
  left?: MarginSide;
}

/** Props an override can remove (`maxWidth: none`): the element is then as if it never had them. */
export const UNSETTABLE = ["padding", "margin", "background", "backdrop", "border", "shadow", "radius", "maxWidth", "measure", "width", "height", "minHeight", "aspect", "grow", "transform", "text"] as const;
export type Unsettable = (typeof UNSETTABLE)[number];

export interface Props {
  layout?: LayoutProp;
  padding?: PaddingProp;
  margin?: MarginProp;
  background?: Ref;
  border?: BorderProp;
  radius?: Ref;
  maxWidth?: Ref;
  /** Max width that stays left-aligned (a line length), unlike maxWidth, which centers. */
  measure?: Ref;
  /** fill: the parent's full width; fit: shrink-to-fit (its content's width, at most the parent's). */
  width?: Ref | { keyword: "fill" | "fit" | "max-content" | "min-content"; path: string };
  height?: Ref;
  /** The least height (min-height): the box is as tall as its content or its height, and never less. */
  minHeight?: Ref;
  /** Width / height ratio; height follows the width (images, media, cards). */
  aspect?: { value: number; raw: string; path: string };
  /** How an image fills an aspect box. Paint only. */
  fit?: { value: "cover" | "contain"; path: string };
  /** Gradient or image painted over the background color. Paint only. */
  backdrop?: Ref;
  shadow?: Ref;
  text?: Ref;
  textAlign?: { value: TextAlign; path: string };
  /**
   * In a cluster or stack: grows into the line's free space, in proportion to the number (flex-grow).
   * basis zero: the free space is shared from nothing (flex-basis: 0, so equal shares), never below
   * the content's min-content width; content (default): from the box's own size.
   */
  grow?: { value: number; basis: "zero" | "content"; path: string };
  /**
   * What happens to content that doesn't fit, per axis, as computed (a visible axis next to a
   * scrolling one computes to auto, clip to hidden). Anything but visible and clip makes a scroll
   * container: a new block formatting context (margins don't collapse through it) whose automatic
   * minimum size in a flex row is 0. Overflowing content scrolls or is cut off, never spills out.
   */
  overflow?: { x: Overflow; y: Overflow; raw: string; path: string };
  /**
   * Positioning. relative: in flow, shifted by its offsets (its siblings don't move); absolute: out
   * of flow, placed by its offsets in the padding box of its nearest positioned ancestor (else the
   * window); fixed: in the window. Offsets are space tokens (may be negative) or percentage size
   * tokens (of the containing block's width for left/right, its height for top/bottom). height: an
   * absolute box's height as a percentage size token of its containing block's height.
   */
  position?: { type: PositionType; top?: Ref; right?: Ref; bottom?: Ref; left?: Ref; height?: Ref; path: string };
  /**
   * Containment (CSS contain). layout or paint: an independent formatting context (margins don't
   * collapse through it) and the containing block of its absolute and fixed descendants; paint also
   * clips what overflows it. size: sized as if empty on both axes (its height is its padding and
   * border unless set, its intrinsic widths too); inline: on the inline axis only (its intrinsic
   * widths). style never moves a box. none: in a breakpoint override, no containment.
   */
  contain?: Contain & { raw: string; path: string };
  /**
   * A 2D transform (CSS transform functions; translate, rotate and scale first) about `origin`
   * (transform-origin, default its center). It moves nothing else: the box and what is inside it
   * are drawn mapped by it.
   */
  transform?: { value: string; origin?: string; path: string };
  /** In a grid: the lines it spans (grid-row, grid-column) and its own alignment in its area. */
  place?: PlaceProp;
  /**
   * A part of a table (a child of a `pattern: table`, or of its row groups and rows): its caption,
   * a column or a group of columns, a row group (header, body, footer), a row or a cell. A cell's
   * content sits on its row's baseline (the default), or at its top, middle or bottom; a caption
   * above the table (the default) or below it. A cell spans the columns and rows its colspan and
   * rowspan attributes say, a column those of its span.
   */
  part?: { value: TablePart; align?: CellAlign; side?: "top" | "bottom"; contentBox?: boolean; raw: string; path: string };
  /** Removed by this override (`maxWidth: none`), with the YAML path. */
  unset?: Partial<Record<Unsettable, string>>;
}

export interface Contain {
  layout: boolean;
  paint: boolean;
  size?: "both" | "inline";
}

/** A CSS contain value (none, strict, content, or size / inline-size / layout / style / paint); undefined when invalid. */
export function parseContain(v: string): Contain | undefined {
  const words = v.trim().toLowerCase().split(/\s+/);
  if (words.length === 1 && words[0] === "none") return { layout: false, paint: false };
  if (words.length === 1 && words[0] === "strict") return { layout: true, paint: true, size: "both" };
  if (words.length === 1 && words[0] === "content") return { layout: true, paint: true };
  const out: Contain = { layout: false, paint: false };
  const seen = new Set<string>();
  for (const w of words) {
    if (seen.has(w) || !["size", "inline-size", "layout", "style", "paint"].includes(w)) return undefined;
    seen.add(w);
    if (w === "layout") out.layout = true;
    if (w === "paint") out.paint = true;
    if (w === "size" || w === "inline-size") {
      if (out.size) return undefined;
      out.size = w === "size" ? "both" : "inline";
    }
  }
  return out;
}

/** Layout or paint containment: an independent formatting context and the containing block of absolute and fixed descendants. */
export const containsLayout = (c?: Contain) => !!c && (c.layout || c.paint);

export type PositionType = "relative" | "absolute" | "fixed" | "sticky";
export type Overflow = "visible" | "hidden" | "clip" | "auto" | "scroll";
export const OVERFLOWS: Overflow[] = ["visible", "hidden", "clip", "auto", "scroll"];
/** A scroll container: overflow other than visible or clip on either axis. */
export const scrolls = (o?: { x: Overflow; y: Overflow }) => !!o && [o.x, o.y].some((v) => v !== "visible" && v !== "clip");

export const PROP_ORDER: (keyof Props)[] = [
  "layout",
  "padding",
  "margin",
  "background",
  "backdrop",
  "border",
  "shadow",
  "radius",
  "maxWidth",
  "measure",
  "width",
  "height",
  "minHeight",
  "aspect",
  "fit",
  "text",
  "textAlign",
  "grow",
  "overflow",
  "position",
  "contain",
  "transform",
  "place",
  "part",
];

export interface Slot {
  name: string;
  path: string;
  props: Props;
}

export interface Override {
  breakpoint: string;
  path: string;
  props: Props;
  slots: Map<string, Props>;
}

export interface Component {
  name: string;
  path: string;
  intent?: string;
  props: Props;
  slots: Map<string, Slot>;
  when: Override[];
}

export const DEFAULT_PREFIX = "ca-";

export interface Model {
  file: string;
  /** Class prefix: `.${prefix}${component}` and `.${prefix}${component}__${slot}`. */
  prefix: string;
  tokens: Map<string, Token>; // key: `${category}.${name}`
  text: Map<string, TextRole>;
  breakpoints: Breakpoint[];
  components: Map<string, Component>;
  /**
   * The page every component sits on. background: paint only (makes contrast checks conclusive).
   * margin and padding: the <body>'s (its top margin collapses with the first box's unless padding
   * separates them); outer: the root element's margin, border and padding, outside the body.
   * clipX: the page clips what is past its right edge (overflow-x: hidden or clip on html or body) instead of scrolling.
   */
  /** Lifted on the fly from a page's CSS (or Tailwind): findings give their advice in CSS terms. */
  css?: boolean;
  page?: { background?: Ref; path: string; margin?: PageSides; padding?: PageSides; outer?: PageSides; clipX?: boolean; windowHeight?: number };
}

/** Space tokens per side of the page (a missing side is 0). */
export interface PageSides {
  path: string;
  top?: Ref;
  right?: Ref;
  bottom?: Ref;
  left?: Ref;
}

export function tokenKey(category: string, name: string) {
  return `${category}.${name}`;
}
