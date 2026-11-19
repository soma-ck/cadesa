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
}

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

/** flow: block flow (display: block); vertical margins collapse between siblings and through the box. */
export type Pattern = "stack" | "cluster" | "grid" | "layer" | "flow";

export type Align = "start" | "center" | "end" | "stretch";
/** Where a cluster puts the free space of each line (justify-content). */
export type Justify = "start" | "end" | "center" | "between" | "around" | "evenly";
export type TextAlign = "start" | "center" | "end";

export interface LayoutProp {
  path: string;
  pattern: Pattern;
  gap?: Ref;
  /** Grid and cluster: the gap between rows (lines) when it differs from the gap between columns. */
  rowGap?: Ref;
  /** Cross-axis alignment: cluster (default center), grid and layer (default stretch). Not for stack. */
  align?: Align;
  /** Grid only: minimum column width; columns auto-fill the row. */
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
  top?: Ref;
  right?: MarginSide;
  bottom?: Ref;
  left?: MarginSide;
}

/** Props an override can remove (`maxWidth: none`): the element is then as if it never had them. */
export const UNSETTABLE = ["padding", "margin", "background", "backdrop", "border", "shadow", "radius", "maxWidth", "measure", "width", "height", "minHeight", "aspect", "grow"] as const;
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
  width?: Ref | { keyword: "fill" | "fit"; path: string };
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
  /** Removed by this override (`maxWidth: none`), with the YAML path. */
  unset?: Partial<Record<Unsettable, string>>;
}

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
