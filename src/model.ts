/** The validated Cadesa document. Every value remembers the YAML path it came from. */

export const ROOT_FONT_PX = 16;

export interface Length {
  raw: string;
  px: number;
}

export type TokenCategory = "space" | "size" | "color" | "radius" | "font" | "paint" | "shadow";
export const TOKEN_CATEGORIES: TokenCategory[] = ["space", "size", "color", "radius", "font", "paint", "shadow"];
export const LENGTH_CATEGORIES = new Set<TokenCategory>(["space", "size", "radius"]);

export interface Token {
  category: TokenCategory;
  name: string;
  path: string;
  raw: string;
  /** Pixel value for length tokens. */
  px?: number;
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

export type Pattern = "stack" | "cluster" | "grid" | "layer";

export type Align = "start" | "center" | "end" | "stretch";
export type TextAlign = "start" | "center" | "end";

export interface LayoutProp {
  path: string;
  pattern: Pattern;
  gap?: Ref;
  /** Cross-axis alignment: cluster (default center), grid and layer (default stretch). Not for stack. */
  align?: Align;
  /** Grid only: minimum column width; columns auto-fill the row. */
  min?: Ref;
}

/** `padding: compact` sets both axes; `padding: { block, inline }` sets each (a missing axis is 0). */
export interface PaddingProp {
  path: string;
  block?: Ref;
  inline?: Ref;
}

export interface Props {
  layout?: LayoutProp;
  padding?: PaddingProp;
  background?: Ref;
  border?: Ref;
  radius?: Ref;
  maxWidth?: Ref;
  /** Max width that stays left-aligned (a line length), unlike maxWidth, which centers. */
  measure?: Ref;
  width?: Ref | { keyword: "fill"; path: string };
  height?: Ref;
  /** Width / height ratio; height follows the width (images, media, cards). */
  aspect?: { value: number; raw: string; path: string };
  /** How an image fills an aspect box. Paint only. */
  fit?: { value: "cover" | "contain"; path: string };
  /** Gradient or image painted over the background color. Paint only. */
  backdrop?: Ref;
  shadow?: Ref;
  text?: Ref;
  textAlign?: { value: TextAlign; path: string };
}

export const PROP_ORDER: (keyof Props)[] = [
  "layout",
  "padding",
  "background",
  "backdrop",
  "border",
  "shadow",
  "radius",
  "maxWidth",
  "measure",
  "width",
  "height",
  "aspect",
  "fit",
  "text",
  "textAlign",
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
  /** The page behind every component (paint only; makes contrast checks conclusive). */
  page?: { background?: Ref; path: string };
}

export function tokenKey(category: string, name: string) {
  return `${category}.${name}`;
}
