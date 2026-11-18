/** The validated Cascadio document. Every value remembers the YAML path it came from. */

export const ROOT_FONT_PX = 16;

export interface Length {
  raw: string;
  px: number;
}

export type TokenCategory = "space" | "size" | "color" | "radius" | "font";
export const TOKEN_CATEGORIES: TokenCategory[] = ["space", "size", "color", "radius", "font"];
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

export type Pattern = "stack" | "cluster";

export interface LayoutProp {
  path: string;
  pattern: Pattern;
  gap?: Ref;
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
  width?: Ref | { keyword: "fill"; path: string };
  height?: Ref;
  text?: Ref;
}

export const PROP_ORDER: (keyof Props)[] = [
  "layout",
  "padding",
  "background",
  "border",
  "radius",
  "maxWidth",
  "width",
  "height",
  "text",
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

export interface Model {
  file: string;
  tokens: Map<string, Token>; // key: `${category}.${name}`
  text: Map<string, TextRole>;
  breakpoints: Breakpoint[];
  components: Map<string, Component>;
}

export function tokenKey(category: string, name: string) {
  return `${category}.${name}`;
}
