/**
 * Lift a page with its stylesheet: every element of an HTML page gets the declarations the cascade
 * gives it, per width range, and becomes a component root or slot with generated class names. Front
 * ends (plain CSS in css-page.ts, Tailwind in ../tailwind/lift.ts) supply each element's own
 * declarations per range; the rest is shared:
 *
 *   1. var() and calc() are resolved per element; colors become hex. Inherited text (size, line
 *      height, weight, color, family, tracking, case, alignment) is computed down the tree, because
 *      Cadesa text roles don't inherit.
 *   2. Each element is a container (block, flex or grid children), a text box (only inline content),
 *      a leaf, or hidden / out of flow. Block flow becomes a stack (Tailwind: no margins) or a flow.
 *   3. Each element becomes a component root (top level) or slot with generated class names
 *      (`ca-<component>`, `ca-<component>__<slot>`) and a data-fixture id. lift.ts maps the
 *      effective declarations to props.
 *   4. Everything not modelled is an Unlifted record against the element, so impact.ts marks the
 *      boxes it can move as ≈. A few things can only be decided after layout (a non-wrapping flex
 *      row that would wrap); `dynamic()` reports those per width.
 */
import { parse } from "parse5";
import { walk, type Box, type Issue, type Layout } from "../engine/layout.js";
import { parseFixture, textAndRuns, type Fixture, type FixtureNode, type Generated, type InlineInfo, type P5Node, type RunStyle } from "../fixture.js";
import { ABSOLUTE, lengthExpr, MATHY } from "../fluid.js";
import { borderPx, insets } from "../resolve.js";
import { lineHeightPx } from "../engine/layout.js";
import { metricsFor } from "../engine/text.js";
import { hexOf, INVALID, parseColor, simplify, substitute } from "../tailwind/values.js";
import { containsLayout, parseContain, type Contain } from "../model.js";
import { individual, originOf, transformList } from "../engine/transform.js";
import { firstFamily } from "../fonts.js";
import type { Decl } from "./css.js";
import { linesOf } from "./impact.js";
import { emitYaml, kindOf, liftElements, parseFlex, type ImpactKind, type LiftedElement, type LiftResult, type Unlifted } from "./lift.js";

// ---------------------------------------------------------------- states

/** A width range [lo, hi) in which every media condition holds or fails together. */
export interface State {
  lo: number;
  hi: number;
  /** Lift state key: Infinity for the widest (base) range, else the max-width breakpoint px. */
  key: number;
  /** Max-width breakpoint for narrower states, as written, e.g. "47.99rem". */
  raw?: string;
  name?: string;
}

export const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export const stateAt = (states: State[], width: number) => states.find((s) => width >= s.lo && width < s.hi) ?? states[0];

// ---------------------------------------------------------------- the page

interface P5Loc {
  startLine: number;
  startOffset: number;
  endOffset: number;
  startTag?: { startOffset: number; endOffset: number };
  endTag?: { startOffset: number; endOffset: number };
  attrs?: Record<string, { startOffset: number; endOffset: number }>;
}
export interface P5 {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5[];
  sourceCodeLocation?: P5Loc;
}

export type Role = "hidden" | "out" | "container" | "text" | "leaf";

export interface Origin {
  value: string;
  utility: string;
  important?: boolean;
  /**
   * Set by a shorthand whose value has var(): which longhand gets which part is only known once
   * the variables are substituted (`border: var(--w) solid var(--c)`), so it's expanded then.
   */
  shorthand?: string;
}

/**
 * The default height of the window the page is laid out in (`--height`): vh, dvh, svh and lvh,
 * and percentage heights of the root, are computed exactly for it, as widths are for each width.
 */
export const VIEWPORT_HEIGHT = 800;

export interface TextCtx {
  size: number;
  /** A font size that follows the viewport width (clamp(), vw): its CSS in px and vw; `size` is its value at 1280px. */
  fluid?: string;
  lineHeight: { num: number } | { px: number } | "normal";
  family: { value: string; hint?: string };
  weight: number;
  color: { hex: string; hint?: string };
  letterSpacing: number;
  /** letter-spacing set in em of this fluid font size (its px follow the viewport width with it). */
  lsFluid?: string;
  /** Other inherited properties, with the utility that set them. */
  inherited: Map<string, Origin>;
}

export interface Note {
  reason: string;
  kind: ImpactKind;
  decl: string;
}

export interface El {
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
  /** A wrapping row's own row gap, when it differs from the column gap (dropped from the lift). */
  rowGap: (string | undefined)[];
  /** A flex-row item without a width that may not shrink (flex-shrink: 0), with the declaration. */
  noShrink: (string | undefined)[];
  /**
   * An inline element laid out as a block (per state): "block" wraps only block-level boxes, alone
   * between blocks (block-in-inline: Chromium lays its children out as if it were a block with no
   * padding or border, and its box is theirs); "empty" has nothing in it (a zero-size box where the
   * next block starts, e.g. Angular's <router-outlet>).
   */
  asBlock: ("block" | "empty" | undefined)[];
  /** An inline-block alone on its line whose line box is exactly its margin box: lifted as a block of its content's width. */
  alone: boolean[];
  /** An inline element alone between blocks: the height of each of its lines (per state), see inlineLine. */
  inlineLine?: (number | undefined)[];
  /** A lone inline-block placed for one line of its text (per state): see dynamic(). */
  oneLine?: boolean[];
  /** A lone inline-block's line is centered or end-aligned (per state). */
  lineAlign?: ("center" | "end" | undefined)[];
  /** Padding the line box of a lone inline-block adds above and below it (its strut, its margins), per state: see aloneOnLine. */
  linePad?: ({ top: number; bottom: number } | undefined)[];
  /** Inline-blocks sharing the lines of this block (per state): the space between them and where each line's free space goes, see inlineRow. */
  inlineRow?: ({ gap: number; justify: "start" | "center" | "end" } | undefined)[];
  /** An inline-block on a shared line: px its line box reaches above and below its margin box (per state), see inlineRow. */
  rowLine?: ({ top: number; bottom: number } | undefined)[];
  /** A flex row aligns baselines: px its item is pushed down to put its first baseline on the line's (per state). */
  baselineShift: (number | undefined)[];
  /** Text in a font size of 0 (per state): the px of its one line (its line height in px, else 0). */
  zeroText?: (number | undefined)[];
  /** A run of text among element children (added after the cascade): its anonymous box. */
  anonymous?: string;
  /** The (shared) slot or root this element's styles are emitted under. */
  signature?: string;
  /** Per state, from the front end: the declarations the cascade gives the element's ::before and ::after (when content is set). */
  pseudoOwn?: { before?: Map<string, Origin>; after?: Map<string, Origin> }[];
  /** A ::before or ::after box (added after the cascade, as the first or last child of its element). */
  pseudo?: "before" | "after";
  /**
   * A ::before / ::after's content per state: its text ("" for content: ""), undefined where it
   * generates no box, or `{ unknown }` for content Cadesa can't read (counters, attr(), images).
   */
  content?: (string | { unknown: string } | undefined)[];
}

export const SKIP = new Set(["script", "style", "template", "noscript", "head", "title", "meta", "link", "base"]);
export const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "br", "label", "del", "ins"]);
/** Elements Chromium's default stylesheet makes blocks. Any other element (custom elements like <app-root> too) is inline. */
const BLOCK_TAGS = new Set(["html", "body", "div", "p", "section", "article", "header", "footer", "nav", "main", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "hgroup", "ul", "ol", "menu", "dl", "dt", "dd", "form", "fieldset", "legend", "figure", "figcaption", "blockquote", "pre", "address", "hr", "details", "summary", "dialog", "search", "center", "dir", "listing", "plaintext", "xmp", "optgroup", "option", "frameset", "frame"]);
export const INLINE_BLOCK = new Set(["button", "input", "select", "textarea", "meter", "progress"]);
export const REPLACED_BLOCK = new Set(["img", "svg", "video", "canvas", "audio", "iframe", "embed", "object"]);
const CONTROL = new Set(["input", "select", "textarea"]);
/** Table elements' default display. */
const TABLE_DISPLAY: Record<string, string> = {
  table: "table",
  caption: "table-caption",
  colgroup: "table-column-group",
  col: "table-column",
  thead: "table-header-group",
  tbody: "table-row-group",
  tfoot: "table-footer-group",
  tr: "table-row",
  td: "table-cell",
  th: "table-cell",
};
/** What a table display makes a box: its part (Cadesa's part prop). */
const TABLE_PART: Record<string, string> = {
  "table-caption": "caption",
  "table-column-group": "column-group",
  "table-column": "column",
  "table-header-group": "header",
  "table-row-group": "body",
  "table-footer-group": "footer",
  "table-row": "row",
  "table-cell": "cell",
};
/** Inherited properties that only tables read: nothing else is laid out differently. */
const TABLE_INHERITED = new Set(["border-collapse", "border-spacing", "caption-side", "empty-cells"]);
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
const INHERITED_OTHER = new Set(["text-rendering", "text-transform", "text-align", "font-style", "white-space", "text-wrap", "text-wrap-mode", "text-wrap-style", "word-break", "overflow-wrap", "hyphens", "text-indent", "word-spacing", "font-variant", "font-variant-numeric", "font-variant-caps", "font-variant-ligatures", "font-variant-east-asian", "font-variant-position", "font-variant-alternates", "font-variant-emoji", "font-kerning", "font-optical-sizing", "font-synthesis", "font-stretch", "line-break", "tab-size", "direction"]);
/** Inherited, but only paint: never affect a box. */
const INHERITED_PAINT = new Set(["-webkit-font-smoothing", "-moz-osx-font-smoothing", "font-feature-settings", "font-variation-settings", "cursor", "visibility", "list-style-type", "list-style-position", "text-shadow", "caret-color", "accent-color", "fill", "stroke"]);

export const attr = (n: P5, name: string) => n.attrs?.find((a) => a.name === name)?.value;
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
  // grid-area, grid-row and grid-column: their line longhands (a lone name ends where it starts: at that area's edge).
  if (/^grid-(area|row|column)$/.test(prop) && !/\bvar\(/.test(value)) {
    const parts = value.split("/").map((p) => p.trim());
    const named = (x: string | undefined) => (x !== undefined && /^-?[a-zA-Z_][\w-]*$/.test(x) && !/^(span|auto)$/i.test(x) ? x : "auto");
    if (prop === "grid-area") {
      const [rs, cs = named(rs), re = named(rs), ce = named(cs)] = parts;
      return [["grid-row-start", rs], ["grid-column-start", cs], ["grid-row-end", re], ["grid-column-end", ce]];
    }
    const [s, e = named(s)] = parts;
    return [[`${prop}-start`, s], [`${prop}-end`, e]];
  }
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
  if (prop === "text-wrap") {
    // text-wrap: <mode> || <style> (wrap | nowrap, auto | balance | pretty | stable).
    const words = value.trim().toLowerCase().split(/\s+/);
    const mode = words.find((w) => /^(wrap|nowrap)$/.test(w));
    const style = words.find((w) => /^(auto|balance|pretty|stable)$/.test(w));
    if (words.length && words.length === (mode ? 1 : 0) + (style ? 1 : 0))
      return [["text-wrap-mode", mode ?? "wrap"], ["text-wrap-style", style ?? "auto"]];
    return [["text-wrap", value]];
  }
  if (prop === "font") {
    const v = value.trim();
    if (/^(inherit|initial|unset|revert)$/.test(v)) return ["font-style", "font-weight", "font-size", "line-height", "font-family"].map((p) => [p, v] as [string, string]);
    const m = /^((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|\d{3})\s+)*)([\d.]+(?:px|rem|em|%)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:\s*\/\s*([\d.]+(?:px|rem|em|%)?|normal))?\s+(.+)$/.exec(v);
    if (!m) return [[prop, value]];
    const pre = m[1].trim().split(/\s+/).filter(Boolean);
    const style = pre.find((x) => /^(italic|oblique)$/.test(x)) ?? "normal";
    const weight = pre.find((x) => /^(bold|bolder|lighter|\d{3})$/.test(x)) ?? "normal";
    return [["font-style", style], ["font-weight", weight], ["font-size", m[2]], ["line-height", m[3] ?? "normal"], ["font-family", m[4]]];
  }
  if (prop === "background") {
    // One layer that is only a color, or only an image; anything else stays as written.
    const v = value.trim();
    const parts = v.split(/\s+(?![^(]*\))/);
    if (/^(none|transparent)$/.test(v)) return [["background-color", "transparent"], ["background-image", "none"]];
    if (parts.length !== 1 || v.includes(",") && !/^[a-z-]+\(/.test(v)) return [[prop, value]];
    if (/^(?:(?:repeating-)?(?:linear|radial|conic)-gradient|url|image-set)\(/.test(v)) return [["background-color", "transparent"], ["background-image", v]];
    return [["background-color", v], ["background-image", "none"]];
  }
  return [[prop, value]];
}

/** Shorthands expanded only after var() substitution, with every longhand each may set. */
const DEFERRED: Record<string, string[]> = (() => {
  const sides = (f: (s: string) => string) => SIDES.map(f);
  const border = (ss: readonly string[]) => ss.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]);
  const out: Record<string, string[]> = {
    margin: sides((s) => `margin-${s}`),
    padding: sides((s) => `padding-${s}`),
    "margin-inline": ["margin-left", "margin-right"],
    "margin-block": ["margin-top", "margin-bottom"],
    "padding-inline": ["padding-left", "padding-right"],
    "padding-block": ["padding-top", "padding-bottom"],
    border: border(SIDES),
    "border-width": sides((s) => `border-${s}-width`),
    "border-style": sides((s) => `border-${s}-style`),
    "border-color": sides((s) => `border-${s}-color`),
    gap: ["row-gap", "column-gap"],
    inset: [...SIDES],
    font: ["font-style", "font-weight", "font-size", "line-height", "font-family"],
    background: ["background-color", "background-image", "background"],
    "border-radius": ["border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"],
  };
  for (const s of SIDES) out[`border-${s}`] = border([s]);
  return out;
})();

// ---------------------------------------------------------------- values

const LEN = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%)?$/;

export function lengthPx(v: string, em: number, pct?: number): number | undefined {
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
export function hintOf(raw: string, theme: Map<string, string>): string | undefined {
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

export const WEIGHTS: Record<string, number> = { normal: 400, bold: 700 };
function bolder(w: number) {
  return w < 350 ? 400 : w < 550 ? 700 : w < 900 ? 900 : w;
}
function lighter(w: number) {
  return w < 550 ? 100 : w < 750 ? 400 : 700;
}

// ---------------------------------------------------------------- result

/** A page lifted with its stylesheet: the source, the page with generated classes, and per-width fixtures. */
export interface PageLift {
  page: string;
  cssFile: string;
  lifted: LiftResult;
  yaml: string;
  /** The page with generated class names and data-fixture ids added (original classes kept). */
  html: string;
  /** As `html`, for plain Cadesa commands: elements never displayed removed, svg contents emptied. */
  standaloneHtml: string;
  /** Every element laid out at some width. */
  fixture: Fixture;
  /** The fixture as laid out at `width`: elements hidden there (display: none) are left out. */
  fixtureAt(width: number): Fixture;
  /** Uncertainty that can only be decided after layout, for one width. */
  dynamic(layout: Layout): Unlifted[];
  states: State[];
  /** Data-fixture ids of elements hidden at some widths but not others. */
  responsive: string[];
  /** Things the reader should know about how the page was read (e.g. a stylesheet used under another name). */
  notes: string[];
  /** The window height (px) the page was laid out for: vh units and the root's percentage heights. */
  viewportHeight: number;
  /** Some box depends on the window's height (vh units, a percentage height of the root). */
  usesViewportHeight: boolean;
  /** The cascade per element (for pointing findings at the rule that set a property). */
  elements: { els: El[]; html?: El; body?: El };
  /**
   * Text that runs together at `width` (`<span>Total</span><span>42</span>` reads "Total42"):
   * decided from the markup and the cascade, so it holds even where the layout is approximate.
   */
  spacing(width: number): (Issue & { inconclusive?: boolean })[];
  /** Inline runs of a text box with a color or background of their own (`<span class="text-danger">`, a badge), for contrast. */
  inlineRuns(width: number): InlineRun[];
}

/** A run of text inside a text box (`id`) styled on its own. */
export interface InlineRun {
  id: string;
  tag: string;
  text: string;
  /** Hex, maybe translucent. */
  color: string;
  /** Its own background, if any (hex, maybe translucent). */
  background?: string;
  sizePx: number;
  weight: number;
  /** page:line of the element. */
  where: string;
}

/**
 * The shared machinery: a front end supplies each element's own declarations per width range
 * (`evaluate`), the ranges (`computeStates`) and the root text style (`computeRootText`).
 */
export abstract class PageLifter {
  /** Page-level notes for the reader, returned as PageLift.notes. */
  readerNotes: string[] = [];
  els: El[] = [];
  roots: El[] = [];
  states: State[] = [];
  pageNotes: Note[] = [];
  bodyEl?: El;
  vars = new Map<string, Decl>();
  pageBackground?: Decl;
  /** The page's insets per side (CSS lengths): the body's margin and padding (with its border), and the root element's (outer). */
  pageSides: { margin?: string[]; padding?: string[]; outer?: string[]; overflow?: string; windowHeight?: number } = {};
  rootText!: TextCtx;
  /** Custom properties defined on :root (unresolved): token names come from them. */
  theme = new Map<string, string>();
  /** A reset zeroes margins, padding and borders and makes boxes border-box (Tailwind's preflight). */
  preflight = false;
  /** The browser's default styles are part of the cascade the front end computes (not a reset). */
  uaInCascade = false;
  /** How a block container with block children is lifted: a stack (no margins) or block flow. */
  blockFlow: "stack" | "flow" = "stack";
  /** The window's height in px: vh units and the root's percentage heights are computed for it. */
  viewportHeight = VIEWPORT_HEIGHT;
  /** Some length depends on the window's height (vh, or a percentage height of the root). */
  usesViewportHeight = false;
  /** For the source header: what the page was lifted with. */
  abstract readonly label: string;

  constructor(
    readonly page: string,
    readonly html: string,
    readonly cssFile: string,
  ) {}

  abstract computeStates(): void;
  abstract computeRootText(): void;
  /** Fill `el.own[si]` (and `el.space[si]`) for every state; note what isn't modelled. */
  abstract evaluate(el: El): void;
  /** A custom property's value where no element defines it. */
  rootVar(_name: string): string | undefined {
    return undefined;
  }
  /** Whether @keyframes `name` animates where or how large a box is drawn (transform, offsets, sizes). */
  movingAnimation(_name: string): boolean {
    return false;
  }
  /** A registered (@property) custom property that doesn't inherit. */
  registered(_name: string): { inherits: boolean; initial?: string } | undefined {
    return undefined;
  }
  /**
   * Whether the page loads an italic face of the family (undefined: unknown, a system font). Without
   * one, italic text is the upright face slanted, as wide as upright text.
   */
  italicFace(_family: string): boolean | undefined {
    return undefined;
  }
  /** A component (root) or slot name for an element, before the data-fixture id or tag. */
  nameOf(_el: El, _root: boolean): string | undefined {
    return undefined;
  }
  /** What "declarations read" counts in the stats (Tailwind: the class names used). */
  declarationCount(): number {
    return this.els.reduce((n, e) => n + e.classes.length, 0);
  }
  /** Notes against every root (whole-page uncertainty). */
  extraUnlifted(): Unlifted[] {
    return [];
  }

  run(): PageLift {
    this.parseTree();
    this.computeStates();
    this.computeRootText();
    for (const el of [this.htmlEl, this.bodyEl, ...this.els]) if (el) this.evaluate(el);
    for (const el of [this.htmlEl, this.bodyEl, ...this.els]) if (el) this.expandDeferred(el);
    this.presentationalHints();
    this.pseudoElements();
    this.anonymousText();
    this.inlineBlocks();
    for (const el of this.els) this.classify(el);
    this.lineBoxes();
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
      rowGap: [],
      noShrink: [],
      asBlock: [],
      alone: [],
      baselineShift: [],
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

  /**
   * The width and height attributes of <svg>, <img>, <video> and <canvas> are presentational
   * hints: their CSS width and height unless a stylesheet sets them. (An image's aspect ratio from
   * them, `auto w / h`, gives way to the file's own once loaded: not used.) An inline <svg>'s
   * viewBox gives its aspect ratio. Its contents (paths, groups, text) are drawn, not laid out: they
   * never move a box.
   */
  presentationalHints() {
    const num = (v: string | undefined) => (v !== undefined && /^\s*\d*\.?\d+(px)?\s*$/.test(v) ? parseFloat(v) : undefined);
    for (const el of this.els) {
      if (!/^(svg|img|video|canvas)$/.test(el.tag)) continue;
      const w = num(attr(el.node, "width"));
      const h = num(attr(el.node, "height"));
      const pct = (v: string | undefined) => (el.tag === "svg" && v !== undefined && /^\s*\d*\.?\d+%\s*$/.test(v) ? v.trim() : undefined);
      const vb = el.tag === "svg" ? (attr(el.node, "viewbox") ?? attr(el.node, "viewBox"))?.trim().split(/[\s,]+/).map(Number) : undefined;
      this.states.forEach((_, si) => {
        const own = el.own[si];
        if (!own) return;
        const hint = (p: string, v: string, why: string) => {
          if (!own.has(p)) own.set(p, { value: v, utility: why });
        };
        if (w !== undefined) hint("width", `${w}px`, `width="${attr(el.node, "width")}" attribute`);
        else if (pct(attr(el.node, "width"))) hint("width", pct(attr(el.node, "width"))!, `width="${attr(el.node, "width")}" attribute`);
        if (h !== undefined) hint("height", `${h}px`, `height="${attr(el.node, "height")}" attribute`);
        if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0 && vb.every(isFinite)) hint("aspect-ratio", `${vb[2]} / ${vb[3]}`, "viewBox attribute");
      });
    }
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
      const v = this.rootVar(name);
      return v === undefined ? undefined : substitute(v, (n) => this.lookupVar(undefined, si, n, depth + 1));
    }
    const own = el.own[si]?.get(name);
    if (own) {
      const v = substitute(own.value, (n) => (n === name ? undefined : this.lookupVar(el, si, n, depth + 1)));
      return v === INVALID ? undefined : v;
    }
    const reg = this.registered(name);
    if (reg && !reg.inherits) return reg.initial;
    return this.lookupVar(el.parent, si, name, depth + 1);
  }

  resolve(el: El, si: number, value: string): string | undefined {
    const v = substitute(value, (n) => this.lookupVar(el, si, n));
    if (v === INVALID) return undefined;
    return absolute(simplify(v).trim());
  }

  /** A box length (not font-size): as resolve(), with em as the element's own font size, also inside calc(). */
  resolveBox(el: El, si: number, value: string): string | undefined {
    const v = substitute(value, (n) => this.lookupVar(el, si, n));
    if (v === INVALID) return undefined;
    const size = this.textOf(el, si).size;
    return simplify(v.replace(/(^|[\s(,*/+-])(\d*\.?\d+)em\b/g, (_, pre, n) => `${pre}${fmtNum(parseFloat(n) * size)}px`)).trim();
  }

  apply(own: Map<string, Origin>, d: { prop: string; value: string; important: boolean }, utility: string) {
    if (d.prop === "word-wrap") d = { ...d, prop: "overflow-wrap" }; // a legacy alias
    const deferred = !d.prop.startsWith("--") && /\bvar\(/.test(d.value) ? DEFERRED[d.prop] : undefined;
    const pairs: [string, string][] = d.prop.startsWith("--") ? [[d.prop, d.value]] : deferred ? deferred.map((p) => [p, d.value]) : longhands(d.prop, d.value);
    for (const [p, v] of pairs) {
      const prev = own.get(p);
      if (prev?.important && !d.important) continue;
      own.set(p, { value: v, utility, important: d.important, ...(deferred && { shorthand: d.prop }) });
    }
  }

  /**
   * A shorthand with var() in it, expanded. When each part of the value is one value once
   * substituted, the longhands keep the part as written (`var(--spacing)`, so token names survive):
   * by position, or for shorthands that assign by type (border, font, background) by matching the
   * substituted parts.
   */
  expandShorthand(el: El, si: number, prop: string, raw: string): [string, string][] {
    const v = this.resolve(el, si, raw);
    if (v === undefined || v === "") return [];
    const rawParts = raw.trim().split(/\s+(?![^(]*\))/);
    const resParts = rawParts.map((p) => this.resolve(el, si, p));
    if (resParts.some((p) => p === undefined || p === "" || /\s/.test(p))) return longhands(prop, v);
    if (!/^(border|border-(top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end)|font|background)$/.test(prop)) return longhands(prop, raw);
    return longhands(prop, resParts.join(" ")).map(([p, x]) => {
      const i = resParts.indexOf(x);
      return [p, i >= 0 ? rawParts[i] : x];
    });
  }

  /** Expand the shorthands apply() deferred, now that every custom property is known. */
  expandDeferred(el: El) {
    this.states.forEach((_, si) => {
      const own = el.own[si];
      if (!own) return;
      const done = new Map<string, Map<string, string>>();
      for (const [p, o] of [...own]) {
        if (!o.shorthand) continue;
        const key = `${o.shorthand}\0${o.value}`;
        let parts = done.get(key);
        if (!parts) {
          parts = new Map(this.expandShorthand(el, si, o.shorthand, o.value));
          done.set(key, parts);
        }
        // A part the value doesn't set: invalid at computed-value time, so the initial value (left out).
        const part = parts.get(p);
        if (part === undefined) own.delete(p);
        else own.set(p, { value: part, utility: o.utility, important: o.important });
      }
      // inherit on a property that doesn't inherit (Bootstrap's .navbar > .container { flex-wrap: inherit }):
      // the parent's value; initial and unset: the initial value (left out). Parents come first.
      for (const [p, o] of [...own]) {
        if (p.startsWith("--") || TEXT_PROPS.has(p) || INHERITED_OTHER.has(p) || INHERITED_PAINT.has(p)) continue;
        const v = this.resolve(el, si, o.value)?.trim();
        if (v === "initial" || v === "unset") own.delete(p);
        else if (v === "inherit") {
          const from = el.parent?.own[si]?.get(p);
          // The parent's computed value: its var()s resolved where they're declared.
          if (from) own.set(p, { value: this.resolve(el.parent!, si, from.value) ?? from.value, utility: `${o.utility} (inherit: ${from.utility})`, important: o.important });
          else own.delete(p);
        }
      }
    });
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
    // A table header cell is bold (font-weight: bold): in the stylesheet's cascade when the browser's defaults are in it.
    if (el.tag === "th" && !this.uaInCascade) t.weight = 700;
    if (el.tag === "small") t.size = parent.size * 0.8;
    const fs = val("font-size");
    if (fs) {
      const decl = `${own.get("font-size")!.utility} (font-size: ${fs})`;
      const KEYWORDS: Record<string, number> = { "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32, "xxx-large": 48 };
      const rel = /^(-?(?:\d+\.?\d*|\.\d+))(em|%)$/.exec(fs);
      const px = KEYWORDS[fs] ?? (fs === "smaller" ? parent.size / 1.2 : fs === "larger" ? parent.size * 1.2 : lengthPx(fs, parent.size, parent.size));
      if (px !== undefined) {
        t.size = px;
        // em and % of a size that follows the viewport follow it too.
        t.fluid = parent.fluid && (rel || fs === "smaller" || fs === "larger") ? lengthExpr(`calc(${parent.fluid} * ${px / parent.size})`)?.css : undefined;
      } else if (parent.fluid && MATHY.test(fs) && /\d(em|%)/.test(fs)) {
        this.note(el, si, { decl, reason: "a font size relative to one that follows the viewport width is not modelled", kind: "text" });
      } else {
        const f = MATHY.test(fs) ? lengthExpr(fs, { em: parent.size, vh: this.viewportHeight }) : undefined;
        if (f && /\d[dsl]?v(?:h|min|max)\b/i.test(fs)) this.usesViewportHeight = true;
        if (f) {
          t.size = f.at(1280);
          t.fluid = f.fluid ? f.css : undefined;
        } else this.note(el, si, { decl, reason: "font-size must be a length, or calc()/clamp()/min()/max() of px, rem, em and vw", kind: "text" });
      }
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
      if (v && v !== "inherit") t.family = { value: v, hint: hintOf(ff.value, this.theme) };
    }
    const fw = val("font-weight");
    if (fw) t.weight = WEIGHTS[fw] ?? (fw === "bolder" ? bolder(parent.weight) : fw === "lighter" ? lighter(parent.weight) : parseFloat(fw) || t.weight);
    const c = own.get("color");
    if (c) {
      const v = this.resolve(el, si, c.value);
      if (v && !/^(inherit|currentcolor)$/i.test(v)) {
        const parsed = parseColor(v, parseColor(parent.color.hex));
        if (parsed) t.color = { hex: hexOf(parsed), hint: parsed.a >= 0.9995 ? hintOf(c.value, this.theme) : undefined };
      }
    }
    const ls = val("letter-spacing");
    if (ls) {
      const px = ls === "normal" ? 0 : lengthPx(ls, t.size);
      if (px !== undefined) {
        t.letterSpacing = px;
        // In em of a font size that follows the viewport: it follows it too (as long as the size is this one).
        t.lsFluid = /em$/.test(ls) ? t.fluid : undefined;
      }
    }
    for (const p of [...INHERITED_OTHER, ...INHERITED_PAINT]) {
      const o = own.get(p);
      if (o) {
        const v = this.resolve(el, si, o.value);
        // inherit (and unset, for an inherited property) keeps the parent's value.
        if (v !== undefined && !/^(inherit|unset|-webkit-match-parent)$/.test(v)) t.inherited.set(p, { value: v, utility: o.utility });
      }
    }
    el.text[si] = t;
    return t;
  }

  // ---- roles

  displayOf(el: El, si: number): string {
    if (el.asBlock[si]) return "block";
    const d = this.ownDisplay(el, si);
    // An absolutely positioned or fixed box is blockified.
    if (this.positioned(el, si)) return d === "inline-flex" ? "flex" : d === "inline-grid" ? "grid" : /^(inline|inline-block|inline-flow-root)$/.test(d) ? "block" : d;
    return d;
  }

  /** position: absolute or fixed (out of flow, laid out in its containing block). */
  positioned(el: El, si: number) {
    const p = el.own[si]?.get("position");
    const v = p ? this.resolve(el, si, p.value) : undefined;
    return v === "absolute" || v === "fixed";
  }

  /**
   * The containment that applies to the element (contain, and content-visibility: auto's layout,
   * paint and style), or undefined for none. Nothing applies to a non-atomic inline box or a table part.
   */
  containOf(el: El, si: number): Contain | undefined {
    const own = el.own[si];
    if (!own || (!own.has("contain") && !own.has("content-visibility"))) return undefined;
    if (/^(inline|contents|none)$|^table-/.test(this.displayOf(el, si))) return undefined;
    const r = (p: string) => {
      const o = own.get(p);
      return o ? this.resolve(el, si, o.value) : undefined;
    };
    const v = r("contain");
    const c: Contain = { ...((v && parseContain(v)) || { layout: false, paint: false }) };
    if (r("content-visibility") === "auto") c.layout = c.paint = true;
    return c.layout || c.paint || c.size ? c : undefined;
  }

  /**
   * For an absolutely positioned or fixed box: the declaration on an ancestor that makes it its
   * containing block by a transform, filter or will-change (which Cadesa doesn't model), when that
   * ancestor comes before any positioned (absolute only) or contained one.
   */
  transformedContainer(el: El, si: number): string | undefined {
    const fixed = this.resolve(el, si, el.own[si].get("position")?.value ?? "") === "fixed";
    for (let a = el.parent; a; a = a.parent) {
      const own = a.own[si];
      if (!own) continue;
      const r = (p: string) => {
        const o = own.get(p);
        return o ? this.resolve(a, si, o.value) : undefined;
      };
      // The same box positioned (for an absolute box) or contained: modelled.
      const c = this.containOf(a, si);
      if (c && (c.layout || c.paint)) return undefined;
      if (!fixed && !/^(static)?$/.test(r("position") ?? "")) return undefined;
      const tf = ["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter"].find((p) => !/^(none)?$/.test(r(p) ?? ""));
      if (tf) return `${own.get(tf)!.utility} (${tf}: ${r(tf)})`;
      const wc = r("will-change");
      if (wc && /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter)\b/.test(wc)) return `${own.get("will-change")!.utility} (will-change: ${wc})`;
    }
    return undefined;
  }

  /** The display the cascade gives the element (the browser's default for its tag when nothing sets it). */
  ownDisplay(el: El, si: number): string {
    const d = el.own[si].get("display");
    const v = d ? this.resolve(el, si, d.value) : undefined;
    if (v) return v;
    if (INLINE.has(el.tag)) return "inline";
    if (INLINE_BLOCK.has(el.tag)) return "inline-block";
    if (REPLACED_BLOCK.has(el.tag)) return this.preflight ? "block" : "inline";
    if (el.tag === "li") return "list-item";
    if (el.tag in TABLE_DISPLAY) return TABLE_DISPLAY[el.tag];
    return BLOCK_TAGS.has(el.tag) || el === this.bodyEl || el === this.htmlEl ? "block" : "inline";
  }

  /** line-height: normal in px: the font's ascent, descent and line gap as Chromium rounds them (undefined without vertical metrics, or for a font size that follows the viewport). */
  normalLine(t: TextCtx): number | undefined {
    if (t.fluid) return undefined;
    const v = metricsFor(t.family.value)?.vertical(t.size, t.weight);
    return v && v.ascent + v.descent + v.lineGap;
  }

  /**
   * The strut of an element's lines, from its font's vertical metrics as Chromium rounds them: how
   * far its line extends above (`sa`) and below (`sd`) the baseline, with the leading split as
   * Chromium splits it (floor(leading / 2) above), and half its x-height in layout units (`xh2`,
   * for vertical-align: middle). undefined without vertical metrics.
   */
  strutOf(el: El, si: number): { sa: number; sd: number; xh2: number; lh: number; ascent: number; descent: number } | undefined {
    const t = this.textOf(el, si);
    if (t.fluid) return undefined;
    const v = metricsFor(t.family.value)?.vertical(t.size, t.weight);
    if (!v) return undefined;
    const lu = (x: number) => Math.floor(x * 64 + 1e-6) / 64;
    const lh = t.lineHeight === "normal" ? v.ascent + v.descent + v.lineGap : "num" in t.lineHeight ? lineHeightPx(t.size, t.lineHeight.num) : lu(t.lineHeight.px);
    const leading = Math.round((lh - v.ascent - v.descent) * 64);
    const above = Math.floor(Math.trunc(leading / 2) / 64);
    return { sa: v.ascent + above, sd: v.descent + leading / 64 - above, xh2: Math.round((v.xHeight / 2) * 64) / 64, lh, ascent: v.ascent, descent: v.descent };
  }

  /** The text box whose lines an inline-level element sits on: its nearest ancestor that isn't an inline box. */
  lineRoot(k: El, si: number): El | undefined {
    let p = k.parent;
    while (p && p !== this.bodyEl && p.pseudo === undefined && this.displayOf(p, si) === "inline" && p.roles[si] !== "text") p = p.parent;
    return p;
  }

  /**
   * The vertical-align shift of an inline-level box from its parent's baseline (px, positive down),
   * as LayoutNG computes it when the box closes: sub and super by the parent's font size (/5 + 1px,
   * /3 + 1px), middle by half the box's extent around the parent's x-height, text-top and
   * text-bottom to the parent font's ascent and descent, a length, or a percentage of the box's own
   * line height. `ext`: the box's extent around its own baseline (see inlineExtent). undefined
   * for a vertical-align that isn't modelled (top, bottom).
   */
  ownShift(k: El, si: number, ext: { sa: number; sd: number; lh?: number }): number | undefined {
    const p = k.parent;
    if (!p) return undefined;
    const o = k.own[si].get("vertical-align");
    const va = (o ? this.resolve(k, si, o.value) : undefined) ?? "baseline";
    if (va === "baseline") return 0;
    const parent = this.strutOf(p, si);
    if (!parent) return undefined;
    const U = (x: number) => Math.round(x * 64);
    if (va === "sub" || va === "super") {
      const ps = U(this.textOf(p, si).size);
      return (va === "sub" ? Math.trunc(ps / 5) + 64 : -(Math.trunc(ps / 3) + 64)) / 64;
    }
    if (va === "middle") return (Math.trunc((U(ext.sa) - U(ext.sd)) / 2) - U(parent.xh2)) / 64;
    if (va === "text-top") return ext.sa - parent.ascent;
    if (va === "text-bottom") return parent.descent - ext.sd;
    if (/%$/.test(va)) {
      const pct = parseFloat(va);
      if (!isFinite(pct) || ext.lh === undefined) return undefined;
      return -Math.trunc(Math.fround((ext.lh * pct) / 100) * 64) / 64;
    }
    const len = lengthPx(va, this.textOf(k, si).size);
    if (len === undefined) return undefined;
    return -Math.trunc(Math.fround(len) * 64) / 64;
  }

  /** Whether a box's vertical-align depends on its extent (middle, text-top, text-bottom). */
  alignsByExtent(k: El, si: number): boolean {
    const o = k.own[si].get("vertical-align");
    return /^(middle|text-top|text-bottom)$/.test((o ? this.resolve(k, si, o.value) : undefined) ?? "");
  }

  /** Inline-level children that sit on a box's lines (inline boxes, atomic inlines, inline generated content). */
  lineKids(k: El, si: number): El[] {
    return k.children.filter((c) => c.tag !== "br" && c.anonymous === undefined && !this.outOfFlow(c, si) && this.displayOf(c, si) !== "none" && !(c.pseudo && this.floatsAtStart(c, si)));
  }

  /**
   * An inline-level box's extent around its own baseline, before its vertical-align (px): an inline
   * box's strut united with what its children add (each shifted by its own vertical-align), an
   * atomic inline's margin box (its baseline: its line's, or its bottom margin edge). `grown`: its
   * children reach past its strut (then its extent, and a vertical-align that depends on it, may
   * differ from line to line). undefined when it can't be told.
   */
  inlineExtent(k: El, si: number): { sa: number; sd: number; lh?: number; grown: boolean } | undefined {
    const atom = this.atomicBox(k, si);
    if (atom) return { sa: atom.a, sd: atom.hm - atom.a, grown: false };
    const inlineBox = this.displayOf(k, si) === "inline" || (k.pseudo !== undefined && this.ownDisplay(k, si) === "inline");
    if (!inlineBox) return undefined;
    const own = this.strutOf(k, si);
    if (!own) return undefined;
    let sa = own.sa;
    let sd = own.sd;
    for (const c of this.lineKids(k, si)) {
      const e = this.inlineExtent(c, si);
      const sh = e && this.ownShift(c, si, e);
      if (!e || sh === undefined) return undefined;
      sa = Math.max(sa, e.sa - sh);
      sd = Math.max(sd, e.sd + sh);
    }
    return { sa, sd, lh: own.lh, grown: sa > own.sa + 1e-9 || sd > own.sd + 1e-9 };
  }

  /**
   * How far an inline-level box's baseline sits below its line's (px, in layout units): its own
   * vertical-align shift and those of the inline boxes it is in. undefined where one isn't modelled.
   */
  baselineShift(k: El, si: number): number | undefined {
    const p = k.parent;
    const root = this.lineRoot(k, si);
    const e = this.inlineExtent(k, si);
    if (!p || !root || !e) return undefined;
    const own = this.ownShift(k, si, e);
    if (own === undefined) return undefined;
    if (p === root) return own;
    if (this.displayOf(p, si) !== "inline" || p.pseudo !== undefined) return undefined;
    const up = this.baselineShift(p, si);
    return up === undefined ? undefined : up + own;
  }

  /**
   * An inline box in a text box whose text and line box Cadesa measures: its own font (with metrics
   * and vertical metrics, no synthesized bold, upright or synthetic italic as its parent's), the same
   * letter-spacing as its parent's, a font size that doesn't follow the viewport, and a vertical-align
   * placed by baselineShift (one that depends on its extent only while nothing in it reaches past
   * its strut), inside inline boxes that are measured too.
   */
  runModelled(k: El, si: number): boolean {
    const root = this.lineRoot(k, si);
    if (!root || !k.parent) return false;
    const kt = this.textOf(k, si);
    const pt = this.textOf(k.parent, si);
    if (kt.fluid || pt.fluid || this.textOf(root, si).fluid || kt.letterSpacing !== pt.letterSpacing) return false;
    const m = metricsFor(kt.family.value);
    if (!m || !m.vertical(kt.size, kt.weight) || m.weightIssue(kt.weight)) return false;
    if (this.italic(k, si) !== this.italic(k.parent, si) && this.italicFace(firstFamily(kt.family.value)) !== false) return false;
    const e = this.inlineExtent(k, si);
    if (!e || !this.strutOf(root, si) || this.baselineShift(k, si) === undefined) return false;
    if (e.grown && this.alignsByExtent(k, si)) return false;
    return k.parent === root || (this.displayOf(k.parent, si) === "inline" && this.runModelled(k.parent, si));
  }

  /**
   * What an inline box of a text box changes in its text (see RunStyle): its font and size where
   * they differ from its parent's, and its own strut's extent around the line's baseline where it
   * may reach past the text box's. undefined when it isn't measured (runModelled).
   */
  runStyle(k: El, si: number): RunStyle | undefined {
    if (!k.parent || !this.runModelled(k, si)) return undefined;
    const kt = this.textOf(k, si);
    const pt = this.textOf(k.parent, si);
    const out: RunStyle = {};
    if (kt.family.value !== pt.family.value) out.font = kt.family.value;
    if (kt.size !== pt.size) out.size = kt.size;
    const own = this.strutOf(k, si)!;
    const rs = this.strutOf(this.lineRoot(k, si)!, si)!;
    const shift = this.baselineShift(k, si)!;
    const above = own.sa - shift;
    const below = own.sd + shift;
    if (above > rs.sa + 1e-9 || below > rs.sd + 1e-9) Object.assign(out, { above, below });
    return out;
  }

  /** An atomic inline's extent around its line's baseline, when it reaches past the line's strut (the line box is sized around it then). */
  pastStrut(k: El, si: number): { above: number; below: number } | undefined {
    const x = this.atomicExtent(k, si);
    const rs = this.strutOf(this.lineRoot(k, si)!, si);
    return x && rs && (x.above > rs.sa + 1e-9 || x.below > rs.sd + 1e-9) ? x : undefined;
  }

  /**
   * An atomic inline on a line of text: where its margin box sits around the line's baseline (px),
   * from its own baseline and the vertical-align of it and of the inline boxes it is in. undefined
   * when that isn't known.
   */
  atomicExtent(k: El, si: number): { above: number; below: number } | undefined {
    const atom = this.atomicBox(k, si);
    const root = this.lineRoot(k, si);
    if (!atom || !root || !this.strutOf(root, si)) return undefined;
    const shift = this.baselineShift(k, si);
    if (shift === undefined) return undefined;
    if (k.parent !== root && !this.runModelled(k.parent!, si)) return undefined;
    return { above: atom.a - shift, below: atom.hm - atom.a + shift };
  }

  /**
   * An inline-block alone on its line in block flow, as its parent's strut and its vertical-align
   * place it: how far the line box reaches above and below its margin box (0 when the box contains
   * the strut), from the font's vertical metrics. A box with text is checked with one line (more
   * lines only make it taller around the same baseline or middle); undefined when it can't be told.
   */
  lineReach(el: El, si: number): { top: number; bottom: number } | undefined {
    const x = this.lineExtents(el, si);
    if (!x) return undefined;
    const { a, hm, strut } = x;
    const eps = 1e-6;
    return { top: Math.max(0, strut.sa - a > eps ? strut.sa - a : 0), bottom: Math.max(0, strut.sd - (hm - a) > eps ? strut.sd - (hm - a) : 0) };
  }

  /**
   * An inline-block on a line of its parent's: how far the parent's baseline is below its margin
   * box's top (`a`, after its vertical-align), its margin box's height (`hm`) and the parent's
   * strut; undefined when it can't be told (see lineReach).
   */
  lineExtents(el: El, si: number): { a: number; hm: number; strut: { sa: number; sd: number } } | undefined {
    const parent = el.parent!;
    const res = (k: El, p: string) => {
      const o = k.own[si].get(p);
      return o ? this.resolve(k, si, o.value) : undefined;
    };
    const t = this.textOf(el, si);
    const px = (p: string) => {
      const o = el.own[si].get(p);
      const v = o ? this.resolveBox(el, si, o.value) : "0";
      return v === undefined ? NaN : (lengthPx(v, t.size) ?? NaN);
    };
    const bdr = (side: string) => (/^(none|hidden)$/.test(res(el, `border-${side}-style`) ?? "none") ? 0 : borderPx(px(`border-${side}-width`)));
    const strut = this.strutOf(parent, si);
    if (!strut) return undefined;
    const [mt, mb, pt, pb, bt, bb] = [px("margin-top"), px("margin-bottom"), px("padding-top"), px("padding-bottom"), bdr("top"), bdr("bottom")];
    if ([mt, mb, pt, pb].some((x) => !isFinite(x) || x < 0)) return undefined;
    if (["min-height", "max-height"].some((p) => !/^(auto|none|0|0px)?$/.test(res(el, p) ?? ""))) return undefined;
    let hm: number;
    let a: number;
    const ctype = el.tag === "input" ? (attr(el.node, "type") ?? "text").toLowerCase() : el.tag;
    const look = (res(el, "appearance") ?? res(el, "-webkit-appearance") ?? "auto") !== "none";
    const ch = CONTROL.has(el.tag) && !el.own[si].has("height") ? this.controlHeight(el, si) : undefined;
    if (ch !== undefined && (/^(checkbox|radio|range|textarea|submit|reset|button)$/.test(ctype) || (ctype === "select" && !look))) {
      // Its baseline (measured in Chromium): a checkbox's, radio's or range's border-box bottom; a
      // textarea's bottom margin edge (it scrolls); a button input's line of text at line-height:
      // normal, a select without native appearance its line. (A native select's line sits half a
      // pixel off its font's rounded ascent at some sizes, not modelled.)
      hm = mt + ch + mb;
      if (ctype === "textarea") a = hm;
      else if (/^(checkbox|radio|range)$/.test(ctype)) a = mt + ch;
      else {
        const v = metricsFor(t.family.value)?.vertical(t.size, t.weight);
        const own = this.strutOf(el, si);
        if (!v || !own) return undefined;
        a = mt + bt + pt + (ctype === "select" ? own.sa : v.ascent + Math.floor(v.lineGap / 2));
      }
    } else if (el.tag === "input" && !el.own[si].has("height")) {
      // A text field: one line of its text (never shorter than line-height: normal), its baseline
      // that line's (exactly so when its line height is at least normal: the line fills the field).
      const h = this.controlHeight(el, si);
      const own = this.strutOf(el, si);
      const normal = this.normalLine(t);
      if (h === undefined || !own || normal === undefined || own.lh < normal || !/^(text|email|password|search|tel|url|number)$/.test((attr(el.node, "type") ?? "text").toLowerCase())) return undefined;
      hm = mt + h + mb;
      a = mt + bt + pt + own.sa;
    } else if (el.roles[si] === "leaf") {
      // No line boxes: as tall as its height says, its baseline at its bottom margin edge.
      const h = px("height");
      if (!el.own[si].has("height") || !(h >= 0) || el.children.length) return undefined;
      const border = res(el, "box-sizing") === "border-box" ? Math.max(h, pt + pb + bt + bb) : h + pt + pb + bt + bb;
      hm = mt + border + mb;
      a = hm;
    } else {
      const own = this.strutOf(el, si);
      if (!own) return undefined;
      hm = mt + bt + pt + own.lh + pb + bb + mb;
      // A set height (one line of text in it, at its top; a <button> centers its content instead,
      // never above its content box's top, as Chromium does).
      let centered = 0;
      if (el.own[si].has("height") && !/^auto$/.test(res(el, "height") ?? "auto")) {
        const h = px("height");
        if (!(h >= 0)) return undefined;
        const border = res(el, "box-sizing") === "border-box";
        hm = mt + (border ? Math.max(h, pt + pb + bt + bb) : h + pt + pb + bt + bb) + mb;
        if (el.tag === "button") {
          const content = border ? Math.max(0, h - pt - pb - bt - bb) : h;
          centered = Math.max(0, Math.trunc(Math.round((content - own.lh) * 64) / 2) / 64);
        }
      }
      // Clipping its overflow, or layout containment, leaves it no baseline: its bottom margin edge is.
      const contained = this.containOf(el, si);
      if ((contained?.paint && !contained.layout) || contained?.size) return undefined;
      const clips = !/^(visible)?$/.test(res(el, "overflow-x") ?? "") || !/^(visible)?$/.test(res(el, "overflow-y") ?? "") || !!contained?.layout;
      a = clips ? hm : mt + bt + pt + centered + own.sa;
    }
    const va = res(el, "vertical-align") ?? "baseline";
    if (va === "middle") {
      // Its midpoint on the parent's baseline plus half its x-height (in layout units, as Chromium shifts it).
      const u = (x: number) => Math.round(x * 64);
      a = (u(a) - Math.trunc((u(a) - u(hm - a)) / 2)) / 64 + strut.xh2;
    } else if (va !== "baseline") return undefined;
    return { a, hm, strut };
  }

  /**
   * An inline-block alone on its line in block flow, laid out as a block of its content's width: its
   * line box is exactly its margin box when it contains the line's strut (known from the font's
   * vertical metrics, or when its text sits on the baseline in the same font, size and line height),
   * and its vertical margins can't collapse anyway (whatever they'd meet is zero). Alone in its
   * parent, a box of known height that the strut sticks out of (an icon) works too: the parent's
   * padding takes up what the line box adds around it (`linePad`).
   */
  aloneOnLine(el: El, si: number): boolean {
    const parent = el.parent;
    if (!parent || (el.roles[si] !== "text" && el.roles[si] !== "leaf") || el.pseudo) return false;
    if (parent !== this.bodyEl && !/^(block|flow-root|list-item|inline-block|table-cell|table-caption)$/.test(this.displayOf(parent, si))) return false;
    if (parent.ownText || (parent.children.some((k) => k.pseudo && !this.outOfFlow(k, si) && this.displayOf(k, si) !== "none"))) return false;
    const shown0 = (k: El) => this.displayOf(k, si) !== "none" && !this.outOfFlow(k, si);
    const sibs0 = parent.children.filter((k) => k !== el && shown0(k));
    if (sibs0.some((k) => this.isInlineLevel(k, si) || k.tag === "br" || k.anonymous !== undefined)) return false;
    const pt0 = this.textOf(parent, si);
    // Centered or end-aligned, it sits where auto inline margins put a block (with no margins of its own).
    const ta = pt0.inherited.get("text-align")?.value ?? "";
    const align = /^(start|left|unset|initial|-webkit-auto)?$/.test(ta) ? undefined : /^(center|-webkit-center)$/.test(ta) ? "center" : /^(right|end|-webkit-right)$/.test(ta) ? "end" : "other";
    if (align === "other") return false;
    if (align && ["margin-left", "margin-right"].some((p) => !/^(0|0px|auto)?$/.test(this.resolve(el, si, el.own[si].get(p)?.value ?? "") ?? "x"))) return false;
    (el.lineAlign ??= [])[si] = align;
    if (pt0.inherited.get("direction")?.value === "rtl") return false;
    if (!/^(normal|nowrap)?$/.test(pt0.inherited.get("white-space")?.value ?? "") || !/^(0|0px)?$/.test(pt0.inherited.get("text-indent")?.value ?? "")) return false;
    const reach = this.lineReach(el, si);
    if (reach) {
      const res0 = (k: El, p: string) => {
        const o = k.own[si].get(p);
        return o ? this.resolve(k, si, o.value) : undefined;
      };
      const px0 = (k: El, p: string) => lengthPx(res0(k, p) ?? "0", this.textOf(k, si).size) ?? NaN;
      // Alone in its parent: the parent's padding takes the line box's extent and the box's margins.
      const fixed = ["height", "min-height", "max-height"].some((p) => !/^(auto|none|0|0px)?$/.test(res0(parent, p) ?? ""));
      // (Text whose line count isn't known yet only when it contains the strut: more lines don't change that.)
      const reaches = reach.top > 0 || reach.bottom > 0;
      // Text placed for one line (the strut reaches past it, or its height is set): exact while its
      // text takes one line, which dynamic() checks at each width.
      const sized = el.own[si].has("height") && !/^auto$/.test(res0(el, "height") ?? "auto");
      if (el.roles[si] === "text" && (reaches || sized) && !/^(nowrap|pre)$/.test(this.textOf(el, si).inherited.get("white-space")?.value ?? "")) (el.oneLine ??= [])[si] = true;
      if (!sibs0.length && parent !== this.bodyEl && !fixed && isFinite(px0(parent, "padding-top")) && isFinite(px0(parent, "padding-bottom"))) {
        const top = reach.top + px0(el, "margin-top");
        const bottom = reach.bottom + px0(el, "margin-bottom");
        if (top || bottom) (parent.linePad ??= [])[si] = { top, bottom };
        return true;
      }
      if (reach.top || reach.bottom) return false;
    } else if (el.roles[si] !== "text") return false;
    if (reach) return this.marginsMeetNothing(el, si);
    // Without vertical metrics: text on the baseline in the same font, size and line height as the line's.
    const res = (k: El, p: string) => {
      const o = k.own[si].get(p);
      return o ? this.resolve(k, si, o.value) : undefined;
    };
    if (!/^(baseline)?$/.test(res(el, "vertical-align") ?? "") || !/^(visible)?$/.test(res(el, "overflow-x") ?? "") || !/^(visible)?$/.test(res(el, "overflow-y") ?? "") || this.containOf(el, si)) return false;
    if (parent !== this.bodyEl && !/^(block|flow-root|list-item|table-cell|table-caption)$/.test(this.displayOf(parent, si))) return false;
    const t = this.textOf(el, si);
    const pt = this.textOf(parent, si);
    const lh = (x: TextCtx) => (x.lineHeight === "normal" ? NaN : "num" in x.lineHeight ? lineHeightPx(x.size, x.lineHeight.num) : x.lineHeight.px);
    if (t.size !== pt.size || t.family.value !== pt.family.value || !(lh(t) === lh(pt))) return false;
    if (t.inherited.get("direction")?.value === "rtl") return false;
    const px = (k: El, p: string) => lengthPx(res(k, p) ?? "0", this.textOf(k, si).size) ?? NaN;
    // A set height shorter than its line of text (a 20px button on a 24px line): the parent's
    // strut sticks out of it, so the line box, not the box, is the height. Only a box at least
    // one line tall contains the strut.
    for (const p of ["height", "max-height"]) {
      const v = res(el, p);
      if (!v || /^(auto|none)$/.test(v)) continue;
      const set = lengthPx(v, t.size);
      const bdr = (side: string) => (/^(none|hidden)$/.test(res(el, `border-${side}-style`) ?? "none") ? 0 : borderPx(px(el, `border-${side}-width`)));
      const ins = res(el, "box-sizing") === "border-box" ? px(el, "padding-top") + px(el, "padding-bottom") + bdr("top") + bdr("bottom") : 0;
      if (set === undefined || !(set + 1e-6 >= lh(t) + ins)) return false;
    }
    return this.marginsMeetNothing(el, si);
  }

  /**
   * The vertical margins of an inline-block laid out as a block (alone on its line) meet nothing:
   * each is 0, or the neighbour's own margin is 0 and nothing collapses through it, or the parent's
   * padding, border or own formatting context keeps it in.
   */
  marginsMeetNothing(el: El, si: number): boolean {
    const parent = el.parent!;
    const res = (k: El, p: string) => {
      const o = k.own[si].get(p);
      return o ? this.resolve(k, si, o.value) : undefined;
    };
    const px = (k: El, p: string) => lengthPx(res(k, p) ?? "0", this.textOf(k, si).size) ?? NaN;
    const shown = (k: El) => this.displayOf(k, si) !== "none" && !this.outOfFlow(k, si);
    const sibs = parent.children.filter((k) => k !== el && shown(k));
    const edge = (k: El, side: "top" | "bottom") => px(k, `padding-${side}`) > 0 || (px(k, `border-${side}-width`) > 0 && !/^(none|hidden)$/.test(res(k, `border-${side}-style`) ?? "none"));
    // A margin that would meet nothing: the neighbour's own margin is 0 and nothing collapses through it.
    const tight = (k: El, side: "top" | "bottom") =>
      px(k, `margin-${side}`) === 0 && (k.roles[si] === "text" || k.roles[si] === "leaf" || edge(k, side) || /flex|grid/.test(this.displayOf(k, si)));
    const i = sibs.findIndex((k) => parent.children.indexOf(k) > parent.children.indexOf(el));
    const prev = (i < 0 ? sibs : sibs.slice(0, i)).at(-1);
    const next = i < 0 ? undefined : sibs[i];
    const parentDisplay = parent.parent ? this.displayOf(parent.parent, si) : "block";
    const ownContext = /^(inline-block|flow-root|table-cell|table-caption)$/.test(this.displayOf(parent, si)) || !/^(visible|clip)?$/.test(res(parent, "overflow-x") ?? "") || containsLayout(this.containOf(parent, si));
    const contained = (side: "top" | "bottom") => parent !== this.bodyEl && (edge(parent, side) || ownContext || /flex|grid/.test(parentDisplay));
    for (const side of ["top", "bottom"] as const) {
      const m = px(el, `margin-${side}`);
      if (!(m >= 0)) return false;
      if (m === 0) continue;
      const near = side === "top" ? prev : next;
      if (near ? !tight(near, side === "top" ? "bottom" : "top") : !contained(side)) return false;
    }
    return true;
  }

  /**
   * A block whose only content is two or more inline-blocks (a button group, badges in a row): they
   * share line boxes, wrapping between them, which is a wrapping flex row with the space between
   * them (one collapsed space of the block's font, or none) as its gap. On each line their baselines
   * (or middles) align with the block's strut; when every item reaches as far above and below the
   * baseline (one line of the same text style, or the same height), each line box is the union of
   * that and the strut, which their vertical margins take up. Text that wraps inside an item is
   * flagged at the widths where it does (dynamic()).
   */
  inlineRow(p: El, si: number): void {
    if (p.ownText || p.pseudo) return;
    if (p !== this.bodyEl && !/^(block|flow-root|list-item|inline-block|table-cell|table-caption)$/.test(this.displayOf(p, si))) return;
    const shown = (k: El) => this.displayOf(k, si) !== "none" && !this.outOfFlow(k, si);
    const items = p.children.filter(shown);
    if (items.length < 2 || items.some((k) => k.pseudo || k.anonymous !== undefined || k.tag === "br" || this.ownDisplay(k, si) !== "inline-block" || (k.roles[si] !== "text" && k.roles[si] !== "leaf"))) return;
    const pt = this.textOf(p, si);
    if (pt.fluid || pt.inherited.get("direction")?.value === "rtl") return;
    if (!/^(normal)?$/.test(pt.inherited.get("white-space")?.value ?? "") || !/^(wrap)?$/.test(pt.inherited.get("text-wrap-mode")?.value ?? "")) return;
    if (!/^(0|0px)?$/.test(pt.inherited.get("text-indent")?.value ?? "") || !/^(normal|0|0px)?$/.test(pt.inherited.get("word-spacing")?.value ?? "")) return;
    const ta = pt.inherited.get("text-align")?.value ?? "";
    const justify = /^(start|left|unset|initial|-webkit-auto)?$/.test(ta) ? "start" : /^(center|-webkit-center)$/.test(ta) ? "center" : /^(right|end|-webkit-right)$/.test(ta) ? "end" : undefined;
    if (!justify) return;
    // Whitespace between two items collapses to one space; none: no space.
    const nodes = p.node.childNodes ?? [];
    const at = items.map((k) => nodes.indexOf(k.node));
    const spaced = at.slice(1).map((j, i) => nodes.slice(at[i] + 1, j).some((c) => c.nodeName === "#text" && /[ \t\n\r\f]/.test(c.value ?? "")));
    if (spaced.some((x) => x !== spaced[0])) return;
    let gap = 0;
    if (spaced[0]) {
      const w = metricsFor(pt.family.value)?.measure(" ", pt.size, pt.weight);
      if (w === undefined) return;
      gap = w + pt.letterSpacing;
    }
    const ex = items.map((k) => this.lineExtents(k, si));
    if (ex.some((x) => !x)) return;
    const a = ex[0]!.a;
    const d = ex[0]!.hm - a;
    if (ex.some((x) => Math.abs(x!.a - a) > 1e-6 || Math.abs(x!.hm - x!.a - d) > 1e-6)) return;
    const strut = ex[0]!.strut;
    const eps = 1e-6;
    const top = strut.sa - a > eps ? strut.sa - a : 0;
    const bottom = strut.sd - d > eps ? strut.sd - d : 0;
    for (const k of items) {
      (k.rowLine ??= [])[si] = { top, bottom };
      if (k.roles[si] === "text" && !/^(nowrap|pre)$/.test(this.textOf(k, si).inherited.get("white-space")?.value ?? "")) (k.oneLine ??= [])[si] = true;
    }
    (p.inlineRow ??= [])[si] = { gap, justify };
  }

  /** Inline-blocks alone on their line, laid out as blocks (before any element is synthesized: a parent may take padding from one). */
  lineBoxes() {
    for (const el of this.els) {
      if (!el.parent || el.anonymous !== undefined) continue;
      this.states.forEach((_, si) => {
        const role = el.roles[si];
        if (!role || role === "hidden" || role === "out" || this.positioned(el, si)) return;
        const parentRole = el.parent !== this.bodyEl ? el.parent!.roles[si] : "page";
        const parentDisplay = el.parent !== this.bodyEl ? this.displayOf(el.parent!, si) : "block";
        if (/flex|grid/.test(parentDisplay) && parentRole === "container") return;
        if (this.ownDisplay(el, si) === "inline-block" && this.aloneOnLine(el, si)) el.alone[si] = true;
        if (role === "container") this.inlineRow(el, si);
        if (this.ownDisplay(el, si) === "inline" && role === "text") {
          const lh = this.inlineLine(el, si);
          if (lh !== undefined) (el.inlineLine ??= [])[si] = lh;
        }
      });
    }
  }

  /**
   * An inline element alone between blocks (its anonymous block holds nothing else), text on the
   * baseline: each of its lines is as tall as the union of the parent's strut and its own (from the
   * fonts' vertical metrics), so it lays out as a block of its text with that line height. Its own
   * rectangle (its text's content area) isn't that block's: noted as visual.
   */
  inlineLine(el: El, si: number): number | undefined {
    const parent = el.parent;
    if (!parent || el.pseudo || el.tag === "br" || REPLACED_BLOCK.has(el.tag) || CONTROL.has(el.tag)) return undefined;
    if (parent !== this.bodyEl && !/^(block|flow-root|list-item|inline-block|table-cell|table-caption)$/.test(this.displayOf(parent, si))) return undefined;
    const shown = (k: El) => k.anonymous !== undefined || (this.displayOf(k, si) !== "none" && !this.outOfFlow(k, si));
    const i = parent.children.indexOf(el);
    const near = [parent.children.slice(0, i).filter(shown).at(-1), parent.children.slice(i + 1).find(shown)];
    if (near.some((k) => k && (k.anonymous !== undefined || k.pseudo || k.tag === "br" || this.isInlineLevel(k, si)))) return undefined;
    const res = (p: string) => {
      const o = el.own[si].get(p);
      return o ? this.resolve(el, si, o.value) : undefined;
    };
    if (!/^(baseline)?$/.test(res("vertical-align") ?? "")) return undefined;
    const e = this.inlineEdges(el, si);
    if (!e || e.open || e.close) return undefined;
    const pt = this.textOf(parent, si);
    if (!/^(normal|nowrap)?$/.test(pt.inherited.get("white-space")?.value ?? "") || !/^(0|0px)?$/.test(pt.inherited.get("text-indent")?.value ?? "")) return undefined;
    // Its inline children in its own font and size (another one adds its own box to the line).
    const t = this.textOf(el, si);
    const same = (k: El): boolean => k.anonymous !== undefined || ((this.displayOf(k, si) === "none" || (this.textOf(k, si).size === t.size && this.textOf(k, si).family.value === t.family.value && JSON.stringify(this.textOf(k, si).lineHeight) === JSON.stringify(t.lineHeight))) && k.children.every(same));
    if (!el.children.every(same)) return undefined;
    const a = this.strutOf(parent, si);
    const b = this.strutOf(el, si);
    if (!a || !b) return undefined;
    return Math.max(a.sa, b.sa) + Math.max(a.sd, b.sd);
  }

  /** min-height no taller than one line of the element's text plus its padding and border (border-box). */
  minHeightMet(el: El, si: number): boolean {
    const t = this.textOf(el, si);
    const line = t.lineHeight === "normal" ? (this.normalLine(t) ?? NaN) : "num" in t.lineHeight ? lineHeightPx(t.size, t.lineHeight.num) : t.lineHeight.px;
    const v = (p: string) => {
      const d = el.own[si].get(p);
      const r = d ? this.resolveBox(el, si, d.value) : "0";
      return r === undefined ? NaN : (lengthPx(r, t.size) ?? NaN);
    };
    const border = (side: string) => (/^(none|hidden)$/.test(this.resolve(el, si, el.own[si].get(`border-${side}-style`)?.value ?? "none") ?? "none") ? 0 : borderPx(v(`border-${side}-width`)));
    const sizing = this.resolve(el, si, el.own[si].get("box-sizing")?.value ?? "content-box");
    const extra = sizing === "border-box" ? v("padding-top") + v("padding-bottom") + border("top") + border("bottom") : 0;
    return v("min-height") <= line + extra + 1e-6;
  }

  /**
   * A form control's intrinsic content width (px), as Chromium (Linux) sizes it, or undefined when
   * that isn't known:
   * - a select (one row): its widest option label in its font, rounded up to a whole px, plus the
   *   menulist's internal padding: 4px at the start and 16px at the end with native appearance
   *   (LayoutThemeDefault: the arrow's room), none with appearance: none;
   * - a text field: ceil(average character width × size) + maximum - average character width
   *   (LayoutTextControlSingleLine, size 20 unless the size attribute says otherwise), from the font;
   * - a textarea: ceil(average character width × cols) + 15px for its vertical scrollbar;
   * - a submit, reset or button input: its label in its font (value, else "Submit" or "Reset");
   * - a checkbox or radio with native appearance: 13px, a range: 129px (border box).
   * All measured in Chromium with probe pages (see test/forms.test.ts).
   */
  controlWidth(el: El, si: number): number | undefined {
    if (!CONTROL.has(el.tag)) return undefined;
    const res = (p: string) => {
      const o = el.own[si].get(p);
      return o ? this.resolve(el, si, o.value) : undefined;
    };
    const t = this.textOf(el, si);
    if (t.fluid) return undefined;
    const native = (res("appearance") ?? res("-webkit-appearance") ?? "auto") !== "none";
    const type = el.tag === "input" ? (attr(el.node, "type") ?? "text").toLowerCase() : el.tag;
    const px = (p: string) => lengthPx(res(p) ?? "0", t.size) ?? NaN;
    const bdr = (side: string) => (/^(none|hidden)$/.test(res(`border-${side}-style`) ?? "none") ? 0 : borderPx(px(`border-${side}-width`)));
    const insX = px("padding-left") + px("padding-right") + bdr("left") + bdr("right");
    // Fixed sizes from the theme (border box).
    if ((type === "checkbox" || type === "radio") && native) return isFinite(insX) ? Math.max(0, 13 - insX) : undefined;
    if (type === "range" && native) return isFinite(insX) ? Math.max(0, 129 - insX) : undefined;
    const m = metricsFor(t.family.value);
    if (!m || m.weightIssue(t.weight) || t.letterSpacing || !/^(none)?$/.test(t.inherited.get("text-transform")?.value ?? "")) return undefined;
    if (el.tag === "select") {
      if (attr(el.node, "multiple") !== undefined || Number(attr(el.node, "size") ?? "1") > 1) return undefined;
      const labels: string[] = [];
      for (const c of el.node.childNodes ?? []) {
        if (c.tagName === "optgroup") return undefined;
        if (c.tagName !== "option") continue;
        const label = attr(c, "label") ?? (c.childNodes ?? []).map((x) => x.value ?? "").join("");
        labels.push(label.replace(/[ \t\n\r\f]+/g, " ").trim());
      }
      if (labels.some((l) => m.unsupported(l).length)) return undefined;
      const widest = Math.max(0, ...labels.map((l) => m.measure(l, t.size, t.weight) ?? NaN));
      if (!isFinite(widest)) return undefined;
      return Math.ceil(widest - 1e-9) + (native ? 20 : 0);
    }
    const v = m.vertical(t.size, t.weight);
    if (el.tag === "textarea") {
      const cols = Number(attr(el.node, "cols") ?? "20");
      if (!v || v.avgChar === undefined || !Number.isInteger(cols) || cols < 1 || res("overflow-y") !== undefined || res("overflow-x") !== undefined) return undefined;
      return v.avgChar * cols + 15;
    }
    if (/^(text|email|password|tel|url)$/.test(type) || (type === "number" && attr(el.node, "size") === undefined)) {
      const n = Number(attr(el.node, "size") ?? "20");
      const size = Number.isInteger(n) && n > 0 ? n : 20;
      if (!v || v.avgChar === undefined || v.maxChar === undefined) return undefined;
      return v.avgChar * size + v.maxChar - v.avgChar;
    }
    if (/^(submit|reset|button)$/.test(type)) {
      const label = (attr(el.node, "value") ?? (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "")).replace(/[ \t\n\r\f]+/g, " ").trim();
      if (m.unsupported(label).length) return undefined;
      const w = m.measure(label, t.size, t.weight);
      return w === undefined ? undefined : Math.ceil(w * 64 - 1e-6) / 64;
    }
    return undefined;
  }

  /**
   * A form control's border-box height (px), or undefined when that isn't known: a text field,
   * select or textarea without native appearance, one line of its line height (× rows for a
   * textarea) plus padding and border; a text field with native appearance too, its line never
   * shorter than line-height: normal; with native appearance, a select's line at line-height:
   * normal plus 2px and a submit, reset or button input's line at line-height: normal (Chromium
   * sets both lines' height itself), plus padding and border; a checkbox or radio, 13px; a range, 16px.
   */
  controlHeight(el: El, si: number): number | undefined {
    const res = (p: string) => {
      const o = el.own[si].get(p);
      return o ? this.resolve(el, si, o.value) : undefined;
    };
    const type = (attr(el.node, "type") ?? "text").toLowerCase();
    const t = this.textOf(el, si);
    const nativeLook = (res("appearance") ?? res("-webkit-appearance") ?? "auto") !== "none";
    const limited = ["min-height", "max-height"].some((p) => !/^(auto|none|0|0px)?$/.test(res(p) ?? ""));
    if (el.tag === "input" && nativeLook && /^(checkbox|radio|range)$/.test(type)) return limited ? undefined : type === "range" ? 16 : 13;
    const pxY = (p: string) => lengthPx(res(p) ?? "0", t.size) ?? NaN;
    const edgesY = () => ["top", "bottom"].reduce((h, side) => h + pxY(`padding-${side}`) + (/^(none|hidden)$/.test(res(`border-${side}-style`) ?? "none") ? 0 : borderPx(pxY(`border-${side}-width`))), 0);
    if (nativeLook && !limited && ((el.tag === "select" && attr(el.node, "multiple") === undefined && Number(attr(el.node, "size") ?? "1") <= 1) || (el.tag === "input" && /^(submit|reset|button)$/.test(type)))) {
      const normal = this.normalLine(t);
      const h = normal === undefined ? NaN : normal + (el.tag === "select" ? 2 : 0) + edgesY();
      return isFinite(h) ? h : undefined;
    }
    // A text field's line, with or without native appearance, is never shorter than line-height:
    // normal (its font's ascent, descent and line gap). Otherwise only without native appearance.
    const field = el.tag === "input" && /^(text|email|password|search|tel|url|number)$/.test(type);
    const normal = this.normalLine(t);
    if (!(field && normal !== undefined) && el.tag !== "textarea" && (res("appearance") ?? res("-webkit-appearance")) !== "none") return undefined;
    if (el.tag === "input" && !/^(text|email|password|search|tel|url)$/.test(type) && !(field && normal !== undefined)) return undefined;
    if (el.tag === "select" && (attr(el.node, "multiple") !== undefined || Number(attr(el.node, "size") ?? "1") > 1)) return undefined;
    const set = t.lineHeight === "normal" ? normal : "num" in t.lineHeight ? lineHeightPx(t.size, t.lineHeight.num) : t.lineHeight.px;
    const line = field && normal !== undefined && set !== undefined ? Math.max(set, normal) : set;
    if (line === undefined) return undefined;
    const rows = el.tag === "textarea" ? Number(attr(el.node, "rows") ?? "2") : 1;
    if (!(rows >= 1) || !Number.isInteger(rows)) return undefined;
    const px = (p: string) => lengthPx(res(p) ?? "0", t.size) ?? NaN;
    let h = rows * line;
    for (const side of ["top", "bottom"]) {
      h += px(`padding-${side}`);
      if (!/^(none|hidden)$/.test(res(`border-${side}-style`) ?? "none")) h += borderPx(px(`border-${side}-width`));
    }
    if (!isFinite(h)) return undefined;
    // min-height / max-height that would change it: not this simple case.
    const min = el.own[si].get("min-height") ? this.resolveBox(el, si, el.own[si].get("min-height")!.value) : undefined;
    const max = res("max-height");
    if ((min && !/^(auto|0(px)?)$/.test(min) && !(lengthPx(min, t.size)! <= h)) || (max && max !== "none")) return undefined;
    return h;
  }

  /**
   * ::before and ::after with content become the first and last children of their element (after
   * the cascade, so no selector sees them), with the declarations their own cascade gives them.
   * One that is never laid out (no content, display: none, or absolutely positioned at every width)
   * moves nothing and isn't added.
   */
  pseudoElements() {
    for (const el of [...this.els]) {
      if (!el.pseudoOwn || REPLACED_BLOCK.has(el.tag) || CONTROL.has(el.tag) || el.tag === "br" || el.tag === "wbr") continue;
      for (const which of ["before", "after"] as const) {
        const owns = this.states.map((_, si) => el.pseudoOwn![si]?.[which]);
        if (!owns.some(Boolean)) continue;
        const p: El = {
          node: { nodeName: `::${which}` },
          tag: `::${which}`,
          classes: [],
          line: el.line,
          parent: el,
          children: [],
          index: -1,
          siblings: 0,
          ownText: false,
          roles: [],
          own: owns.map((o) => new Map(o ?? [])),
          text: [],
          decls: [],
          notes: new Map(),
          space: [],
          nowrap: [],
          rowGap: [],
          noShrink: [],
          asBlock: [],
          alone: [],
          baselineShift: [],
          pseudo: which,
        };
        this.expandDeferred(p);
        p.content = this.states.map((_, si) => {
          const o = p.own[si].get("content");
          const v = o ? this.resolve(p, si, o.value) : undefined;
          const c = v === undefined ? undefined : contentText(v);
          if (c === undefined) p.own[si] = new Map([["display", { value: "none", utility: "content: none" }]]);
          return c;
        });
        if (this.states.every((_, si) => p.content![si] === undefined || this.displayOf(p, si) === "none" || this.positioned(p, si))) continue;
        p.ownText = p.content.some((c) => c !== undefined && (typeof c !== "string" || !isWs(c)));
        if (which === "before") el.children.unshift(p);
        else el.children.push(p);
        this.els.push(p);
      }
    }
  }

  /** Whether anything floats in state si, beside generated content floated to the start of a text box's line and floats beside their parent's content. */
  floats(si: number): boolean {
    const cache = (this.floatCache ??= []);
    return (cache[si] ??= this.els.some((e) => {
      const o = e.own[si]?.get("float");
      const v = o ? this.resolve(e, si, o.value) : undefined;
      if (!v || !/^(left|right|inline-start|inline-end)$/.test(v) || this.displayOf(e, si) === "none" || this.positioned(e, si)) return false;
      const parentDisplay = e.parent ? this.displayOf(e.parent, si) : "block";
      if (/flex|grid/.test(parentDisplay)) return false;
      return !(e.pseudo && this.floatsAtStart(e, si)) && !this.asideFloat(e, si);
    }));
  }
  floatCache?: boolean[];

  /** A ::before / ::after floated to the start of its element's first line (Bootstrap's breadcrumb divider), when that is exact: see inlineContent. */
  floatsAtStart(p: El, si: number): boolean {
    const v = (q: string) => {
      const o = p.own[si].get(q);
      return o ? this.resolve(p, si, o.value) : undefined;
    };
    return p.pseudo === "before" && v("float") === "left" && !this.positioned(p, si);
  }

  /** Margin, border and padding at an inline box's start and end (px), or undefined when one isn't a length. */
  inlineEdges(el: El, si: number): { open: number; close: number } | undefined {
    const size = this.textOf(el, si).size;
    const px = (p: string) => {
      const o = el.own[si].get(p);
      if (!o) return 0;
      const v = this.resolveBox(el, si, o.value);
      if (v === undefined || v === "auto") return v === "auto" && p.startsWith("margin") ? 0 : NaN;
      return lengthPx(v, size) ?? NaN;
    };
    const border = (side: string) => (/^(none|hidden)$/.test(this.resolve(el, si, el.own[si].get(`border-${side}-style`)?.value ?? "none") ?? "none") ? 0 : borderPx(px(`border-${side}-width`)));
    const open = px("margin-left") + border("left") + px("padding-left");
    const close = px("margin-right") + border("right") + px("padding-right");
    return isFinite(open) && isFinite(close) ? { open, close } : undefined;
  }

  /**
   * A percentage height the engine resolves: the element is the only in-flow child of a block or
   * column flex container that a flex row or grid stretches (align-self stretch, no height or
   * min/max-height of its own), and its padding and border are inside its height (border-box, or none).
   */
  ofStretched(el: El, si: number): boolean {
    const parent = el.parent;
    const gp = parent?.parent;
    if (!parent || !gp || parent === this.bodyEl || this.positioned(el, si)) return false;
    const res = (k: El, p: string) => {
      const o = k.own[si]?.get(p);
      return o ? this.resolve(k, si, o.value) : undefined;
    };
    const shown = parent.children.filter((k) => k.roles[si] && k.roles[si] !== "hidden" && k.roles[si] !== "out");
    if (shown.length !== 1 || shown[0] !== el || parent.roles[si] !== "container") return false;
    const pd = this.displayOf(parent, si);
    if (!(/^(block|flow-root)$/.test(pd) || (/^flex$/.test(pd) && this.isColumn(parent, si)))) return false;
    const gd = this.displayOf(gp, si);
    const row = /^(inline-)?flex$/.test(gd) && !this.isColumn(gp, si);
    if (!row && !/^(inline-)?grid$/.test(gd)) return false;
    if (gp.roles[si] !== "container" || this.positioned(parent, si)) return false;
    const self = res(parent, "align-self") ?? "auto";
    const items = res(gp, "align-items") ?? "normal";
    if (!(/^(auto|normal|stretch)$/.test(self) && (self === "stretch" || /^(normal|stretch)$/.test(items)))) return false;
    if (["height", "min-height", "max-height"].some((p) => !/^(auto|none|0|0px)?$/.test(res(parent, p) ?? ""))) return false;
    if (["margin-top", "margin-bottom"].some((p) => res(parent, p) === "auto")) return false;
    // In a stretched grid row only (a flex row's line is as tall as its tallest item either way).
    const size = this.textOf(el, si).size;
    const px = (p: string) => lengthPx(res(el, p) ?? "0", size) ?? NaN;
    const edges = ["top", "bottom"].reduce((t, s) => t + px(`padding-${s}`) + (/^(none|hidden)$/.test(res(el, `border-${s}-style`) ?? "none") ? 0 : borderPx(px(`border-${s}-width`))), 0);
    return res(el, "box-sizing") === "border-box" || edges === 0;
  }

  /** Whether the element's text is italic (or oblique): its own font-style, its tag's default (em, i...), or its parent's. */
  italic(el: El | undefined, si: number): boolean {
    if (!el) return false;
    const o = el.own[si]?.get("font-style");
    const v = o ? this.resolve(el, si, o.value) : undefined;
    if (v && v !== "inherit") return /^(italic|oblique)/.test(v);
    if (/^(em|i|cite|dfn|var|address)$/.test(el.tag)) return true;
    return this.italic(el.parent, si);
  }

  /**
   * An atomic inline in a text box (an inline-block or replaced element: an icon <svg>, a badge of
   * set size): its margin-box width, when it is known (a height in px, a width in px or from its
   * aspect ratio, px margins) and the line box doesn't change around it (its margin box stays
   * within the strut of the line, from the font's vertical metrics). Then it is one unbreakable
   * object on its line. undefined otherwise.
   */
  atomicInline(k: El, si: number): number | ((sizePx: number) => number) | undefined {
    if (k.pseudo || k.anonymous !== undefined || !k.parent || this.outOfFlow(k, si)) return undefined;
    const d = this.displayOf(k, si);
    if (!(d === "inline-block" || (d === "inline" && REPLACED_BLOCK.has(k.tag)))) return undefined;
    if (!REPLACED_BLOCK.has(k.tag) && (k.ownText || k.children.length)) return this.atomicText(k, si);
    const g = this.atomicSized(k, si);
    if (!g) return undefined;
    const inside = (x: ReturnType<typeof g.at>) => !!x && x.above <= x.strut.sa + 1e-6 && x.below <= x.strut.sd + 1e-6;
    if (!g.fluid) {
      const x = g.at(g.size);
      // Past the line's strut: one object all the same, where its line box is sized around it (atomicExtent).
      return inside(x) || (x && this.atomicExtent(k, si)) ? x!.width : undefined;
    }
    // Every size the viewport can give it must keep the line box (checked every 10px of viewport width).
    const f = lengthExpr(g.fluid);
    if (!f) return undefined;
    for (let vw = 200; vw <= 3000; vw += 10) if (!inside(g.at(f.at(vw)))) return undefined;
    return (size: number) => g.at(size)?.width ?? 0;
  }

  /**
   * An atomic inline of set size (an inline-block or replaced element with a height, see
   * atomicInline): its geometry at a font size (its margin-box width, how far it reaches above and
   * below the baseline after its vertical-align, the line's strut, and before its vertical-align
   * its baseline from its margin box's top, `a0`, and its margin box's height, `hm`). undefined
   * when it isn't one.
   */
  atomicSized(k: El, si: number) {
    if (!k.parent) return undefined;
    const own = k.own[si];
    const t = this.textOf(k, si);
    const pt = this.textOf(k.parent, si);
    // A font size that follows the viewport: its em lengths follow it too (the same size as its line's).
    if ((t.fluid || pt.fluid) && (t.fluid !== pt.fluid || t.size !== pt.size)) return undefined;
    // Values with em kept (resolved at each font size), other units in px.
    const raw = (p: string) => {
      const o = own.get(p);
      const v = o ? this.resolve(k, si, o.value) : undefined;
      return v === undefined ? undefined : v.replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${parseFloat(n) * 16}px`);
    };
    const lu = (x: number) => Math.floor(x * 64 + 1e-6) / 64;
    // A checkbox, radio or range drawn by the theme: its size (border box), its baseline at its border box's bottom.
    const ctype = k.tag === "input" ? (attr(k.node, "type") ?? "text").toLowerCase() : "";
    const themed = /^(checkbox|radio|range)$/.test(ctype) && (raw("appearance") ?? raw("-webkit-appearance") ?? "auto") !== "none" && !own.has("width") && !own.has("height");
    const border = themed || raw("box-sizing") === "border-box";
    const hv = themed ? `${ctype === "range" ? 16 : 13}px` : raw("height");
    const wv = themed ? `${ctype === "range" ? 129 : 13}px` : (raw("width") ?? "auto");
    if (!hv || hv === "auto") return undefined;
    if (["min-width", "max-width", "min-height", "max-height"].some((p) => !/^(auto|none|0|0px)?$/.test(raw(p) ?? ""))) return undefined;
    const ar = raw("aspect-ratio");
    const arm = ar ? /^(?:auto\s+)?([\d.]+)\s*(?:\/\s*([\d.]+))?$/.exec(ar) : null;
    const ratio = arm ? parseFloat(arm[1]) / (arm[2] ? parseFloat(arm[2]) : 1) : NaN;
    const va = raw("vertical-align") ?? "baseline";
    /** Its margin-box width and how far it reaches above and below the baseline, at a font size. */
    const at = (size: number): { width: number; above: number; below: number; a0: number; hm: number; strut: { sa: number; sd: number; xh2: number } } | undefined => {
      const px = (p: string, def = "0") => lengthPx(raw(p) ?? def, size) ?? NaN;
      const bdr = (side: string) => (/^(none|hidden)$/.test(raw(`border-${side}-style`) ?? "none") ? 0 : borderPx(px(`border-${side}-width`)));
      const insX = px("padding-left") + px("padding-right") + bdr("left") + bdr("right");
      const insY = px("padding-top") + px("padding-bottom") + bdr("top") + bdr("bottom");
      const h = lu(lengthPx(hv, size) ?? NaN);
      if (!(h >= 0)) return undefined;
      const bh = border ? Math.max(h, insY) : h + insY;
      let bw: number;
      if (wv !== "auto") {
        const w = lu(lengthPx(wv, size) ?? NaN);
        if (!(w >= 0)) return undefined;
        bw = border ? Math.max(w, insX) : w + insX;
      } else {
        if (!(ratio > 0) || !isFinite(ratio) || insX || insY) return undefined;
        bw = h * ratio;
      }
      const [ml, mr, mt, mb] = ["margin-left", "margin-right", "margin-top", "margin-bottom"].map((p) => px(p));
      if (![ml, mr, mt, mb, bw, bh].every(isFinite)) return undefined;
      // The line's strut at this size, from the font's vertical metrics.
      const v = metricsFor(pt.family.value)?.vertical(size, pt.weight);
      if (!v) return undefined;
      const lh = pt.lineHeight === "normal" ? v.ascent + v.descent + v.lineGap : "num" in pt.lineHeight ? lineHeightPx(size, pt.lineHeight.num) : lu(pt.lineHeight.px);
      const leading = Math.round((lh - v.ascent - v.descent) * 64);
      const above0 = Math.floor(Math.trunc(leading / 2) / 64);
      const strut = { sa: v.ascent + above0, sd: v.descent + leading / 64 - above0, xh2: Math.round((v.xHeight / 2) * 64) / 64 };
      // Vertically: its margin box's bottom edge on the baseline (raised by a vertical-align length, or its middle on the x-height's).
      const hm = mt + bh + mb;
      const a0 = themed ? hm - mb : hm;
      let a = a0;
      if (va === "middle") {
        const u = (x: number) => Math.round(x * 64);
        a = (u(a) - Math.trunc((u(a) - u(hm - a)) / 2)) / 64 + strut.xh2;
      } else if (va !== "baseline") {
        const r = lengthPx(va, size);
        // A keyword (text-top, sub...) or percentage: placed by atomicExtent, never inside the strut here.
        if (r === undefined) a = Infinity;
        else a = a0 + r;
      }
      return { width: ml + bw + mr, above: a, below: hm - a, a0, hm, strut };
    };
    return { at, size: t.size, fluid: t.fluid };
  }

  /**
   * An inline-block holding one line of text in its own font (Font Awesome's <i class="fa">, a
   * Bootstrap Icons ::before, a short badge), inside a text box: its margin-box width when its text
   * is measured and its line box stays the parent line's (its own line, at its line height and font,
   * placed by vertical-align, within the parent's strut). undefined otherwise.
   */
  atomicText(k: El, si: number): number | undefined {
    const g = this.atomicTextBox(k, si);
    if (!g) return undefined;
    if (g.a > g.strut.sa + 1e-6 || g.hm - g.a > g.strut.sd + 1e-6) return this.atomicExtent(k, si) ? g.width : undefined;
    return g.width;
  }

  /**
   * An inline-block holding one line of text (see atomicText): its margin-box width, its baseline
   * from its margin box's top before (`a0`) and after (`a`) its vertical-align, its margin box's
   * height and its parent's strut. undefined when it isn't one.
   */
  atomicTextBox(k: El, si: number): { width: number; a0: number; a: number; hm: number; strut: { sa: number; sd: number } } | undefined {
    if (!k.parent || this.outOfFlow(k, si) || this.ownDisplay(k, si) !== "inline-block") return undefined;
    const t = this.textOf(k, si);
    if (t.fluid || this.textOf(k.parent, si).fluid) return undefined;
    // Its text: a pseudo-element's content, or its own text and inline generated content in its font.
    let text: string;
    if (k.pseudo) {
      const c = k.content?.[si];
      if (typeof c !== "string") return undefined;
      text = c;
    } else {
      const kids = k.children.filter((c) => this.displayOf(c, si) !== "none" && !this.outOfFlow(c, si));
      if (kids.some((c) => !c.pseudo || this.ownDisplay(c, si) !== "inline" || typeof c.content?.[si] !== "string" || c.children.length)) return undefined;
      const same = (c: El) => {
        const ct = this.textOf(c, si);
        return ct.size === t.size && ct.family.value === t.family.value && ct.weight === t.weight && ct.letterSpacing === t.letterSpacing;
      };
      if (!kids.every(same) || kids.some((c) => { const e = this.inlineEdges(c, si); return !e || e.open || e.close; })) return undefined;
      const own = (k.node.childNodes ?? []).filter((c) => c.nodeName === "#text").map((c) => c.value ?? "").join("");
      const before = kids.find((c) => c.pseudo === "before")?.content?.[si] as string | undefined;
      const after = kids.find((c) => c.pseudo === "after")?.content?.[si] as string | undefined;
      text = `${before ?? ""}${own}${after ?? ""}`;
    }
    text = text.replace(/[ \t\n\r\f]+/g, " ").trim();
    if (!text || /^(nowrap|pre)$/.test(t.inherited.get("white-space")?.value ?? "") === false && text.includes(" ")) return undefined;
    if (!/^(none)?$/.test(t.inherited.get("text-transform")?.value ?? "")) return undefined;
    const m = metricsFor(t.family.value);
    const v = m?.vertical(t.size, t.weight);
    if (!m || !v || m.unsupported(text).length || m.weightIssue(t.weight)) return undefined;
    const own = k.own[si];
    const res = (p: string) => {
      const o = own.get(p);
      return o ? this.resolveBox(k, si, o.value) : undefined;
    };
    if (["width", "height", "min-width", "max-width", "min-height", "max-height"].some((p) => !/^(auto|none|0|0px)?$/.test(res(p) ?? ""))) return undefined;
    const px = (p: string) => lengthPx(res(p) ?? "0", t.size) ?? NaN;
    const bdr = (side: string) => (/^(none|hidden)$/.test(this.resolve(k, si, own.get(`border-${side}-style`)?.value ?? "none") ?? "none") ? 0 : borderPx(px(`border-${side}-width`)));
    const [ml, mr, mt, mb, pl, pr, pt, pb] = ["margin-left", "margin-right", "margin-top", "margin-bottom", "padding-left", "padding-right", "padding-top", "padding-bottom"].map(px);
    if (![ml, mr, mt, mb, pl, pr, pt, pb].every(isFinite)) return undefined;
    // Its width: its text's max-content width (rounded up to a layout unit) and its edges.
    const textW = (m.measure(text, t.size, t.weight, t.letterSpacing !== 0) ?? NaN) + [...text].length * t.letterSpacing;
    if (!isFinite(textW)) return undefined;
    const width = ml + bdr("left") + pl + Math.ceil(textW * 64 - 1e-6) / 64 + pr + bdr("right") + mr;
    // Its own line: its line height, its baseline where its font's strut puts it.
    const lu = (x: number) => Math.floor(x * 64 + 1e-6) / 64;
    const lh = t.lineHeight === "normal" ? v.ascent + v.descent + v.lineGap : "num" in t.lineHeight ? lineHeightPx(t.size, t.lineHeight.num) : lu(t.lineHeight.px);
    const leading = Math.round((lh - v.ascent - v.descent) * 64);
    const sa = v.ascent + Math.floor(Math.trunc(leading / 2) / 64);
    const hm = mt + bdr("top") + pt + lh + pb + bdr("bottom") + mb;
    const a0 = mt + bdr("top") + pt + sa;
    let a = a0;
    const strut = this.strutOf(k.parent, si);
    if (!strut) return undefined;
    const va = res("vertical-align") ?? "baseline";
    if (va === "middle") {
      const u = (x: number) => Math.round(x * 64);
      a = (u(a) - Math.trunc((u(a) - u(hm - a)) / 2)) / 64 + strut.xh2;
    } else if (va !== "baseline") {
      const r = lengthPx(va, t.size);
      // A keyword (text-top, sub...) or percentage: placed by atomicExtent, never inside the strut here.
      a = r === undefined ? Infinity : a + r;
    }
    return { width, a0, a, hm, strut };
  }

  /**
   * An atomic inline on a line of text (atomicSized, atomicTextBox): its margin-box width, its
   * baseline from its margin box's top and its margin box's height, before its vertical-align.
   * Only at a font size that doesn't follow the viewport; undefined otherwise.
   */
  atomicBox(k: El, si: number): { width: number; a: number; hm: number } | undefined {
    if (k.anonymous !== undefined || !k.parent || this.outOfFlow(k, si)) return undefined;
    const d = this.ownDisplay(k, si);
    if (k.pseudo) {
      if (d !== "inline-block" || this.floatsAtStart(k, si)) return undefined;
      const g = this.atomicTextBox(k, si);
      return g && { width: g.width, a: g.a0, hm: g.hm };
    }
    const dd = this.displayOf(k, si);
    if (!(dd === "inline-block" || (dd === "inline" && REPLACED_BLOCK.has(k.tag)))) return undefined;
    if (!REPLACED_BLOCK.has(k.tag) && (k.ownText || k.children.length)) {
      const g = this.atomicTextBox(k, si);
      return g && { width: g.width, a: g.a0, hm: g.hm };
    }
    const g = this.atomicSized(k, si);
    const x = g && !g.fluid ? g.at(g.size) : undefined;
    return x && { width: x.width, a: x.a0, hm: x.hm };
  }

  /** Whether a text box has inline elements with a weight or edges of their own (its text is then measured run by run). */
  styledInline(el: El, si: number): boolean {
    const visit = (k: El): boolean => {
      if (this.atomicInline(k, si) !== undefined) return true;
      if (k.pseudo || k.anonymous !== undefined || k.tag === "br" || this.displayOf(k, si) === "none" || this.outOfFlow(k, si) || this.displayOf(k, si) !== "inline") return false;
      if (this.textOf(k, si).weight !== this.textOf(k.parent, si).weight) return true;
      const st = this.runStyle(k, si);
      if (st && (st.font !== undefined || st.size !== undefined || st.above !== undefined)) return true;
      const e = this.inlineEdges(k, si);
      if (e && (e.open || e.close)) return true;
      return k.children.some(visit);
    };
    return el.children.some(visit);
  }

  /**
   * What each inline element of a text box adds to its text in state si: a weight of its own,
   * margin, border and padding at its edges, and ::before / ::after content.
   */
  inlineInfo(root: El, si: number, byNode: Map<P5, El>): (n: P5Node) => InlineInfo | undefined {
    return (n) => {
      const el = byNode.get(n as unknown as P5);
      if (!el) return undefined;
      const out: InlineInfo = {};
      const atomic = el !== root ? this.atomicInline(el, si) : undefined;
      if (atomic !== undefined) return { atomic, ...this.pastStrut(el, si) };
      if (el !== root && this.displayOf(el, si) === "inline") {
        if (this.textOf(el, si).weight !== this.textOf(el.parent, si).weight) out.weight = this.textOf(el, si).weight;
        Object.assign(out, this.runStyle(el, si));
        const e = this.inlineEdges(el, si);
        if (e?.open) out.open = e.open;
        if (e?.close) out.close = e.close;
      }
      for (const p of el.children) {
        if (!p.pseudo) continue;
        const c = p.content?.[si];
        if (c === undefined || this.displayOf(p, si) === "none" || this.outOfFlow(p, si)) continue;
        const e = this.inlineEdges(p, si);
        // An inline-block of one line of text (an icon in its font): one object on the line.
        const atomic = this.ownDisplay(p, si) === "inline-block" && !this.floatsAtStart(p, si) ? this.atomicText(p, si) : undefined;
        const g: Generated = {
          text: typeof c === "string" ? c : "",
          ...(this.textOf(p, si).weight !== this.textOf(el, si).weight && { weight: this.textOf(p, si).weight }),
          ...(atomic === undefined && !this.floatsAtStart(p, si) && this.ownDisplay(p, si) === "inline" && this.runStyle(p, si)),
          ...(e?.open && { open: e.open }),
          ...(e?.close && { close: e.close }),
          ...(this.floatsAtStart(p, si) && { float: true }),
          ...(atomic !== undefined && { atomic, ...this.pastStrut(p, si) }),
        };
        out[p.pseudo!] = g;
      }
      return out;
    };
  }

  /**
   * Text directly inside an element that also has element children: each text node becomes an
   * anonymous child (after the cascade, so no selector matches it and :first-child etc. are
   * unchanged). In a flex or grid container it is an anonymous item; in block flow an anonymous
   * block, when nothing inline-level sits beside it (see textRun).
   */
  anonymousText() {
    const add = (el: El) => {
      const nodes = el.node.childNodes ?? [];
      if (el.children.length && el.ownText && el.tag !== "svg") {
        const out: El[] = [];
        const real = el.children.filter((c) => !c.pseudo);
        let k = 0;
        for (const n of nodes) {
          if (n.tagName && !SKIP.has(n.tagName)) out.push(real[k++]);
          else if (n.nodeName === "#text" && !isWs(n.value ?? "")) {
            const text = (n.value ?? "").replace(/[ \t\n\r\f]+/g, " ").trim();
            const a: El = {
              node: n,
              tag: "#text",
              classes: [],
              line: n.sourceCodeLocation?.startLine ?? el.line,
              parent: el,
              children: [],
              index: -1,
              siblings: 0,
              ownText: true,
              roles: [],
              own: this.states.map(() => new Map()),
              text: [],
              decls: [],
              notes: new Map(),
              space: [],
              nowrap: [],
              rowGap: [],
              noShrink: [],
              asBlock: [],
              alone: [],
              baselineShift: [],
              anonymous: text,
            };
            out.push(a);
            this.els.push(a);
          }
        }
        el.children.forEach(add);
        const before = el.children.filter((c) => c.pseudo === "before");
        const after = el.children.filter((c) => c.pseudo === "after");
        el.children = [...before, ...out, ...after];
      } else el.children.forEach(add);
    };
    if (this.bodyEl) this.bodyEl.children.forEach(add);
  }

  /**
   * Whether an anonymous text run lays out as a box of its own in state si: in a flex or grid
   * container always (each text run is an item); in block flow only when no inline-level element
   * sits next to it (they'd share its lines).
   */
  textRun(a: El, si: number): boolean {
    const p = a.parent!;
    if (/^(inline-)?(flex|grid)$/.test(this.displayOf(p, si))) return true;
    const sibs = p.children.filter((k) => k.tag === "#text" || (this.displayOf(k, si) !== "none" && !this.outOfFlow(k, si)));
    const i = sibs.indexOf(a);
    const near = [sibs[i - 1], sibs[i + 1]].filter(Boolean) as El[];
    return near.every((k) => k.tag !== "#text" && !this.isInlineLevel(k, si) && k.tag !== "br");
  }

  /**
   * Inline elements that lay out as blocks: an inline wrapping only block-level boxes (Angular's
   * component elements, which are inline unless a :host rule says otherwise), and an empty inline,
   * each alone between blocks (or in a flex or grid container, which blockifies it anyway). Neither
   * may have padding, border or inline margins (those make line boxes of their own).
   */
  inlineBlocks() {
    const px = (el: El, si: number, p: string) => {
      const o = el.own[si].get(p);
      const v = o ? this.resolve(el, si, o.value) : undefined;
      return v === undefined ? 0 : (lengthPx(v, this.textOf(el, si).size) ?? NaN);
    };
    const bare = (el: El, si: number) =>
      !el.ownText &&
      SIDES.every((s) => px(el, si, `padding-${s}`) === 0 && (px(el, si, `border-${s}-width`) === 0 || /^(none|hidden)$/.test(this.resolve(el, si, el.own[si].get(`border-${s}-style`)?.value ?? "none") ?? "none"))) &&
      px(el, si, "margin-left") === 0 && px(el, si, "margin-right") === 0;
    const shown = (el: El, si: number) => this.ownDisplay(el, si) !== "none" && !this.outOfFlow(el, si);
    const blockish = (el: El, si: number) => !!el.asBlock[si] || !/^(inline|inline-block|inline-flex|inline-grid|inline-flow-root|contents|none)$/.test(this.ownDisplay(el, si));
    /** Bottom-up: content that qualifies (no text, only block-level children). */
    const content = new Map<El, boolean[]>();
    const visit = (el: El) => {
      el.children.forEach(visit);
      content.set(
        el,
        this.states.map((_, si) => {
          if (this.ownDisplay(el, si) !== "inline" || el.tag === "br" || el.tag === "wbr" || el.tag === "svg" || REPLACED_BLOCK.has(el.tag) || !bare(el, si)) return false;
          const kids = el.children.filter((k) => shown(k, si));
          return kids.every((k) => content.get(k)![si] || blockish(k, si) || (k.tag === "br" ? false : false));
        }),
      );
    };
    if (this.bodyEl) visit(this.bodyEl);
    /** Top-down: alone between blocks, or blockified by a flex or grid parent. */
    const place = (el: El) => {
      this.states.forEach((_, si) => {
        if (!content.get(el)?.[si] || !el.parent) return;
        const pd = this.ownDisplay(el.parent, si);
        const blockified = /^(inline-)?(flex|grid)$/.test(pd);
        const sibs = el.parent.children.filter((k) => k !== el && shown(k, si));
        const alone = !el.parent.ownText && (el.parent === this.bodyEl || el.parent.asBlock[si] || !/^inline/.test(pd)) && sibs.every((k) => content.get(k)![si] || blockish(k, si));
        if (!blockified && !alone) return;
        const empty = !el.children.some((k) => shown(k, si));
        // An empty one sits at the start of its line: only with text-align: start.
        if (empty && !blockified && !/^(start|left|unset|initial|-webkit-auto)?$/.test(this.textOf(el.parent, si).inherited.get("text-align")?.value ?? "")) return;
        if (empty && !blockified && SIDES.some((s) => px(el, si, `margin-${s}`) !== 0)) return;
        el.asBlock[si] = empty && !blockified ? "empty" : "block";
      });
      el.children.forEach(place);
    };
    if (this.bodyEl) this.bodyEl.children.forEach(place);
  }

  isTable(el: El, si: number) {
    return /^(inline-)?table$/.test(this.ownDisplay(el, si));
  }

  /** An inherited property only tables read (border-collapse, border-spacing, caption-side), as computed at `el`. */
  tableProp(el: El, si: number, p: string): string | undefined {
    for (let a: El | undefined = el; a; a = a.parent) {
      const o = a.own[si]?.get(p);
      const v = o ? this.resolve(a, si, o.value)?.trim() : undefined;
      if (v === "initial") return undefined;
      if (v && !/^(inherit|unset)$/.test(v)) return v;
    }
    // Tailwind: its preflight collapses a table's borders (the browser's defaults aren't in that cascade).
    if (!this.uaInCascade && p === "border-collapse" && this.preflight) return "collapse";
    return undefined;
  }

  /** A cell's vertical-align: its own, else (where the browser's defaults aren't in the cascade) its row's or row group's, else middle. */
  cellAlign(el: El, si: number): string | undefined {
    const own = (k: El | undefined) => {
      const o = k?.own[si]?.get("vertical-align");
      const v = o ? this.resolve(k!, si, o.value)?.trim() : undefined;
      return v && v !== "inherit" ? v : undefined;
    };
    if (this.uaInCascade) return own(el);
    if (el.tag !== "td" && el.tag !== "th") return own(el);
    const row = el.parent;
    const group = row?.parent && /^(thead|tbody|tfoot)$/.test(row.parent.tag) ? row.parent : undefined;
    return own(el) ?? own(row) ?? own(group) ?? "middle";
  }

  tableWhys = new Map<El, string | undefined>();
  /**
   * Why a table (display: table) isn't laid out as one, or undefined when it is: in every state it
   * holds only captions, columns, row groups, rows and cells where the browser expects them (anything
   * else gets anonymous boxes around it, which aren't modelled), left to right, nothing collapsed.
   */
  tableWhy(el: El): string | undefined {
    if (this.tableWhys.has(el)) return this.tableWhys.get(el);
    const why = this.computeTableWhy(el);
    this.tableWhys.set(el, why);
    return why;
  }

  computeTableWhy(table: El): string | undefined {
    for (let si = 0; si < this.states.length; si++) {
      const d = this.ownDisplay(table, si);
      if (this.displayOf(table, si) === "none" || !this.isTable(table, si)) continue;
      if (d === "inline-table") return "display: inline-table (a table on a line of text) isn't modelled";
      if (!this.uaInCascade && !this.preflight) return "a table without Tailwind's preflight keeps the browser's defaults for tables (cell padding, border spacing), which aren't read here";
      const res = (k: El, p: string) => {
        const o = k.own[si]?.get(p);
        return o ? this.resolve(k, si, o.value)?.trim() : undefined;
      };
      const collapse = this.tableProp(table, si, "border-collapse") === "collapse";
      const shown = (k: El) => k.anonymous !== undefined || (this.displayOf(k, si) !== "none" && !this.outOfFlow(k, si));
      const part = (k: El) => TABLE_PART[this.displayOf(k, si)];
      const check = (k: El): string | undefined => {
        if (k.pseudo) return `generated content (::${k.pseudo}) in a table part gets an anonymous box, which isn't modelled`;
        if (k.anonymous !== undefined) return "text directly in a table, row group or row gets an anonymous cell, which isn't modelled";
        if (res(k, "visibility") === "collapse") return "visibility: collapse on a table part isn't modelled";
        if ((res(k, "direction") ?? this.textOf(k, si).inherited.get("direction")?.value) === "rtl") return "a right-to-left table isn't modelled";
        if (!/^(horizontal-tb)?$/.test(res(k, "writing-mode") ?? "")) return "a vertical writing mode in a table isn't modelled";
        if (collapse && ["top", "right", "bottom", "left"].some((s) => res(k, `border-${s}-style`) === "hidden")) return "border-style: hidden in a table with collapsed borders isn't modelled";
        if (/%/.test(res(k, "height") ?? "") && k !== table) return "a percentage height on a table part isn't modelled";
        return undefined;
      };
      const own = check(table);
      if (own) return own;
      if (table.ownText) return "text directly in a table gets an anonymous cell, which isn't modelled";
      const kids = (k: El) => k.children.filter(shown);
      const cells = (row: El): string | undefined => {
        if (row.ownText) return "text directly in a table row gets an anonymous cell, which isn't modelled";
        for (const c of kids(row)) {
          const w = check(c) ?? (part(c) !== "cell" ? `<${c.tag}> in a table row gets an anonymous cell around it, which isn't modelled` : undefined);
          if (w) return w;
        }
        return undefined;
      };
      const rows = (group: El): string | undefined => {
        if (group.ownText) return "text directly in a table row group gets an anonymous cell, which isn't modelled";
        for (const r of kids(group)) {
          const w = check(r) ?? (part(r) === "row" ? cells(r) : part(r) === "cell" ? undefined : `<${r.tag}> in a table row group gets an anonymous row around it, which isn't modelled`);
          if (w) return w;
        }
        return undefined;
      };
      for (const k of kids(table)) {
        const p = part(k);
        const w =
          check(k) ??
          (p === "header" || p === "body" || p === "footer"
            ? rows(k)
            : p === "row"
              ? cells(k)
              : p === "column-group"
                ? kids(k).find((c) => part(c) !== "column") && `<${kids(k).find((c) => part(c) !== "column")!.tag}> in a column group isn't modelled`
                : p === "caption" || p === "column" || p === "cell"
                  ? undefined
                  : `<${k.tag}> in a table gets an anonymous cell around it, which isn't modelled`);
        if (w) return w;
      }
    }
    return undefined;
  }

  /** What `el` is in a table Cadesa lays out (cell, row, body...), or undefined. */
  tablePart(el: El, si: number): string | undefined {
    const part = TABLE_PART[this.displayOf(el, si)];
    if (!part || !el.parent) return undefined;
    const table = this.tableOf(el.parent, si);
    return table && !this.tableWhy(table) ? part : undefined;
  }

  /** The table whose parts' parent `el` is: the table itself, or a row group, row or column group in it. */
  tableOf(el: El, si: number): El | undefined {
    for (let a: El | undefined = el; a; a = a.parent) {
      if (this.isTable(a, si)) return a;
      if (!/^table-(row|row-group|header-group|footer-group|column-group)$/.test(this.displayOf(a, si))) return undefined;
    }
    return undefined;
  }

  isInlineLevel(el: El, si: number) {
    return /^(inline|inline-block|inline-flex|inline-grid|inline-flow-root|contents)$/.test(this.displayOf(el, si));
  }

  outOfFlow(el: El, si: number) {
    const p = el.own[si].get("position");
    const v = p ? this.resolve(el, si, p.value) : undefined;
    return v === "absolute" || v === "fixed" || this.asideFloat(el, si);
  }

  /**
   * A left float that changes nothing around it: the first thing in its parent, pulled entirely
   * into the parent's padding by a negative left margin (so no line beside it is shortened), and
   * no taller than the parent's first line (so nothing below meets it). Bootstrap's .form-check
   * checkbox. It isn't laid out (its own box isn't predicted).
   */
  asideFloat(el: El, si: number): boolean {
    const o = el.own[si].get("float");
    if (!o || this.resolve(el, si, o.value) !== "left" || !el.parent || el.pseudo) return false;
    const parent = el.parent;
    if (parent.ownText && !(parent.node.childNodes ?? []).slice(0, (parent.node.childNodes ?? []).indexOf(el.node)).every((c) => c.nodeName !== "#text" || /^\s*$/.test(c.value ?? ""))) return false;
    if (parent.children[0] !== el) return false;
    const px = (p: string) => {
      const d = el.own[si].get(p);
      const v = d ? this.resolveBox(el, si, d.value) : "0";
      return v === undefined ? NaN : (lengthPx(v, this.textOf(el, si).size) ?? NaN);
    };
    const border = (side: string) => (/^(none|hidden)$/.test(this.resolve(el, si, el.own[si].get(`border-${side}-style`)?.value ?? "none") ?? "none") ? 0 : borderPx(px(`border-${side}-width`)));
    const sizing = this.resolve(el, si, el.own[si].get("box-sizing")?.value ?? "content-box");
    const box = (size: string, a: string, b: string) => px(size) + (sizing === "border-box" ? 0 : px(`padding-${a}`) + px(`padding-${b}`) + border(a) + border(b));
    const w = box("width", "left", "right");
    const h = box("height", "top", "bottom");
    if (!(px("margin-left") + w + px("margin-right") <= 0)) return false;
    const pt = this.textOf(parent, si);
    const line = pt.lineHeight === "normal" ? NaN : "num" in pt.lineHeight ? lineHeightPx(pt.size, pt.lineHeight.num) : pt.lineHeight.px;
    return px("margin-top") >= 0 && px("margin-top") + h + px("margin-bottom") <= line;
  }

  /**
   * Inline children make an element a text box when every element child is inline in every state
   * where it is displayed (`<span class="d-none d-md-inline">`: its text is left out where it's hidden).
   */
  inlineChild(el: El): boolean {
    if (el.tag === "br" || this.ignorable(el)) return true;
    // A replaced element or control is inline content only as an atomic inline of known size (see atomicInline).
    if (REPLACED_BLOCK.has(el.tag) || INLINE_BLOCK.has(el.tag)) return this.states.some((_, si) => this.displayOf(el, si) !== "none") && this.states.every((_, si) => this.displayOf(el, si) === "none" || this.atomicInline(el, si) !== undefined);
    return this.states.every((_, si) => this.displayOf(el, si) === "none" || (this.isInlineLevel(el, si) && !this.outOfFlow(el, si)));
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
    // A table Cadesa can't lay out as one is one box; what's inside it isn't laid out. (Its parts
    // hold only parts, or a cell's content: a column's children aren't laid out either.)
    if (el.parent && el.parent !== this.bodyEl && this.states.some((_, si) => this.isTable(el.parent!, si)) && this.tableWhy(el.parent)) return;
    if (el.parent && el.parent !== this.bodyEl && this.states.some((_, si) => this.displayOf(el.parent!, si) === "table-column")) return;
    if (el.parent && el.parent !== this.bodyEl && el.parent.roles.length === 0) return;
    if (el.anonymous !== undefined) {
      // A text run beside element children: an anonymous text box (or, in a text box, part of its text).
      this.states.forEach((_, si) => {
        if (!el.parent || el.parent.roles[si] === "hidden") el.roles[si] = "hidden";
        else if (this.textOf(el, si).size === 0) {
          // In a font size of 0: no width, one line of its line height (see zeroText).
          const t = this.textOf(el, si);
          (el.zeroText ??= [])[si] = t.lineHeight !== "normal" && "px" in t.lineHeight ? t.lineHeight.px : 0;
          el.roles[si] = "leaf";
        } else el.roles[si] = "text";
      });
      return;
    }
    // Children of a flex or grid container are blockified: never inline content.
    const formatsChildren = this.states.some((_, si) => /^(inline-)?(flex|grid)$/.test(this.displayOf(el, si)));
    const allInline = el.children.length > 0 && !formatsChildren && el.children.every((c) => this.inlineChild(c));
    // Its only content inline-blocks (a badge alone in a div, buttons in a row): boxes on its lines (see aloneOnLine, inlineRow).
    const shownKids = el.children.filter((c) => !this.ignorable(c));
    const loneBlock =
      !el.ownText && shownKids.length >= 1 && shownKids.every((k) => !k.pseudo && k.anonymous === undefined && k.tag !== "br" && this.states.every((_, si) => this.displayOf(k, si) === "none" || this.ownDisplay(k, si) === "inline-block"));
    const hasText = !loneBlock && (el.ownText || (allInline && this.visibleText(el)));
    this.states.forEach((_, si) => {
      const d = this.displayOf(el, si);
      let role: Role;
      if (d === "none" || (el.parent && el.parent.roles[si] === "hidden")) role = "hidden";
      else if (this.asideFloat(el, si)) role = "out";
      else if (el.tag === "svg" || REPLACED_BLOCK.has(el.tag) || CONTROL.has(el.tag) || (this.isTable(el, si) && (!!this.tableWhy(el) || !el.children.some((k) => !this.ignorable(k))))) role = "leaf";
      // A column's (or an empty row's) children aren't laid out.
      else if (d === "table-column" || (/^table-(row|row-group|header-group|footer-group|column-group)$/.test(d) && !el.children.some((k) => !this.ignorable(k)))) role = "leaf";
      else if (hasText && el.children.length === 0 && this.textOf(el, si).size === 0 && !CONTROL.has(el.tag)) {
        // Text in a font size of 0 (an icon button hiding its label): no width, one line of its line height.
        const t = this.textOf(el, si);
        (el.zeroText ??= [])[si] = t.lineHeight !== "normal" && "px" in t.lineHeight ? t.lineHeight.px : 0;
        role = "leaf";
      } else if (hasText && (el.children.length === 0 || allInline)) role = "text";
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
      // An absolutely positioned or fixed box isn't a flex or grid item.
      const abs = this.positioned(el, si);
      const inFlexOrGrid = /flex|grid/.test(parentDisplay) && parentRole === "container" && !abs;

      // Inline-level boxes in block flow sit on line boxes, which Cadesa doesn't model, except an
      // inline-block alone on its line whose line box is exactly its margin box.
      const inlineLine = !inFlexOrGrid ? el.inlineLine?.[si] : undefined;
      if (inlineLine !== undefined) {
        this.note(el, si, { decl: `display: ${this.displayOf(el, si)}`, reason: "an inline box's own rectangle is its text's content area; Cadesa lays out its lines (exact), not that rectangle", kind: "visual" });
        if (!own.has("width")) decl("width", "fit-content", "an inline element alone between blocks");
      } else if (!inFlexOrGrid && this.isInlineLevel(el, si) && !el.alone[si] && !el.rowLine?.[si] && el.anonymous === undefined)
        this.note(el, si, { decl: `display: ${this.displayOf(el, si)}`, reason: "an inline-level box in block flow sits on a line box (baseline, line height, whitespace); Cadesa lays out block boxes", kind: "geometry" });
      // An empty inline (zero size where the next block starts) or a lone inline-block: as wide as its content.
      if (((el.asBlock[si] === "empty" && !inFlexOrGrid) || el.alone[si]) && !own.has("width")) decl("width", "fit-content", el.alone[si] ? "inline-block (alone on its line)" : "empty inline element");
      const lineAlign = el.alone[si] ? el.lineAlign?.[si] : undefined;
      if (lineAlign) {
        const why = `text-align: ${this.textOf(el.parent, si).inherited.get("text-align")?.value} on its line`;
        if (lineAlign === "center") decl("margin-left", "auto", why);
        decl("margin-right", lineAlign === "center" ? "auto" : "0px", why);
        if (lineAlign === "end") decl("margin-left", "auto", why);
      }

      // Sticky: in flow; it only moves once the page scrolls.
      const pos = res("position");
      if (pos === "sticky") this.note(el, si, { decl: own.get("position")!.utility, reason: "position: sticky; predicted at scroll position 0", kind: "none" });

      // A part of a table Cadesa lays out: margins apply to none but a caption, padding only to cells
      // and captions, widths not to rows and row groups, heights not to columns.
      const tpart = this.tablePart(el, si);
      const skipProp = (p: string) =>
        TABLE_INHERITED.has(p) || (p === "table-layout" && !this.isTable(el, si)) ||
        (!!tpart && /^margin-/.test(p) && tpart !== "caption") ||
        (!!tpart && /^padding-/.test(p) && tpart !== "caption" && tpart !== "cell") ||
        (!!tpart && /^(width|min-width|max-width)$/.test(p) && /^(row|header|body|footer)$/.test(tpart)) ||
        (!!tpart && /^(height|min-height|max-height)$/.test(p) && /^column/.test(tpart)) ||
        // Flex item properties do nothing outside a flex container (align-self: outside flex and grid).
        (/^(flex|flex-grow|flex-shrink|flex-basis|order)$/.test(p) && !(/flex/.test(parentDisplay) && parentRole === "container" && !abs)) ||
        (p === "align-self" && !inFlexOrGrid) ||
        // Grid lines place only a grid item.
        (/^grid-(row|column)-(start|end)$/.test(p) && !(inFlexOrGrid && /grid/.test(parentDisplay))) ||
        p.startsWith("--") || TEXT_PROPS.has(p) || INHERITED_OTHER.has(p) || INHERITED_PAINT.has(p) || p === "display" ||
        (pos === "sticky" && /^(top|right|bottom|left)$/.test(p)) || p === "z-index" ||
        // Offsets do nothing on a box that isn't positioned.
        (/^(top|right|bottom|left)$/.test(p) && !/^(relative|absolute|fixed|sticky)$/.test(pos ?? "static")) || p === "box-sizing" ||
        // vertical-align moves only inline-level boxes on a line (noted above, or alone on it) and table cells.
        (p === "vertical-align" && (!this.isInlineLevel(el, si) || inFlexOrGrid || res(p) === "baseline" || el.alone[si] || !!el.rowLine?.[si])) ||
        // Alone on a centered or end-aligned line, auto margins place it.
        (/^margin-(left|right)$/.test(p) && !!el.alone[si] && !!el.lineAlign?.[si]) ||
        // Alone in its parent on a line, its vertical margins are in the parent's padding.
        (/^margin-(top|bottom)$/.test(p) && !!el.parent?.linePad?.[si]) ||
        (/^padding-(top|bottom)$/.test(p) && !!el.linePad?.[si]) ||
        // A flex or grid item doesn't float; clear does nothing where nothing floats.
        (p === "float" && inFlexOrGrid) ||
        (p === "clear" && (inFlexOrGrid || abs || !this.floats(si))) ||
        p === "content";

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
          // A row that doesn't wrap is a one-line cluster (wrap: false): its items shrink to fit.
          decl("flex-wrap", dir === "row" && wrap === "nowrap" ? "nowrap" : wrap, own.get("flex-wrap")?.utility ?? "flex (no wrap)");
          handled.add("flex-direction").add("flex-wrap");
          let rowGap = this.pctRowGap(el, si, own.get("row-gap"));
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
          // A row's justify-content is the cluster's justify (lift maps it); a column's moves its items
          // only when it is taller than they are.
          const jc = res("justify-content");
          if (jc && dir === "column" && !/^(normal|flex-start|start|left)$/.test(jc) && (own.has("height") || own.has("min-height"))) {
            handled.add("justify-content");
            for (const c of kids) this.note(c, si, { decl: `${own.get("justify-content")!.utility} on the parent (justify-content: ${jc})`, reason: "moves the item down its column; Cadesa stacks items at the start", kind: "visual" });
          } else if (jc && dir === "column") handled.add("justify-content");
          const ai = res("align-items");
          // Across a column: start, center or end make each item as wide as its content (fit-content), placed there.
          if (dir === "column" && ai && /^(center|start|end|flex-start|flex-end|self-start|self-end|left|right|baseline|first baseline)$/.test(ai)) {
            decl("align-items", ai, own.get("align-items")!.utility);
            handled.add("align-items");
          } else if (dir === "column" && ai && !/^(normal|stretch)$/.test(ai)) {
            handled.add("align-items");
            for (const c of kids) {
              const fixed = c.own[si].has("width");
              this.note(c, si, c.roles[si] === "text" || fixed
                ? { decl: `${own.get("align-items")!.utility} on the parent (align-items: ${ai})`, reason: `the item isn't stretched: its width and x differ, ${fixed ? "its width is set" : "its text wraps the same"}, so its height doesn't`, kind: "visual" }
                : { decl: `${own.get("align-items")!.utility} on the parent (align-items: ${ai})`, reason: "the item isn't stretched; it's sized by its content, which Cadesa measures only for a single text run", kind: "geometry" });
            }
          }
          // Baselines in a row that doesn't wrap, of text items in one font, size and line height:
          // their first lines sit the same distance below their content edges, so aligning baselines
          // is aligning those edges: items start at the top, each pushed down by the difference.
          if (dir === "row" && ai && /^(first )?baseline$/.test(ai)) {
            const shifts = this.baselineShifts(kids, si);
            if (shifts && wrap === "nowrap") {
              decl("align-items", "flex-start", `${own.get("align-items")!.utility} (align-items: ${ai}, items in one font: their tops align)`);
              handled.add("align-items");
              kids.forEach((c, i) => (c.baselineShift[si] = shifts[i]));
            }
          }
        } else if (grid) {
          const cols = res("grid-template-columns");
          const gapOrigin = this.pctRowGap(el, si, own.get("row-gap"), true);
          const rowGap = gapOrigin ? this.len(el, si, gapOrigin) : undefined;
          const colGap = own.has("column-gap") ? this.len(el, si, own.get("column-gap")!) : undefined;
          const n = cols ? /^repeat\(\s*(\d+)\s*,\s*minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s*\)$/.exec(cols) : null;
          handled.add("grid-template-columns").add("row-gap").add("column-gap").add("align-items").add("justify-items");
          const ji = res("justify-items");
          const ai = res("align-items");
          const plainItems = (!ji || /^(stretch|normal|legacy)$/.test(ji)) && (!ai || /^(stretch|normal)$/.test(ai));
          // A set height or min-height stretches a grid's rows (a stack's items don't).
          const sized = ["height", "min-height"].some((p) => own.has(p) && !/^(auto|0(px)?)$/.test(res(p) ?? "auto"));
          const single = !cols || cols === "none" || (n && n[1] === "1");
          const kids = el.children.filter((c) => c.roles[si] && c.roles[si] !== "hidden" && c.roles[si] !== "out");
          // A template beyond columns (rows, areas, implicit tracks, dense flow, content alignment) or
          // items placed on lines, aligned on their own or with auto margins: CSS Grid's own algorithm.
          const TEMPLATE: [string, RegExp][] = [["grid-template-rows", /^none$/], ["grid-template-areas", /^none$/], ["grid-auto-rows", /^auto$/], ["grid-auto-columns", /^auto$/], ["grid-auto-flow", /^row$/], ["justify-content", /^(normal|stretch)$/], ["align-content", /^(normal|stretch)$/]];
          const template = TEMPLATE.filter(([p, def]) => own.has(p) && !def.test(res(p) ?? ""));
          const placedKids = kids.some((k) => {
            const kr = (p: string) => (k.own[si]?.has(p) ? this.resolve(k, si, k.own[si].get(p)!.value) : undefined);
            return ["grid-row-start", "grid-row-end", "grid-column-start", "grid-column-end"].some((p) => !/^(auto)?$/.test(kr(p) ?? "")) || !/^(auto|normal|stretch)?$/.test(kr("justify-self") ?? "") || !/^(auto|normal|stretch)?$/.test(kr("align-self") ?? "") || ["margin-top", "margin-bottom", "margin-left", "margin-right"].some((p) => kr(p) === "auto");
          });
          // (A percentage row gap is a grid's own: of its final height.)
          // (Nor with an absolutely positioned child: its static position is the grid's padding box corner.)
          if (single && plainItems && !sized && !template.length && !placedKids && !/%$/.test(rowGap ?? "") && !el.children.some((k) => this.positioned(k, si))) {
            // One column: a stack with the row gap.
            decl("display", "flex", own.get("display")!.utility);
            decl("flex-direction", "column", own.get("grid-template-columns")?.utility ?? own.get("display")!.utility);
            if (rowGap && lengthPx(res("row-gap")!, 16) !== 0) decl("row-gap", rowGap, gapOrigin!.utility);
            if (space) this.note(el, si, { decl: space.utility, reason: "space-* margins in a grid are not modelled", kind: "geometry" });
          } else {
            decl("display", "grid", own.get("display")!.utility);
            for (const p of ["align-items", "justify-items"]) if (own.has(p)) decl(p, res(p)!, own.get(p)!.utility);
            if (rowGap) decl("row-gap", rowGap, gapOrigin!.utility);
            if (colGap) decl("column-gap", colGap, own.get("column-gap")!.utility);
            // No template: one implicit auto column, stretched across the grid (like 1fr: never narrower than its items).
            decl("grid-template-columns", !cols || cols === "none" ? (template.length || placedKids ? "none" : "1fr") : /\dem\b/.test(cols) ? (this.resolveBox(el, si, own.get("grid-template-columns")!.value) ?? cols) : cols, own.get("grid-template-columns")?.utility ?? own.get("display")!.utility);
            for (const [p] of TEMPLATE) {
              handled.add(p);
              if (template.some(([q]) => q === p)) decl(p, this.resolveBox(el, si, own.get(p)!.value) ?? res(p)!, own.get(p)!.utility);
            }
            if (space) this.note(el, si, { decl: space.utility, reason: "space-* margins in a grid are not modelled", kind: "geometry" });
          }
        } else if (/^(block|flow-root|list-item|inline-block|table-cell|table-caption)$/.test(display) && (!/^table-/.test(display) || !!this.tablePart(el, si)) && el.inlineRow?.[si]) {
          // Inline-blocks sharing its lines: a wrapping row, the space between them its gap (see inlineRow).
          const row = el.inlineRow[si]!;
          const why = "inline-blocks on its lines";
          decl("display", "flex", why);
          decl("flex-direction", "row", why);
          decl("flex-wrap", "wrap", why);
          decl("align-items", "flex-start", `${why}: their baselines align`);
          decl("column-gap", `${fmtNum(row.gap)}px`, row.gap ? `${why}: the space between them` : `${why}: no space between them`);
          decl("row-gap", "0px", `${why}: line boxes stack`);
          if (row.justify !== "start") decl("justify-content", row.justify === "center" ? "center" : "flex-end", `${why}: text-align`);
          if (space) this.note(el, si, { decl: space.utility, reason: "space-* margins between inline-blocks are not modelled", kind: "geometry" });
        } else if (/^(block|flow-root|list-item|inline-block|table-cell|table-caption)$/.test(display) && (!/^table-/.test(display) || !!this.tablePart(el, si))) {
          if (this.blockFlow === "flow") {
            // Block flow, margins and all ("flow" is lift's own marker for layout: { pattern: flow }).
            decl("display", "flow", own.get("display")?.utility ?? "block flow");
          } else {
            // Block flow with zero margins (preflight): a stack.
            decl("display", "flex", "block flow");
            decl("flex-direction", "column", "block flow");
          }
          if (space?.axis === "y" && spaceVal !== undefined) decl("row-gap", spaceVal, space.utility);
          else if (space) this.note(el, si, { decl: space.utility, reason: "space-x in block flow is not modelled", kind: "geometry" });
        } else if (display === "table" && !this.tableWhy(el)) {
          // A table laid out as one (engine/table.ts): its children are table parts.
          decl("display", "table", own.get("display")?.utility ?? "browser default (<table>)");
          // Without a width, as wide as its columns want (in block flow; a flex column or grid stretches it).
          if (!own.has("width") && !inFlexOrGrid) decl("width", "fit-content", "a table is as wide as its content");
          const collapse = this.tableProp(el, si, "border-collapse") === "collapse";
          if (collapse) decl("border-collapse", "collapse", own.get("border-collapse")?.utility ?? "border-collapse: collapse (inherited)");
          else {
            const sp = this.tableProp(el, si, "border-spacing") ?? "0px";
            const parts = sp.split(/\s+/).map((x) => lengthPx(x, this.textOf(el, si).size));
            if (parts.some((x) => x === undefined || x < 0) || parts.length > 2) this.note(el, si, { decl: `border-spacing: ${sp}`, reason: "border-spacing must be one or two lengths", kind: "geometry" });
            else decl("border-spacing", parts.map((x) => `${fmtNum(x!)}px`).join(" "), own.get("border-spacing")?.utility ?? "border-spacing (inherited)");
          }
          if (res("table-layout") === "fixed") decl("table-layout", "fixed", own.get("table-layout")!.utility);
          if (space) this.note(el, si, { decl: space.utility, reason: "space-* margins in a table are not modelled", kind: "geometry" });
        } else if (TABLE_PART[display] && this.tablePart(el, si)) {
          // Row groups, rows and column groups hold table parts (table.ts places them).
          if (space) this.note(el, si, { decl: space.utility, reason: "space-* margins in a table are not modelled", kind: "geometry" });
        } else {
          this.note(el, si, { decl: `display: ${display}`, reason: `display: ${display} has no Cadesa pattern`, kind: "geometry" });
        }
        // Its text runs are anonymous boxes; one that shares its lines with inline elements isn't modelled.
        if (el.children.some((k) => k.anonymous !== undefined && !this.textRun(k, si)))
          this.note(el, si, { decl: "text", reason: "text next to inline elements among block children (one anonymous block of mixed inline content) is not modelled", kind: "geometry" });
        if (space && space.axis === "y" && el.children.some((c) => c.roles[si] === "hidden") && !flex)
          this.note(el, si, { decl: space.utility, reason: "space-y with hidden children (:last-child) is not modelled", kind: "geometry" });
      } else {
        if (space) this.note(el, si, { decl: space.utility, reason: "space-* without children", kind: "none" });
        if (display === "table" && el.pseudo && role === "leaf") {
          // Generated content with no text in a table box (the clearfix): a table with no rows, as
          // tall as its padding and border, as wide as nothing. It holds the margins of what's beside
          // it apart (a block of no height would let them collapse through it).
          if (!own.has("height")) decl("height", "0px", "an empty table (no rows)");
          if (!own.has("width")) decl("width", "fit-content", "an empty table (no columns)");
          for (const p of ["border-collapse", "border-spacing", "caption-side", "table-layout", "vertical-align", "empty-cells"]) handled.add(p);
        } else if (display === "table") {
          // One box as wide as its width says; its height comes from its rows, which aren't laid out.
          this.note(el, si, { decl: "display: table", reason: "a table is laid out as one box; its height comes from its rows, which Cadesa doesn't lay out", kind: "height" });
          if (!own.has("width")) this.note(el, si, { decl: "display: table", reason: "a table without a width is as wide as its columns, which Cadesa doesn't lay out", kind: "geometry" });
          for (const p of ["border-collapse", "border-spacing", "caption-side", "table-layout", "vertical-align", "empty-cells"]) handled.add(p);
        } else if (!/^(block|flow-root|list-item|inline|inline-block|flex|inline-flex|grid|inline-grid)$/.test(display) && !(TABLE_PART[display] && this.tablePart(el, si)))
          this.note(el, si, { decl: `display: ${display}`, reason: `display: ${display} has no Cadesa pattern`, kind: "geometry" });
      }
      if (role !== "container") for (const p of ["flex-direction", "flex-wrap", "align-items", "justify-content", "row-gap", "column-gap", "grid-template-columns", "justify-items"]) handled.add(p);

      // A flex-row item that may not shrink (flex-shrink: 0) without a width: Cadesa shrinks a lone
      // item too wide for its line; dynamic() flags the widths where that happens.
      // And the other way round: a width (Cadesa's never shrinks) on an item that may shrink.
      if (parentRole === "container" && /flex/.test(parentDisplay) && el.parent && !this.isColumn(el.parent, si)) {
        const fl = res("flex");
        const sh = res("flex-shrink") ?? (fl ? String(parseFlex(fl)?.shrink ?? 1) : "1");
        const basis = res("flex-basis") ?? (fl ? parseFlex(fl)?.basis ?? "auto" : "auto");
        const width = own.has("width") && res("width") !== "auto";
        if (!width && parseFloat(sh) === 0 && !/^0(px|%)?$/.test(basis)) el.noShrink[si] = `${(own.get("flex-shrink") ?? own.get("flex"))!.utility} (flex-shrink: 0)`;
        else if (width && parseFloat(sh) !== 0 && !/^0(px|%)?$/.test(basis)) el.noShrink[si] = `${own.get("width")!.utility} (a width, and flex-shrink: ${sh})`;
      }

      // Form controls size themselves from the font and the UA's internal padding, except a text
      // field, select or textarea drawn without native appearance: one line (rows lines) of its
      // line height, plus its padding and border.
      const controlH = CONTROL.has(el.tag) && !own.has("height") ? this.controlHeight(el, si) : undefined;
      // Stretched across a flex row or a grid row (align-items: normal or stretch), it is at least that tall, not that tall.
      const ptype = (attr(el.node, "type") ?? "").toLowerCase();
      const pd = el.parent && el.parent !== this.bodyEl ? this.displayOf(el.parent, si) : "block";
      const selfA = this.resolve(el, si, own.get("align-self")?.value ?? "auto") ?? "auto";
      const itemsA = el.parent && el.parent !== this.bodyEl ? this.resolve(el.parent, si, el.parent.own[si].get("align-items")?.value ?? "normal") ?? "normal" : "normal";
      const crossStretched = parentRole === "container" && ((/flex/.test(pd) && !this.isColumn(el.parent!, si)) || /grid/.test(pd)) && /^(auto|normal|stretch)$/.test(selfA) && (selfA === "stretch" || /^(normal|stretch)$/.test(itemsA)) && !(el.tag === "input" && /^(checkbox|radio)$/.test(ptype));
      if (controlH !== undefined && crossStretched && !own.has("min-height")) {
        // (In CSS terms: of its content box unless box-sizing says border-box.)
        const sz = this.textOf(el, si).size;
        const pxY = (p: string) => lengthPx(this.resolve(el, si, own.get(p)?.value ?? "0") ?? "0", sz) ?? 0;
        const bY = (side: string) => (/^(none|hidden)$/.test(this.resolve(el, si, own.get(`border-${side}-style`)?.value ?? "none") ?? "none") ? 0 : borderPx(pxY(`border-${side}-width`)));
        const insY = this.resolve(el, si, own.get("box-sizing")?.value ?? "content-box") === "border-box" ? 0 : pxY("padding-top") + pxY("padding-bottom") + bY("top") + bY("bottom");
        decl("min-height", `${fmtNum(Math.max(0, controlH - insY))}px`, `<${el.tag}>: its own height, stretched across its row`);
      }
      else if (controlH !== undefined) decl("height", `${fmtNum(controlH)}px`, `<${el.tag}>: ${/^(checkbox|radio|range)$/.test((attr(el.node, "type") ?? "").toLowerCase()) && el.tag === "input" ? "the theme's size" : `its line height${el.tag === "textarea" ? " × rows" : ""}, padding and border`}`);
      else if (CONTROL.has(el.tag) && !own.has("height"))
        this.note(el, si, { decl: `<${el.tag}>`, reason: `a form control's height comes from its font and the browser's internals; give it a height${this.uaInCascade ? "" : " (h-*)"} to predict it`, kind: "geometry" });
      // Replaced elements and controls have an intrinsic width (the file, 300×150 for svg, ~20ch for inputs).
      const parentAlign = el.parent && el.parent !== this.bodyEl ? this.resolve(el.parent, si, el.parent.own[si].get("align-items")?.value ?? "normal") ?? "normal" : "normal";
      const stretched = parentRole === "container" && /flex/.test(parentDisplay) && el.parent && this.isColumn(el.parent, si) && !own.has("align-self") && /^(normal|stretch)$/.test(parentAlign);
      if ((CONTROL.has(el.tag) || REPLACED_BLOCK.has(el.tag)) && !own.has("width") && !stretched && this.controlWidth(el, si) === undefined)
        this.note(el, si, { decl: `<${el.tag}>`, reason: `<${el.tag}> without a width${this.uaInCascade ? "" : " (w-*)"} takes its intrinsic width, which Cadesa doesn't know`, kind: "geometry" });

      // Borders: preflight makes every side `0 solid currentcolor`.
      const bw = SIDES.map((s) => own.get(`border-${s}-width`));
      const text = this.textOf(el, si);
      if (bw.some(Boolean)) {
        for (const s of SIDES) {
          const w = own.get(`border-${s}-width`);
          const st = own.get(`border-${s}-style`);
          const c = own.get(`border-${s}-color`);
          decl(`border-${s}-width`, w ? (this.resolve(el, si, w.value) ?? "0") : "0", w?.utility ?? (this.preflight ? "preflight" : "browser default"));
          decl(`border-${s}-style`, st ? (this.resolve(el, si, st.value) ?? "solid") : this.preflight ? "solid" : "none", st?.utility ?? (this.preflight ? "preflight" : "browser default"));
          const cv = c ? this.resolve(el, si, c.value) : "currentcolor";
          const parsed = cv && !/^currentcolor$/i.test(cv) ? parseColor(cv, parseColor(text.color.hex)) : parseColor(text.color.hex);
          const hint = c && parsed && parsed.a >= 0.9995 ? hintOf(c.value, this.theme) : !c ? text.color.hint : undefined;
          decl(`border-${s}-color`, parsed ? this.colorValue(hexOf(parsed), hint) : cv ?? "currentcolor", c?.utility ?? "text color");
        }
      }
      for (const s of SIDES) handled.add(`border-${s}-width`).add(`border-${s}-style`).add(`border-${s}-color`);

      // On a line shared with other inline-blocks: its vertical margins take up what the line box adds around it.
      const rl = el.rowLine?.[si];
      if (rl)
        for (const side of ["top", "bottom"] as const) {
          const o = own.get(`margin-${side}`);
          const base = o ? (lengthPx(this.resolveBox(el, si, o.value) ?? "0", this.textOf(el, si).size) ?? 0) : 0;
          decl(`margin-${side}`, `${fmtNum(base + rl[side])}px`, `${o ? `${o.utility} and ` : ""}the line box around it`);
          handled.add(`margin-${side}`);
        }
      // A lone inline-block's line box reaches past it: the parent's padding takes the difference.
      const lp = el.linePad?.[si];
      if (lp)
        for (const side of ["top", "bottom"] as const) {
          const o = own.get(`padding-${side}`);
          const base = o ? (lengthPx(this.resolveBox(el, si, o.value) ?? "0", this.textOf(el, si).size) ?? 0) : 0;
          decl(`padding-${side}`, `${fmtNum(base + lp[side])}px`, `${o ? `${o.utility} and ` : ""}the line box around its inline-block`);
        }

      // Containment: layout and paint make an independent formatting context (and the containing
      // block of positioned descendants), size sizes the box as if empty, style moves nothing. None
      // of it applies to a non-atomic inline box. content-visibility: auto is layout, paint and style
      // containment, plus size containment while the box is off screen.
      const contain = this.containOf(el, si);
      for (const p of ["contain", "content-visibility", "contain-intrinsic-size", "contain-intrinsic-width", "contain-intrinsic-height", "contain-intrinsic-block-size", "contain-intrinsic-inline-size"]) handled.add(p);
      const cv = res("content-visibility");
      if (cv === "auto")
        this.note(el, si, { decl: `${own.get("content-visibility")!.utility} (content-visibility: auto)`, reason: "content-visibility: auto skips the content of a box off screen, which is then as tall as its contain-intrinsic-size; which boxes are off screen isn't modelled", kind: "height" });
      else if (cv === "hidden") this.note(el, si, { decl: `${own.get("content-visibility")!.utility} (content-visibility: hidden)`, reason: "content-visibility: hidden skips the box's content, which isn't modelled", kind: "geometry" });
      if (contain) {
        const words = [contain.size === "both" ? "size" : contain.size === "inline" ? "inline-size" : "", contain.layout ? "layout" : "", contain.paint ? "paint" : ""].filter(Boolean).join(" ");
        decl("contain", words, (own.get("contain") ?? own.get("content-visibility"))!.utility);
        const cis = contain.size ? [...handled].find((p) => p.startsWith("contain-intrinsic") && own.has(p) && !/^none$/.test(res(p) ?? "none")) : undefined;
        if (cis) this.note(el, si, { decl: `${own.get(cis)!.utility} (${cis}: ${res(cis)})`, reason: "contain-intrinsic-size sizes a size-contained box, which isn't modelled", kind: "geometry" });
      }
      // A transform, filter or will-change on an ancestor makes it the containing block of this
      // positioned box, which Cadesa places by its positioned (or contained) ancestor or the window.
      const trap = abs ? this.transformedContainer(el, si) : undefined;
      if (trap) this.note(el, si, { decl: trap, reason: "a transform, filter or will-change on an ancestor makes it this box's containing block, which isn't modelled", kind: "geometry" });
      this.transformDecls(el, si, decl, handled);
      // An animation of its transform, offsets or size: where it is drawn depends on the time (and
      // fill-mode keeps the last keyframe's). Not modelled: the box and its subtree are approximate.
      const anim = res("animation-name") ?? res("animation");
      const named = anim ? anim.split(",").flatMap((a) => a.trim().split(/\s+/)).find((w) => this.movingAnimation(w.replace(/^["']|["']$/g, ""))) : undefined;
      if (named && res("animation-play-state") !== "paused" && !/^none$/.test(res("animation-name") ?? ""))
        this.note(el, si, { decl: `${(own.get("animation-name") ?? own.get("animation"))!.utility} (animation: ${named})`, reason: "an animation of its transform, position or size moves what is drawn while it runs", kind: "visual" });
      // Everything else the element sets on itself.
      for (const [p, o] of own) {
        if (handled.has(p) || skipProp(p)) continue;
        // A min-height a text box's first line already reaches changes nothing.
        if (p === "min-height" && role === "text" && this.minHeightMet(el, si)) continue;
        let v = this.resolve(el, si, o.value);
        // Empty after substitution (`height: var(--unset)`): invalid at computed-value time, so the initial value.
        if (v === undefined || v === "") continue;
        // A property at its initial value (that is also every element's default) changes nothing.
        if (isInitial(p, v)) continue;
        // A transform that moves nothing (translateZ(0), a layer hint): no effect on where it's drawn.
        if (/^(transform|translate|rotate|scale)$/.test(p) && identityTransform(p, v)) continue;
        // A top or bottom auto margin is 0 in block flow, and in a column flexbox with no free
        // space (its height is its content's).
        if (/^margin-(top|bottom)$/.test(p) && v === "auto" && !abs) {
          const parentEl = el.parent && el.parent !== this.bodyEl ? el.parent : undefined;
          const column = inFlexOrGrid && !!parentEl && this.isColumn(parentEl, si) && this.definiteHeight(parentEl, si) === "auto" && /^(auto|0|0px)?$/.test(this.resolve(parentEl, si, parentEl.own[si].get("min-height")?.value ?? "") ?? "");
          if (!inFlexOrGrid || column) {
            decl(p, "0px", `${o.utility} (${p}: auto is 0 ${column ? "with no free space in its column" : "in block flow"})`);
            continue;
          }
        }
        // A relative box's percentage top or bottom: of its parent's height when that is definite, else auto.
        if (pos === "relative" && (p === "top" || p === "bottom") && /%$/.test(v) && parseFloat(v) !== 0) {
          const of = this.definiteHeight(el.parent, si);
          if (of === "auto") continue;
          if (of === "unknown") {
            this.note(el, si, { decl: `${o.utility} (${p}: ${v})`, reason: `a percentage ${p} of a parent whose height may be stretched (a flex or grid item) is not decided`, kind: "visual" });
            continue;
          }
          v = `${fmtNum((parseFloat(v) / 100) * of.px)}px`;
        }
        // A percentage height: of the parent's height when that is definite, else as if auto.
        if ((p === "height" || p === "min-height") && /^[\d.]+%$/.test(v) && !(p === "height" && abs)) {
          const of = this.definiteHeight(el.parent, si);
          if (of === "auto") continue;
          if (of === "unknown") {
            // A stretched flex or grid item's height is definite once its row is laid out (Cadesa's engine resolves it then).
            if (p === "height" && this.ofStretched(el, si)) {
              decl(p, v, o.utility);
              continue;
            }
            this.note(el, si, { decl: `${o.utility} (${p}: ${v})`, reason: `a percentage ${p} of a parent whose height may be stretched (a flex or grid item) is not decided`, kind: "height" });
            continue;
          }
          v = `${fmtNum((parseFloat(v) / 100) * of.px)}px`;
        }
        if (p === "background-color" || p === "outline-color" || p === "text-decoration-color") {
          const c = parseColor(v, parseColor(text.color.hex));
          if (c) v = this.colorValue(hexOf(c), c.a >= 0.9995 ? hintOf(o.value, this.theme) : undefined);
        } else if (p === "background-image" || p === "box-shadow") v = this.paintValue(p, v, text.color.hex);
        else if (/^(padding|margin)-|^(width|height|max-width|max-height|min-width|min-height|row-gap|column-gap|border-radius|top|right|bottom|left)$/.test(p)) {
          // em is the element's own font size (inside calc() too).
          if (/\dem\b/.test(v)) v = this.resolveBox(el, si, o.value) ?? v;
          v = this.mathValue(el, si, p, v, o.utility);
          const h = hintOf(o.value, this.theme);
          if (h && /^-?[\d.]+px$/.test(v) && parseFloat(v) !== 0) v = this.varValue(h, v);
        }
        if (v === undefined) continue;
        if (p === "aspect-ratio") v = v.replace(/^([\d.]+)\s*\/\s*([\d.]+)$/, "$1 / $2");
        // A grid item's align-self is its alignment in its area (lift reads it as such).
        if (p === "align-self" && inFlexOrGrid && /grid/.test(parentDisplay)) {
          decl("grid-align-self", v, o.utility);
          continue;
        }
        if ((p === "box-shadow" && v === "none") || (p === "background-image" && v === "none")) continue;
        decl(p, v, o.utility);
      }
      this.aspectWithHeight(el, si, out, decl, parentDisplay, parentRole);
      const zt = el.zeroText?.[si];
      if (zt !== undefined && !out.has("height")) {
        const flat = ["top", "bottom"].every((side) => /^(0|0px)?$/.test(res(`padding-${side}`) ?? "") && (/^(none|hidden)?$/.test(res(`border-${side}-style`) ?? "") || /^(0|0px)?$/.test(res(`border-${side}-width`) ?? "")));
        if (flat) decl("height", `${fmtNum(zt)}px`, "text in a font size of 0: one line of its line height");
        else this.note(el, si, { decl: "font-size: 0", reason: "text in a font size of 0 with vertical padding or a border isn't modelled", kind: "geometry" });
      }
      // flex: 0 0 <length> in a row: neither grows nor shrinks, so it is that wide (the basis beats a width).
      if (parentRole === "container" && /flex/.test(parentDisplay) && el.parent && !this.isColumn(el.parent, si)) {
        const fl = res("flex") ? parseFlex(res("flex")!) : undefined;
        const grow = parseFloat(res("flex-grow") ?? String(fl?.grow ?? 0));
        const shrink = parseFloat(res("flex-shrink") ?? String(fl?.shrink ?? 1));
        const basisRaw = own.get("flex-basis") ?? (fl ? own.get("flex") : undefined);
        const basis = own.get("flex-basis") ? this.resolveBox(el, si, own.get("flex-basis")!.value) : fl?.basis !== undefined && /\d/.test(fl.basis) ? (/\dem\b/.test(fl.basis) ? `${fmtNum(parseFloat(fl.basis) * this.textOf(el, si).size)}px` : fl.basis) : undefined;
        const px = basis !== undefined ? lengthExpr(this.mathValue(el, si, "flex-basis", basis, basisRaw?.utility ?? "flex")) : undefined;
        if (grow === 0 && shrink === 0 && px && !/^0(px)?$/.test(px.css)) {
          for (const p of ["flex", "flex-grow", "flex-shrink", "flex-basis"]) out.delete(p);
          decl("width", px.css, `${basisRaw?.utility ?? "flex"} (flex: 0 0 ${basis}: as wide as its basis)`);
          el.noShrink[si] = undefined;
        }
      }
      // Baseline alignment in its row: pushed down by the difference in top insets (see baselineShifts).
      const shift = el.baselineShift[si];
      if (shift) {
        const mt = out.get("margin-top");
        const base = mt ? lengthExpr(/^var\((--[\w-]+)\)$/.test(mt.value) ? (this.vars.get(/^var\((--[\w-]+)\)$/.exec(mt.value)![1])?.value ?? mt.value) : mt.value) : undefined;
        const px = mt ? (base && !base.fluid ? base.at(0) : NaN) : 0;
        if (isNaN(px)) this.note(el, si, { decl: "align-items: baseline on the parent", reason: "baseline alignment with a margin that isn't a length is not modelled", kind: "geometry" });
        else decl("margin-top", `${fmtNum(px + shift)}px`, `align-items: baseline on the parent (its first line on the row's baseline)`);
      }

      // A content-box cell: its width and height don't include its padding and the borders it gets (its
      // own, or in a table with collapsed borders its half of theirs); table.ts adds them.
      const cellContentBox =
        tpart === "cell" && !this.preflight && (res("box-sizing") ?? "content-box") === "content-box" && (out.has("width") || out.has("height") || out.has("max-width"));
      if (tpart) {
        const va = this.cellAlign(el, si);
        const align = tpart === "cell" ? (va === "top" || va === "middle" || va === "bottom" ? va : "baseline") : undefined;
        const side = tpart === "caption" && this.tableProp(el, si, "caption-side") === "bottom" ? "bottom" : undefined;
        const value = [tpart, align, side, cellContentBox ? "content-box" : undefined].filter(Boolean).join(" ");
        decl("table-part", value, own.get("display")?.utility ?? `browser default (<${el.tag}>)`);
        handled.add("vertical-align");
      }

      // Without a reset, boxes are content-box: lengths in px take the padding and border in, so the
      // source can stay border-box. Anything else is left content-box (lift notes it).
      if (!this.preflight) {
        const sizing = res("box-sizing") ?? "content-box";
        /** A declared length as an expression lengthExpr reads (px, or px and vw), or undefined. */
        const expr = (p: string): string | undefined => {
          const d = out.get(p);
          if (!d) return "0px";
          let v = d.value.trim();
          const ref = /^var\((--[\w-]+)\)$/.exec(v);
          if (ref) v = this.vars.get(ref[1])?.value ?? v;
          if (/^-?[\d.]+$/.test(v) && parseFloat(v) === 0) return "0px";
          return /^-?[\d.]+px$/.test(v) || lengthExpr(v) ? v : undefined;
        };
        const border = (side: string) => (/^(none|hidden)$/.test(out.get(`border-${side}-style`)?.value ?? "none") ? "0px" : expr(`border-${side}-width`));
        const sumOf = (parts: (string | undefined)[]) => (parts.some((x) => x === undefined) ? undefined : lengthExpr(`calc(${parts.join(" + ")})`));
        const extraX = [expr("padding-left"), expr("padding-right"), border("left"), border("right")];
        const extraY = [expr("padding-top"), expr("padding-bottom"), border("top"), border("bottom")];
        let ok = true;
        // A table's rows, row groups and columns take their sizes as they are; a cell's are converted
        // in table.ts (see cellContentBox).
        const tableTable = tpart !== undefined && tpart !== "caption";
        // A content-box table with collapsed borders: its border is half of its outer collapsed
        // borders (and it has no padding), which only table.ts knows.
        const collapsedTable = sizing !== "border-box" && this.isTable(el, si) && role === "container" && this.tableProp(el, si, "border-collapse") === "collapse";
        if (collapsedTable && ["width", "height", "min-height", "min-width", "max-width"].some((p) => out.has(p) && !/^(auto|none)$/.test(out.get(p)!.value.trim()))) {
          this.note(el, si, { decl: own.get("box-sizing")?.utility ?? "browser default (content-box)", reason: "a content-box table with collapsed borders: its size doesn't include the half borders it gets, which isn't modelled", kind: "geometry" });
          ok = false;
        } else if (sizing !== "border-box" && !tableTable)
          for (const [p, extra] of [["width", extraX], ["max-width", extraX], ["height", extraY], ["min-height", extraY], ["max-height", extraY], ["min-width", extraX]] as const) {
            const d = out.get(p);
            const e = sumOf(extra);
            // (A width from the content, fit-content, comes out the same in either box sizing.)
            if (!d || (e && !e.fluid && e.at(0) === 0) || /^(auto|none|fit-content|min-content|max-content)$/.test(d.value.trim())) continue;
            // A form control's height from its line is a border-box height already.
            if (p === "height" && controlH !== undefined) continue;
            // The length plus the padding and border, in px when both are (an expression in px and vw when either follows the viewport).
            const total = e && expr(p) ? sumOf([expr(p), e.css]) : undefined;
            if (total && (total.fluid || /^[\d.]+px$/.test(d.value.trim()) || /^var\(/.test(d.value.trim()))) decl(p, total.css, `${(d as Decl & { utility?: string }).utility ?? p} (content-box)`);
            else ok = false;
          }
        decl("box-sizing", ok ? "border-box" : sizing, own.get("box-sizing")?.utility ?? "browser default (content-box)");
      }

      // Text: a text box carries its full (inherited) text style.
      if (role === "text") {
        decl("font-family", text.family.hint ? this.varValue(text.family.hint, text.family.value) : text.family.value, "inherited font");
        decl("font-size", text.fluid ?? `${fmtNum(text.size)}px`, "inherited font size");
        decl("font-weight", String(text.weight), "inherited font weight");
        const lh = text.lineHeight;
        if (text.fluid && lh !== "normal" && "px" in lh) this.note(el, si, { decl: "line-height", reason: "a fixed line height with a font size that follows the viewport width is not modelled (its ratio changes with the width)", kind: "text" });
        // normal: the font's ascent, descent and line gap, when its vertical metrics are known.
        const normal = lh === "normal" ? this.normalLine(text) : undefined;
        decl("line-height", normal !== undefined ? fmtNum(normal / text.size) : lh === "normal" ? "normal" : "num" in lh ? fmtNum(lh.num) : fmtNum(lh.px / text.size), normal !== undefined ? `line-height: normal (${normal}px: the font's ascent, descent and line gap)` : "inherited line height");
        const unionLine = el.inlineLine?.[si];
        if (unionLine !== undefined && !(parentRole === "container" && /flex|grid/.test(parentDisplay))) decl("line-height", fmtNum(unionLine / text.size), `its lines (${fmtNum(unionLine)}px: the parent's strut and its own, on one baseline)`);
        decl("color", this.colorValue(text.color.hex, text.color.hint), "inherited color");
        if (text.letterSpacing) decl("letter-spacing", `${fmtNum(text.letterSpacing / text.size)}em`, "inherited tracking");
        if (text.fluid && text.letterSpacing && text.lsFluid !== text.fluid) this.note(el, si, { decl: "letter-spacing", reason: "letter spacing with a font size that follows the viewport width is not modelled", kind: "text" });
        for (const [p, o] of text.inherited) {
          if (INHERITED_PAINT.has(p)) continue;
          if (p === "text-align") {
            const v = { left: "start", start: "start", center: "center", right: "end", end: "end" }[o.value];
            if (v && v !== "start") decl("text-align", v, o.utility);
            else if (!v) decl("text-align", o.value, o.utility);
          } else if (/^text-wrap(-style)?$/.test(p) && /^(balance|pretty)$/.test(o.value) && !(parentRole === "container" && /flex/.test(parentDisplay) && el.parent && !this.isColumn(el.parent, si))) {
            // Chromium's balanced and pretty line breakers keep the greedy line count (they fall
            // back to it otherwise), so a box whose width doesn't depend on its text keeps its size.
            this.note(el, si, { decl: o.utility, reason: `text-wrap: ${o.value} moves line breaks but keeps the line count; the box is exact, the reported lines are not`, kind: "none" });
          } else if (/^text-wrap(-style)?$/.test(p) && o.value === "stable") {
            // stable: the same breaks as auto when the page is laid out (it only differs while editing).
          } else if (!/^(normal|none|auto|wrap|manual|0|0px|ltr)$/.test(o.value) && !(p === "font-style" && o.value === "normal")) decl(p, o.value, o.utility);
        }
        this.inlineContent(el, si);
      }
    });
  }

  /**
   * transform, translate, rotate, scale and transform-origin as one 2D transform (the individual
   * properties first, in that order, then transform), with em in px. They don't apply to a
   * non-atomic inline box. What isn't a 2D map Cadesa can draw (3D rotations, perspective, math
   * it can't resolve) is left to the generic path, which notes it.
   */
  transformDecls(el: El, si: number, decl: (p: string, v: string, u: string) => void, handled: Set<string>) {
    const own = el.own[si];
    const PROPS = ["translate", "rotate", "scale", "transform"] as const;
    const set = PROPS.filter((p) => own.has(p));
    if (!set.length && !own.has("transform-origin")) return;
    const val = (p: string) => {
      const o = own.get(p);
      if (!o) return undefined;
      const v = this.resolveBox(el, si, o.value);
      return v === undefined ? undefined : absolute(v.replace(/(^|[\s(,*/+-])(-?\d*\.?\d+)rem\b/g, (_, pre, n) => `${pre}${fmtNum(parseFloat(n) * 16)}px`));
    };
    if (this.displayOf(el, si) === "inline" && !el.asBlock[si] && el.inlineLine?.[si] === undefined) {
      for (const p of [...PROPS, "transform-origin"]) handled.add(p);
      return;
    }
    const parts: string[] = [];
    for (const p of set) {
      const v = val(p);
      if (v === undefined || v === "") continue;
      if (identityTransform(p, v)) continue;
      const fn = p === "transform" ? v : individual(p, v);
      if (fn === undefined || (fn && !transformList(fn, 100, 100))) return;
      if (fn) parts.push(fn);
    }
    const origin = val("transform-origin");
    if (origin !== undefined && !originOf(origin, 100, 100)) {
      if (!parts.length) for (const p of [...PROPS, "transform-origin"]) handled.add(p);
      return;
    }
    for (const p of [...PROPS, "transform-origin"]) handled.add(p);
    if (!parts.length) return;
    const utility = (own.get("transform") ?? own.get("rotate") ?? own.get("translate") ?? own.get("scale"))!.utility;
    decl("transform", parts.join(" "), utility);
    if (origin) decl("transform-origin", origin, own.get("transform-origin")!.utility);
  }

  /**
   * aspect-ratio with a height and no width: the width follows the height through the ratio (in
   * block flow, a flex row, a grid cell). Stretched across a column flexbox it is as wide as the
   * column instead. Either way it's a width, not an aspect ratio, and the source stays valid.
   */
  aspectWithHeight(el: El, si: number, out: Map<string, Decl>, decl: (p: string, v: string, u: string) => void, parentDisplay: string, parentRole: Role | "page") {
    const ar = out.get("aspect-ratio");
    const h = out.get("height");
    if (!ar || !h || /^auto$/.test(h.value.trim())) return;
    const w = out.get("width");
    const own = el.own[si];
    const res = (p: string) => {
      const o = own.get(p);
      return o ? this.resolve(el, si, o.value) : undefined;
    };
    const m = /^([\d.]+)\s*(?:\/\s*([\d.]+))?$/.exec(ar.value.trim());
    const ratio = m ? parseFloat(m[1]) / (m[2] ? parseFloat(m[2]) : 1) : NaN;
    if (w && !/^auto$/.test(w.value.trim())) {
      // Both sizes set: the ratio does nothing.
      out.delete("aspect-ratio");
      return;
    }
    const hv = own.get("height") ? this.resolveBox(el, si, own.get("height")!.value) : undefined;
    const px = hv === undefined ? undefined : lengthPx(hv, this.textOf(el, si).size);
    if (!(ratio > 0) || !isFinite(ratio) || px === undefined || px < 0) return;
    out.delete("aspect-ratio");
    const parent = el.parent;
    const column = parentRole === "container" && /flex/.test(parentDisplay) && !!parent && this.isColumn(parent, si);
    const align = parent ? this.resolve(parent, si, parent.own[si].get("align-items")?.value ?? "normal") : "normal";
    const self = res("align-self") ?? "auto";
    const stretched = column && /^(normal|stretch)$/.test(align ?? "normal") && /^(auto|normal|stretch)$/.test(self);
    if (stretched) return;
    const utility = `${own.get("aspect-ratio")?.utility ?? "aspect-ratio"} (aspect-ratio ${ar.value} with height ${fmtNum(px)}px)`;
    decl("width", `${fmtNum((Math.floor(px * 64 + 1e-6) / 64) * ratio)}px`, utility);
    // In a flex row it may still shrink (flex-shrink: 1), which a Cadesa width never does.
    if (parentRole === "container" && /flex/.test(parentDisplay) && parent && !column) {
      const sh = res("flex-shrink") ?? (res("flex") ? String(parseFlex(res("flex")!)?.shrink ?? 1) : "1");
      if (parseFloat(sh) !== 0) el.noShrink[si] = `${utility} (a width from its aspect ratio, and flex-shrink: ${sh})`;
    }
  }

  /**
   * A box length with math or viewport units, in the form Cadesa computes per width: calc(), min(),
   * max() and clamp() of px, rem, em and vw (em is the element's font size), and vh at the default
   * viewport height (noted: the real height varies). Anything else (a percentage inside) is left
   * as it is, for lift to report.
   */
  mathValue(el: El, si: number, prop: string, v: string, utility: string): string {
    if (!MATHY.test(v) || /url\(|["']/.test(v)) return v;
    const t = this.textOf(el, si);
    if (t.fluid && /\dem\b/.test(v)) {
      this.note(el, si, { decl: `${utility} (${prop}: ${v})`, reason: "an em length under a font size that follows the viewport width is not modelled", kind: "geometry" });
      return v;
    }
    // (A width or max-width may hold percentages of the containing block: lift keeps them for the engine.)
    const f = lengthExpr(v, { em: t.size, vh: this.viewportHeight, pct: prop === "width" || prop === "max-width" || /^(padding|margin)-(top|right|bottom|left)$/.test(prop) });
    if (f && /\d[dsl]?v(?:h|min|max)\b/i.test(v)) this.usesViewportHeight = true;
    return f ? f.css : v;
  }

  /**
   * For align-items: baseline in a flex row: how far below the top each item starts, when every
   * item is a text box in one font, size, weight and line height (so its first baseline is the same
   * distance below its content edge): the largest top margin + border + padding, less its own.
   * Undefined when that isn't so (fonts differ, a box inside an item, align-self, a margin that
   * isn't a length).
   */
  baselineShifts(kids: El[], si: number): number[] | undefined {
    if (!kids.length) return undefined;
    const t0 = this.textOf(kids[0], si);
    const same = (t: TextCtx) => t.size === t0.size && t.family.value === t0.family.value && t.weight === t0.weight && JSON.stringify(t.lineHeight) === JSON.stringify(t0.lineHeight) && !t.fluid && !t0.fluid;
    // In one font, size and line height their first baselines sit equally far below their content
    // edges; otherwise each is its strut's ascent below it (from the fonts' vertical metrics).
    const allSame = kids.every((k) => same(this.textOf(k, si)));
    const tops: number[] = [];
    for (const k of kids) {
      // (Layout containment leaves an item no baseline.)
      if (k.roles[si] !== "text" || this.containOf(k, si)) return undefined;
      // An inline box that may make its first line taller than its strut: the engine places it (align baseline).
      const tall = (x: El): boolean => x.children.some((c) => (this.runStyle(c, si)?.above !== undefined || (this.atomicInline(c, si) !== undefined && this.pastStrut(c, si) !== undefined) || tall(c)));
      if (tall(k)) return undefined;
      const strut = allSame ? undefined : this.strutOf(k, si);
      if (!allSame && !strut) return undefined;
      const own = k.own[si];
      const self = own.get("align-self");
      if (self && !/^(auto|baseline|first baseline)$/.test(this.resolve(k, si, self.value) ?? "")) return undefined;
      const len = (p: string) => {
        const o = own.get(p);
        const v = o ? this.resolveBox(k, si, o.value) : "0";
        return v === undefined ? undefined : lengthPx(v, this.textOf(k, si).size);
      };
      const style = this.resolve(k, si, own.get("border-top-style")?.value ?? "none") ?? "none";
      const bw = /^(none|hidden)$/.test(style) ? 0 : len("border-top-width");
      const [mt, pt] = [len("margin-top"), len("padding-top")];
      if (mt === undefined || pt === undefined || bw === undefined) return undefined;
      tops.push(mt + pt + borderPx(bw) + (strut?.sa ?? 0));
    }
    const top = Math.max(...tops);
    return tops.map((t) => top - t);
  }

  /**
   * What a percentage height of `el`'s children resolves against: its content height when that is
   * definite (a length, or a percentage of a definite height; the viewport for <html>), "auto" when
   * the percentage behaves as auto, "unknown" when it depends on stretching (a flex or grid item).
   */
  definiteHeight(el: El | undefined, si: number, depth = 0): "auto" | "unknown" | { px: number; viewport: boolean } {
    if (!el) {
      this.usesViewportHeight = true;
      return { px: this.viewportHeight, viewport: true };
    }
    if (depth > 64) return "unknown";
    const own = el.own[si];
    const o = own?.get("height");
    const v = o ? this.resolveBox(el, si, o.value) : undefined;
    const parentDisplay = el.parent ? this.displayOf(el.parent, si) : "block";
    const item = el !== this.bodyEl && el !== this.htmlEl && /flex|grid/.test(parentDisplay);
    if (!v || v === "auto") return item ? "unknown" : "auto";
    const size = this.textOf(el, si).size;
    let px: number;
    let viewport = false;
    const pct = /^([\d.]+)%$/.exec(v);
    if (pct) {
      const of = this.definiteHeight(el.parent, si, depth + 1);
      if (typeof of === "string") return of;
      px = (parseFloat(pct[1]) / 100) * of.px;
      viewport = of.viewport;
    } else {
      const f = lengthExpr(v, { em: size, vh: this.viewportHeight });
      if (!f || f.fluid) return "unknown";
      px = f.at(0);
      viewport = /\d[dsl]?v(?:h|min|max)\b/i.test(v);
    }
    const res = (p: string) => this.resolve(el, si, own?.get(p)?.value ?? "") ?? "";
    if (res("box-sizing") === "border-box") {
      const len = (p: string) => lengthPx(this.resolveBox(el, si, own?.get(p)?.value ?? "0") ?? "0", size) ?? 0;
      for (const s of ["top", "bottom"]) {
        px -= len(`padding-${s}`);
        if (!/^(none|hidden|)$/.test(res(`border-${s}-style`))) px -= borderPx(len(`border-${s}-width`));
      }
    }
    return { px: Math.max(0, px), viewport };
  }

  /**
   * <html>'s or <body>'s margin and padding (its border widths added to the padding) per side, as
   * px (or px and vw) lengths; undefined when a side is something else (auto, a percentage).
   */
  pageInsets(el: El, si: number): [string[], string[]] | undefined {
    const own = el.own[si];
    if (!own) return [["0px", "0px", "0px", "0px"], ["0px", "0px", "0px", "0px"]];
    const len = (p: string): string | undefined => {
      const o = own.get(p);
      if (!o) return "0px";
      const r = this.resolveBox(el, si, o.value);
      if (r === undefined) return undefined;
      if (/^-?0(?:\.0+)?(?:px|rem|em|%)?$/.test(r)) return "0px";
      const f = lengthExpr(this.mathValue(el, si, p, r, o.utility), { em: this.textOf(el, si).size });
      return f ? f.css : undefined;
    };
    const margin = SIDES.map((s) => len(`margin-${s}`));
    const padding = SIDES.map((s) => {
      const pad = len(`padding-${s}`);
      const style = this.resolve(el, si, own.get(`border-${s}-style`)?.value ?? "none") ?? "none";
      if (/^(none|hidden)$/.test(style) || !own.has(`border-${s}-width`)) return pad;
      const w = lengthPx(this.resolveBox(el, si, own.get(`border-${s}-width`)!.value) ?? "x", this.textOf(el, si).size);
      if (w === undefined || pad === undefined) return undefined;
      const b = borderPx(w);
      return b === 0 ? pad : pad === "0px" ? `${b}px` : lengthExpr(`calc(${pad} + ${b}px)`)?.css;
    });
    if (margin.some((x) => x === undefined) || padding.some((x) => x === undefined) || padding.some((x) => lengthExpr(x!)!.at(1280) < 0)) return undefined;
    return [margin as string[], padding as string[]];
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
    const h = inner ? hintOf(inner[0], this.theme) : undefined;
    return h && parseFloat(s) !== 0 ? this.varValue(h, s) : s;
  }

  /** A resolved length, as a reference to the theme variable it came from when there is one. */
  len(el: El, si: number, o: Origin, prop = "gap"): string | undefined {
    const r = this.resolve(el, si, o.value);
    if (r === undefined) return undefined;
    const v = this.mathValue(el, si, prop, /\dem\b/.test(r) ? (this.resolveBox(el, si, o.value) ?? r) : r, o.utility);
    const h = hintOf(o.value, this.theme);
    return h && /^-?[\d.]+px$/.test(v) && parseFloat(v) !== 0 ? this.varValue(h, v) : v;
  }

  /**
   * A percentage row gap: of the container's content height. A set height makes it a length; an
   * auto height makes it 0 in a flex container, and in a grid 0 while the rows are sized, then of
   * the final height (kept as a percentage for the engine). A height that may be stretched (a flex
   * or grid item), or a grid's min-height or max-height, isn't modelled (noted, and left out).
   */
  pctRowGap(el: El, si: number, o: Origin | undefined, grid = false): Origin | undefined {
    if (!o) return o;
    const v = this.resolve(el, si, o.value);
    if (!v || !/^(\d+\.?\d*|\.\d+)%$/.test(v) || parseFloat(v) === 0) return o;
    // A grid of one row (no more items than columns) has no row gap to place.
    if (grid) {
      const tracks = gridTrackCount(this.resolve(el, si, el.own[si].get("grid-template-columns")?.value ?? "none") ?? "");
      const items = el.children.filter((k) => k.roles[si] && k.roles[si] !== "hidden" && k.roles[si] !== "out" && !this.positioned(k, si)).length;
      const placed = ["grid-row", "grid-row-start", "grid-row-end", "grid-area", "grid-column", "grid-column-start", "grid-column-end", "grid-auto-flow", "grid-template-rows", "grid-template-areas"].some((p) => el.children.some((k) => k.own[si]?.has(p)) || (p.startsWith("grid-auto") || p.startsWith("grid-template")) && el.own[si].has(p));
      if (tracks !== undefined && items <= tracks && !placed) return { ...o, value: "0px", utility: `${o.utility} (row-gap: ${v}, one row: no gap between rows)` };
    }
    const of = this.definiteHeight(el, si);
    // Of a set height: a length (the percentage of the content height, cut to a layout unit).
    if (typeof of === "object") {
      const f = Math.fround;
      const px = Math.trunc(f(f(f(Math.floor(of.px * 64 + 1e-6) / 64) * f(parseFloat(v))) / 100) * 64) / 64;
      return { ...o, value: `${fmtNum(px)}px`, utility: `${o.utility} (row-gap: ${v} of a ${fmtNum(of.px)}px content height)` };
    }
    if (of === "auto" && !grid) return { ...o, value: "0px", utility: `${o.utility} (row-gap: ${v} of an auto height is 0)` };
    // A grid of auto height sizes its rows without the gap, then places them that percentage of its
    // final content height apart (they may overflow). A min-height or max-height isn't modelled.
    const limited = ["min-height", "max-height"].some((p) => !/^(auto|none|0|0px)?$/.test(this.resolve(el, si, el.own[si].get(p)?.value ?? "") ?? ""));
    if (of === "auto" && !limited) return o;
    // A grid whose height may be stretched, or that has a min-height: the engine decides (exact while it has one row).
    if (grid) return o;
    this.note(el, si, { decl: `${o.utility} (row-gap: ${v})`, reason: `a percentage row gap of a ${grid ? "grid's" : "container's set or stretched"} height is not modelled`, kind: "geometry" });
    return undefined;
  }

  /** Notes for a text box's inline descendants whose own styles change how the text measures. */
  inlineContent(el: El, si: number) {
    const base = this.textOf(el, si);
    const lh = (x: TextCtx) => (x.lineHeight === "normal" ? NaN : "num" in x.lineHeight ? lineHeightPx(x.size, x.lineHeight.num) : x.lineHeight.px);
    const visit = (k: El) => {
      if (k.tag === "br" || this.outOfFlow(k, si) || this.displayOf(k, si) === "none") return;
      // An atomic inline of known size whose line box stays the same: one object on the line, measured.
      if (this.atomicInline(k, si) !== undefined) return;
      if (k.pseudo && this.ownDisplay(k, si) === "inline-block" && !this.floatsAtStart(k, si) && this.atomicText(k, si) !== undefined) return;
      const own = k.own[si];
      const ua = UA_TEXT[k.tag];
      const where = k.pseudo ? `::${k.pseudo}` : `<${k.tag}>`;
      // An inline box (not inline-block): its margin, border and padding at its start and end take
      // room on the line; above and below they move nothing.
      const inline = this.displayOf(k, si) === "inline" || (k.pseudo !== undefined && this.ownDisplay(k, si) === "inline");
      const edges = inline ? this.inlineEdges(k, si) : undefined;
      // Generated content: text (a breadcrumb's "/", a bullet), or a float at the start of the first line.
      const lead = k.pseudo !== undefined && this.floatsAtStart(k, si);
      if (k.pseudo) {
        const c = k.content?.[si];
        const kt0 = this.textOf(k, si);
        const res = (p: string) => {
          const o = own.get(p);
          return o ? this.resolve(k, si, o.value) : undefined;
        };
        if (c !== undefined && typeof c !== "string")
          this.note(el, si, { decl: `${where} { content: ${c.unknown} }`, reason: `${where} content other than text (counters, attr(), images) is not modelled`, kind: "geometry" });
        if (lead) {
          // As tall as the first line (one line of the same font, size and line height, nothing above
          // or below it), at the start of a text box with text after it: the first line is shortened
          // by its width, and the lines below it aren't.
          const flat = ["top", "bottom"].every((side) => {
            const v = (p: string) => lengthPx(res(p) ?? "0", kt0.size);
            return v(`margin-${side}`) === 0 && v(`padding-${side}`) === 0 && (v(`border-${side}-width`) === 0 || /^(none|hidden)$/.test(res(`border-${side}-style`) ?? "none"));
          });
          const ok =
            k.parent === el && flat && edges !== undefined && kt0.size === base.size && kt0.family.value === base.family.value && lh(kt0) === lh(base) && kt0.letterSpacing === base.letterSpacing &&
            (el.ownText || el.children.some((c) => !c.pseudo && !this.ignorable(c) && this.inlineChild(c) && this.visibleText(c))) && /^(start|left|unset|initial|-webkit-auto)?$/.test(base.inherited.get("text-align")?.value ?? "") && base.inherited.get("direction")?.value !== "rtl";
          if (!ok) this.note(el, si, { decl: `${where} { float: left }`, reason: `a floated ${where} is modelled only at the start of a text box, as tall as its first line`, kind: "geometry" });
        } else if (/^(left|right|inline-start|inline-end)$/.test(res("float") ?? "none"))
          this.note(el, si, { decl: `${where} { float: ${res("float")} }`, reason: `a floated ${where} is modelled only at the start of a text box, as tall as its first line`, kind: "geometry" });
      }
      const changes: { prop: string; utility: string; kind: ImpactKind }[] = [];
      for (const [p, o] of own) {
        if (p.startsWith("--") || (p === "vertical-align" && this.resolve(k, si, o.value) === "baseline")) continue;
        // A property at its initial value (that is also every element's default) changes nothing.
        if (isInitial(p, this.resolve(k, si, o.value))) continue;
        const kind = TEXT_PROPS.has(p) ? (p === "color" ? "paint" : "text") : INHERITED_PAINT.has(p) && kindOf(p) !== "none" ? "paint" : kindOf(p);
        changes.push({ prop: p, utility: o.utility, kind });
      }
      const kt = this.textOf(k, si);
      const pt = this.textOf(k.parent, si);
      const textChanges = changes.filter((c) => c.kind !== "paint");
      // Bold runs are measured at their weight (strong, b); italic runs too when the font has no
      // italic face (it is slanted, not redrawn); other defaults change the font or its size.
      const synthetic = this.italicFace(firstFamily(kt.family.value)) === false;
      if (ua === "is italic" && (!this.italic(k, si) || synthetic)) {
        /* measured upright */
      } else if (ua && k.tag !== "strong" && k.tag !== "b" && !textChanges.some((c) => c.prop === "font-weight" || c.prop === "font-style" || c.prop === "font-family" || c.prop === "font-size"))
        this.note(el, si, { decl: `<${k.tag}>`, reason: `inline <${k.tag}> ${ua}; text runs in another style aren't measured`, kind: "text" });
      // Text in another font family (an icon font) or size sits on the line with its own metrics.
      const famDiff = kt.family.value !== pt.family.value;
      // An inline box whose font, size, line height and vertical-align are measured (runStyle).
      const modelled = inline && !lead && this.runModelled(k, si);
      if (famDiff && changes.some((c) => c.prop === "font-family") === false && k.pseudo && !modelled)
        this.note(el, si, { decl: `${where} (font-family: ${kt.family.value})`, reason: "inline runs in another style aren't measured", kind: "text" });
      // box-sizing changes nothing on a box with no width, height, padding or border.
      const boxy = ["width", "height", "min-width", "min-height", "max-width", "max-height"].some((p) => own.has(p)) || SIDES.some((s) => own.has(`padding-${s}`) || own.has(`border-${s}-width`) || own.has(`margin-${s}`));
      // An inline-block that is all the text box holds, with no box of its own and the same text
      // style: its line is the text box's line, broken the same way (Bootstrap's <label> in .form-check).
      const shown = el.children.filter((x) => x.tag !== "br" && !this.outOfFlow(x, si) && this.displayOf(x, si) !== "none");
      const sameText = kt.size === pt.size && kt.weight === pt.weight && kt.family.value === pt.family.value && JSON.stringify(kt.lineHeight) === JSON.stringify(pt.lineHeight) && kt.letterSpacing === pt.letterSpacing;
      const whole = k.parent === el && shown.length === 1 && shown[0] === k && !el.ownText && !boxy && sameText && this.displayOf(k, si) === "inline-block";
      for (const c of changes) {
        // display: inline on an inline run (Bootstrap's d-md-inline where it shows) is what it was anyway.
        if ((c.prop === "box-sizing" && (!boxy || inline)) || (c.prop === "display" && (whole || this.displayOf(k, si) === "inline"))) continue;
        // Generated content's own properties: its text is measured; clear does nothing to inline content.
        if (k.pseudo && (c.prop === "content" || c.prop === "clear" || (c.prop === "float" && lead) || (c.prop === "display" && (lead || inline)))) continue;
        // Margin, border and padding at an inline box's start and end are measured with its text; above and below they move nothing.
        if (edges && /^(margin|padding)-(left|right)$|^border-(left|right)-(width|style)$/.test(c.prop)) continue;
        if (inline && !lead && /^(margin|padding)-(top|bottom)$|^border-(top|bottom)-(width|style)$/.test(c.prop)) continue;
        if (lead && /^(margin|padding)-(top|bottom)$|^border-(top|bottom)-(width|style)$/.test(c.prop)) continue;
        // A weight of its own is measured run by run.
        if (c.prop === "font-weight" && (inline || lead || kt.weight === pt.weight)) continue;
        if (c.kind === "paint" || c.kind === "none" || c.kind === "state") {
          // Its color and background are checked run by run (coloredRuns); other paint (opacity, images) isn't known.
          const checked = c.prop === "color" || (c.prop === "background-color" && (this.ownBackground(k, si) !== undefined || /^(transparent|none)$/.test(this.resolve(k, si, own.get(c.prop)!.value) ?? "")));
          if (c.kind === "paint" && !checked && c.prop !== "content") this.note(el, si, { decl: `${c.utility} on ${where}`, reason: "inline paint; no effect on layout", kind: "paint" });
          continue;
        }
        // Text properties equal to what the run inherits anyway change nothing.
        if (c.prop === "font-size" && kt.size === pt.size) continue;
        if (modelled && /^(font-size|font-family|line-height|vertical-align)$/.test(c.prop)) continue;
        if (c.prop === "font-family" && !famDiff) continue;
        if (c.prop === "font-style" && (synthetic || this.italic(k, si) === this.italic(k.parent!, si))) continue;
        if (c.prop === "line-height" && JSON.stringify(kt.lineHeight) === JSON.stringify(pt.lineHeight)) continue;
        this.note(el, si, { decl: `${c.utility} on ${where} (${c.prop})`, reason: "inline runs in another style aren't measured", kind: c.kind === "visual" ? "visual" : c.kind === "geometry" ? "geometry" : "text" });
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
      const base = sanitize(this.nameOf(root, true) ?? attr(root.node, "data-fixture") ?? attr(root.node, "id") ?? root.tag) || "block";
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
            k.tag,
            k.classes.join(" "),
          ]);
          let slot = slots.get(sig);
          if (!slot) {
            const sb = sanitize(this.nameOf(k, false) ?? attr(k.node, "data-fixture") ?? k.tag) || "box";
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

  liftOnce(): LiftResult {
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
    unlifted.push(...this.extraUnlifted());
    for (const el of this.els.filter((e) => e.roles.length && !e.className && e.roles.every((r) => r === "hidden" || r === "out") && !(e.parent?.roles.every((r) => r === "hidden" || r === "out"))))
      unlifted.push({ file: this.page, line: el.line, selector: `<${el.tag}>`, reason: el.roles.includes("out") ? "taken out of flow (position: absolute/fixed, or a float beside the content); not laid out" : "hidden at every width (display: none)", kind: "none" });

    const bpPx = this.states.filter((s) => s.key !== Infinity).map((s) => s.key);
    const bpRaw = new Map(this.states.filter((s) => s.raw).map((s) => [s.key, s.raw!]));
    const names = new Map(this.states.filter((s) => s.name).map((s) => [s.key, s.name!]));
    const resets = new Map<string, Set<string>>();
    if (this.preflight) for (const r of this.roots) if (r.block) resets.set(r.block, new Set(["margin", "padding", "border", "box-sizing", "border-width"]));
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
      uaInCascade: this.uaInCascade,
      fullWidthAsPercent: true,
      wholeCascade: true,
      pageBackground: this.pageBackground,
      pageSides: this.pageSides,
      unlifted,
      resets,
      declarations: this.declarationCount(),
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

  assemble(): PageLift {
    // Fixed boxes, and absolute ones with no positioned ancestor, are placed in the window.
    if (this.els.some((e) => this.states.some((_, si) => e.roles[si] && this.positioned(e, si)))) this.pageSides.windowHeight = this.viewportHeight;
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
        if (c && c.a >= 0.9995) this.pageBackground = { prop: "background-color", value: this.colorValue(hexOf(c), hintOf(bg.value, this.theme)), important: false, line: el.line };
      }
      // Margins, borders and padding: the page's insets, when they're lengths and the same at every width.
      const insets = this.states.map((_, s) => this.pageInsets(el, s));
      const same = insets.every((x) => x && JSON.stringify(x) === JSON.stringify(insets[0]));
      if (same && insets[0]) {
        const [m, p] = insets[0];
        if (el === this.bodyEl) this.pageSides = { ...this.pageSides, margin: m, padding: p };
        else this.pageSides = { ...this.pageSides, outer: m.map((x, i) => (x === "0px" ? p[i] : p[i] === "0px" ? x : lengthExpr(`calc(${x} + ${p[i]})`)!.css)) };
      }
      // The viewport takes <html>'s overflow, or <body>'s when <html>'s is visible: hidden or clip
      // there cuts off what is past the right edge instead of scrolling to it.
      if (el === this.bodyEl) {
        const ox = (x: El | undefined, s: number) => (x ? (this.resolve(x, s, x.own[s]?.get("overflow-x")?.value ?? "visible") ?? "visible") : "visible");
        const clips = this.states.every((_, s) => /^(hidden|clip)$/.test(ox(this.htmlEl, s) !== "visible" ? ox(this.htmlEl, s) : ox(this.bodyEl, s)));
        if (clips) this.pageSides = { ...this.pageSides, overflow: "hidden" };
      }
      // overflow on <html> or <body> applies to the viewport (it scrolls or clips the page; no box
      // moves), unless both set it: then the body's own is a box's, which keeps its children's margins in.
      const overflowBoth = [this.htmlEl, this.bodyEl].every((x) => x && this.states.some((_, s) => /^(hidden|clip|auto|scroll)$/.test(this.resolve(x, s, x.own[s]?.get("overflow-x")?.value ?? x.own[s]?.get("overflow-y")?.value ?? "visible") ?? "visible")));
      this.states.forEach((_, s) => {
        for (const [p, o] of el.own[s] ?? []) {
          if (p.startsWith("--") || TEXT_PROPS.has(p) || INHERITED_OTHER.has(p) || INHERITED_PAINT.has(p) || p === "background-color") continue;
          // Zero margins and padding change nothing; the body's height doesn't move what's in it.
          const v = this.resolve(el, s, o.value);
          if (/^(margin|padding)-/.test(p) && v !== undefined && /^0(?:\.0+)?(?:px|rem|em|%)?$/.test(v)) continue;
          if (same && /^(margin|padding)-|^border-(top|right|bottom|left)-(width|style|color)$/.test(p)) continue;
          if (/^(height|min-height|box-sizing|display)$/.test(p) && (p !== "display" || v === "block")) continue;
          if (/^overflow-[xy]$/.test(p) && !(overflowBoth && el === this.bodyEl)) continue;
          const k = kindOf(p);
          if (k === "paint" || k === "none") continue;
          if (this.bodyEl) this.note(this.bodyEl, s, { decl: `${o.utility} (${p}: ${o.value})`, reason: `page-level ${p} is not modelled`, kind: k });
        }
      });
    }
    const fixtureHtml = this.generatedHtml();
    const fixture = parseFixture(this.page, fixtureHtml);
    const byId = new Map(this.els.filter((e) => e.id).map((e) => [e.id!, e]));
    const hiddenNodes = new Set(this.els.filter((e) => this.ignorable(e)).map((e) => e.node));
    // Per width range: also what display: none hides there (inline content of a text box hidden at some widths).
    const hiddenAt = this.states.map((_, si) => new Set(this.els.filter((e) => e.anonymous === undefined && (hiddenNodes.has(e.node) || this.displayOf(e, si) === "none")).map((e) => e.node)));
    /** An anonymous text run's node: a text box of the run's text, with the class lift gave it. */
    const anonNode = (k: El, si: number | undefined): FixtureNode | undefined => {
      if (!k.className || (si !== undefined && k.roles[si] !== "text" && k.roles[si] !== "leaf")) return undefined;
      // Text in a font size of 0 lays out as an empty box of its line height.
      const t = si !== undefined && k.roles[si] === "leaf" ? "" : k.anonymous!;
      return { tag: "#text", classes: [k.className], attrs: {}, fixtureId: k.id, line: k.line, text: t, ownText: t, runs: t ? [t] : [], runMeta: t ? [{ inBlock: false, underlined: false, items: [] }] : [], children: [], anonymous: true };
    };
    /** A ::before / ::after laid out as a box of its own: a text box of its content, or an empty box. */
    const pseudoNode = (k: El, si: number | undefined): FixtureNode | undefined => {
      if (!k.className || (si !== undefined && (k.roles[si] === "hidden" || k.roles[si] === "out"))) return undefined;
      const c = k.content?.[si ?? 0];
      const text = typeof c === "string" ? c.replace(/[ \t\n\r\f]+/g, " ").trim() : "";
      const isText = si === undefined ? k.roles.includes("text") : k.roles[si] === "text";
      return { tag: k.tag, classes: [k.className], attrs: {}, fixtureId: k.id, line: k.line, text: isText ? text : "", ownText: isText ? text : "", runs: isText && text ? [text] : [], runMeta: isText && text ? [{ inBlock: false, underlined: false, items: [] }] : [], children: [], anonymous: true };
    };
    const byNodeAll = new Map(this.els.filter((e) => e.anonymous === undefined && !e.pseudo).map((e) => [e.node, e] as const));
    const hasGenerated = this.els.some((e) => e.pseudo);
    const fixtureFor = (si: number | undefined): Fixture => {
      const keep = (n: FixtureNode): FixtureNode | undefined => {
        const el = n.fixtureId ? byId.get(n.fixtureId) : undefined;
        if (!el) return undefined;
        if (si !== undefined && (el.roles[si] === "hidden" || el.roles[si] === "out")) return undefined;
        const isText = si === undefined ? el.roles.includes("text") : el.roles[si] === "text";
        // Element children, with anonymous text runs between them.
        const byEl = new Map(n.children.map((c) => [c.fixtureId ? byId.get(c.fixtureId) : undefined, c] as const));
        const children =
          isText || el.tag === "svg"
            ? el.tag === "svg" ? [] : n.children
            : (el.children.map((k) => (k.anonymous !== undefined ? anonNode(k, si) : k.pseudo ? pseudoNode(k, si) : byEl.has(k) ? keep(byEl.get(k)!) : undefined)).filter(Boolean) as FixtureNode[]);
        if (!isText && el.children.some((k) => k.anonymous !== undefined)) return { ...n, children, ownText: "" };
        // A replaced element or form control has no text box (a textarea's text is its value).
        const textless = si === undefined ? el.roles.every((r) => r !== "text" && r !== "container") : el.roles[si] !== "text" && el.roles[si] !== "container";
        // A form control's intrinsic width, as Chromium sizes it (controlWidth).
        const cw = this.controlWidth(el, si ?? 0);
        if (cw !== undefined) n = { ...n, controlWidth: cw };
        if (textless && n.text) return { ...n, children, text: "", runs: [] };
        const hidden = si === undefined ? hiddenNodes : hiddenAt[si];
        // Inline boxes with a weight or edges of their own, and generated content, are part of the text.
        const inline = this.inlineInfo(el, si ?? 0, byNodeAll);
        if (isText && (hidden.size || hasGenerated || this.styledInline(el, si ?? 0)))
          return { ...n, children, ...textAndRuns(el.node as unknown as P5Node, (x) => hidden.has(x as unknown as P5), inline) };
        return { ...n, children };
      };
      return { ...fixture, body: fixture.body.map(keep).filter(Boolean) as FixtureNode[] };
    };
    const perState = this.states.map((_, si) => fixtureFor(si));
    const fixtureAt = (w: number) => perState[this.states.indexOf(stateAt(this.states, w))];

    const lifted = this.liftOnce();
    this.relabel(lifted);

    const responsive = this.els.filter((e) => e.id && e.roles.some((r) => r === "hidden" || r === "out") && e.roles.some((r) => r !== "hidden" && r !== "out")).map((e) => e.id!);
    const spacingAt: (Issue & { inconclusive?: boolean })[][] = [];
    const runsAt: InlineRun[][] = [];
    const dynamic = (layout: Layout): Unlifted[] => {
      const si = this.states.indexOf(stateAt(this.states, layout.width));
      const out: Unlifted[] = [];
      const parentOf = new Map<Box, Box>();
      for (const b of walk(layout.boxes)) for (const c of b.children) parentOf.set(c, b);
      for (const b of walk(layout.boxes)) {
        const el = byId.get(b.id);
        if (!el) continue;
        const sel = `[data-fixture="${b.id}"]`;
        if (el.oneLine?.[si] && (el.alone[si] || el.rowLine?.[si]) && b.lines && b.lines.length > 1)
          out.push({ file: this.page, line: el.line, selector: sel, decl: "display: inline-block", reason: `its text takes ${b.lines.length} lines at ${layout.width}px; its line box is modelled for one line`, kind: "geometry" });
        if (el.rowGap[si] && this.lineCount(b) > 1)
          out.push({ file: this.page, line: el.line, selector: sel, decl: el.rowGap[si], reason: `the row wraps at ${layout.width}px and its row gap differs from its column gap; a cluster has one gap`, kind: "geometry" });
        // Shrinking differs from the browser's (flex-shrink 0 without a width; a width with
        // flex-shrink): it matters only where its line's items want more than the line.
        const parent = parentOf.get(b);
        if (el.noShrink[si] && parent && parent.props.pattern?.value === "cluster" && b.overfull)
          out.push({ file: this.page, line: el.line, selector: sel, decl: el.noShrink[si], reason: `its row is too full at ${layout.width}px, and it shrinks differently there (Cadesa shrinks an item without a width, never one with)`, kind: "geometry" });
        if (el.nowrap[si] && b.children.length > 1) {
          if (this.lineCount(b) > 1)
            out.push({ file: this.page, line: el.line, selector: sel, decl: "flex (flex-wrap: nowrap)", reason: `the row doesn't fit at ${layout.width}px; Tailwind's flex row shrinks its items instead of wrapping`, kind: "geometry" });
        }
        // repeat(auto-fill, minmax(X, 1fr)): one column never narrower than X, so it overflows a
        // narrower container; the engine's column fills it instead.
        if (b.props.min && b.props.pattern?.value === "grid" && innerWidth(b) < b.props.min.value - 0.001)
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
      cssFile: this.cssFile,
      lifted,
      yaml: lifted.yaml,
      html: fixtureHtml,
      standaloneHtml: this.generatedHtml(true),
      fixture: fixtureFor(undefined),
      fixtureAt,
      dynamic,
      states: this.states,
      responsive,
      notes: this.readerNotes,
      viewportHeight: this.viewportHeight,
      usesViewportHeight: this.usesViewportHeight,
      spacing: (w: number) => {
        const si = this.states.indexOf(stateAt(this.states, w));
        return (spacingAt[si] ??= this.runTogether(si));
      },
      inlineRuns: (w: number) => {
        const si = this.states.indexOf(stateAt(this.states, w));
        return (runsAt[si] ??= this.coloredRuns(si));
      },
      elements: { els: this.els, html: this.htmlEl, body: this.bodyEl },
    };
  }

  /**
   * Neighbours whose text runs together in state si: two inline elements, or a text and an inline
   * element, with nothing between them (no whitespace, and no margin, padding or border on the
   * touching sides), where a letter or digit meets a letter or digit. In a flex row whitespace
   * between items doesn't count, only the gap and the items' margins, padding and borders do.
   */
  runTogether(si: number): (Issue & { inconclusive?: boolean })[] {
    const out: (Issue & { inconclusive?: boolean })[] = [];
    const byNode = new Map(this.els.filter((e) => e.anonymous === undefined && !e.pseudo).map((e) => [e.node, e] as const));
    const res = (el: El, p: string) => {
      const o = el.own[si]?.get(p);
      return o ? this.resolve(el, si, o.value) : undefined;
    };
    /** An element's ::before or ::after where it generates a box. */
    const generated = (n: P5, which: "before" | "after") => byNode.get(n)?.children.find((c) => c.pseudo === which && c.content?.[si] !== undefined && !gone(c));
    const px = (el: El, p: string) => {
      const v = res(el, p);
      return v === undefined || v === "normal" ? 0 : (lengthPx(v, this.textOf(el, si).size) ?? NaN);
    };
    const border = (el: El, side: string) => (/^(none|hidden)$/.test(res(el, `border-${side}-style`) ?? "none") ? 0 : borderPx(px(el, `border-${side}-width`)));
    const gone = (el: El) => this.displayOf(el, si) === "none" || this.outOfFlow(el, si);
    const shown = (el: El) => {
      for (let x: El | undefined = el; x && x !== this.bodyEl; x = x.parent) if (gone(x)) return false;
      return true;
    };
    /** Element and text children as rendered: hidden and out-of-flow elements left out. */
    const kids = (n: P5): P5[] =>
      (n.childNodes ?? []).filter((c) => (c.nodeName === "#text" ? !!c.value : !!c.tagName && !SKIP.has(c.tagName) && !(byNode.has(c) && gone(byNode.get(c)!))));
    const genText = (g: El | undefined) => (typeof g?.content?.[si] === "string" ? (g.content[si] as string) : "");
    const textOf = (n: P5): string => (n.nodeName === "#text" ? (n.value ?? "") : n.tagName === "br" ? "\n" : genText(generated(n, "before")) + kids(n).map(textOf).join("") + genText(generated(n, "after")));
    /** Margin, padding and border on one side of an element and of the descendants whose text ends there. */
    const edge = (n: P5, side: "left" | "right"): number => {
      const el = byNode.get(n);
      if (!el) return 0;
      const k = side === "right" ? kids(n).at(-1) : kids(n)[0];
      const g = generated(n, side === "right" ? "after" : "before");
      const ge = g ? this.inlineEdges(g, si) : undefined;
      // Generated content on that side: its text is part of the element's, its edges sit between.
      if (g && genText(g)) return px(el, `margin-${side}`) + px(el, `padding-${side}`) + border(el, side) + (ge ? ge.open + ge.close : NaN);
      return px(el, `margin-${side}`) + px(el, `padding-${side}`) + border(el, side) + (g ? (ge ? ge.open + ge.close : NaN) : 0) + (k?.tagName ? edge(k, side) : 0);
    };
    /** Notes that make the answer unsure: generated content on the touching side, or a selector Cadesa can't decide. */
    const unsure = (n: P5, side: "left" | "right"): string | undefined => {
      const el = byNode.get(n);
      if (!el) return undefined;
      const g = generated(n, side === "right" ? "after" : "before");
      if (g && (typeof g.content![si] !== "string" || this.displayOf(g, si) !== "inline")) return `${g.own[si].get("content")?.utility ?? `::${g.pseudo}`} adds content Cadesa doesn't model`;
      if (g && genText(g)) return undefined;
      for (const { note, states } of el.notes.values()) {
        if (!states.has(si)) continue;
        if (/may match; Cadesa can't decide it/.test(note.reason) && note.kind !== "paint" && note.kind !== "none") return note.reason;
      }
      const k = side === "right" ? kids(n).at(-1) : kids(n)[0];
      return k?.tagName ? unsure(k, side) : undefined;
    };
    const words = (s: string, end: boolean) => {
      const w = s.trim().split(/\s+/);
      const t = end ? w.at(-1)! : w[0];
      return t.length > 24 ? (end ? `…${t.slice(-23)}` : `${t.slice(0, 23)}…`) : t;
    };
    const tagOf = (n: P5) => (n.nodeName === "#text" ? "text" : `<${n.tagName}>`);
    for (const p of [this.bodyEl, ...this.els]) {
      if (!p || p.anonymous !== undefined || !shown(p) || p.tag === "svg") continue;
      if (/^(table|tr|thead|tbody|tfoot|colgroup|col|select|option|optgroup|textarea|script|style)$/.test(p.tag)) continue;
      const d = this.displayOf(p, si);
      const flex = /^(inline-)?flex$/.test(d);
      if (/^(inline-)?grid$/.test(d) || d === "none") continue;
      if (flex) {
        if (/^column/.test(res(p, "flex-direction") ?? "row")) continue;
        // Free space between the items: they meet only on a full line.
        if (/^space-(between|around|evenly)$/.test(res(p, "justify-content") ?? "")) continue;
        if (!(px(p, "column-gap") === 0)) continue;
      }
      const seq = kids(p.node).filter((n) => !flex || n.nodeName !== "#text" || !isWs(n.value ?? ""));
      for (let i = 0; i + 1 < seq.length; i++) {
        const [a, b] = [seq[i], seq[i + 1]];
        if (a.nodeName === "#text" && b.nodeName === "#text") continue;
        if ([a, b].some((n) => n.tagName && /^(sub|sup|br|wbr|img|svg|input|select|textarea|button|video|canvas|iframe)$/.test(n.tagName))) continue;
        // Outside a flex row, a block-level neighbour starts a new line.
        if (!flex && [a, b].some((n) => byNode.has(n) && !this.isInlineLevel(byNode.get(n)!, si))) continue;
        const ta = textOf(a);
        const tb = textOf(b);
        const last = [...ta].at(-1) ?? "";
        const first = [...tb][0] ?? "";
        if (!/[\p{L}\p{N}]/u.test(last) || !/[\p{L}\p{N}]/u.test(first)) continue;
        const space = (a.tagName ? edge(a, "right") : 0) + (b.tagName ? edge(b, "left") : 0);
        if (space > 0) continue;
        const why = (a.tagName ? unsure(a, "right") : undefined) ?? (b.tagName ? unsure(b, "left") : undefined) ?? (isNaN(space) ? "a margin or padding between them couldn't be resolved" : undefined);
        let box: El | undefined = p;
        while (box && !(box.id && box.className && (box.roles[si] === "text" || box.roles[si] === "container" || box.roles[si] === "leaf"))) box = box.parent;
        if (!box) continue;
        const line = (b.sourceCodeLocation?.startLine ?? p.line) || p.line;
        const [wa, wb] = [words(ta, true), words(tb, false)];
        const wrapNote = flex && res(p, "flex-wrap") === "wrap" ? " when they share a line" : "";
        out.push({
          severity: "warning",
          id: box.id!,
          path: `${this.page}:${line}`,
          message: `"${wa}" and "${wb}" run together as "${wa}${wb}"${wrapNote}: nothing separates the ${tagOf(a)} and the ${tagOf(b)} in #${box.id} (no space, and no margin, padding${flex ? ", gap" : ""} or border); add a space or a margin`,
          ...(why && { inconclusive: true, message: `"${wa}" and "${wb}" may run together as "${wa}${wb}" in #${box.id}: ${why}` }),
        });
      }
    }
    return out;
  }

  /** A background color an inline element paints itself, as hex (undefined: none, or not a color). */
  ownBackground(k: El, si: number): string | undefined {
    const o = k.own[si]?.get("background-color");
    const v = o ? this.resolve(k, si, o.value) : undefined;
    const c = v && parseColor(v, parseColor(this.textOf(k, si).color.hex));
    return c && c.a > 0.0005 ? hexOf(c) : undefined;
  }

  /** Inline elements in text boxes whose own text is in another color or on a background of its own. */
  coloredRuns(si: number): InlineRun[] {
    const out: InlineRun[] = [];
    for (const el of this.els) {
      if (el.roles[si] !== "text" || !el.id || el.anonymous !== undefined) continue;
      const base = this.textOf(el, si).color.hex;
      const visit = (k: El) => {
        if (k.anonymous !== undefined || k.tag === "br" || this.displayOf(k, si) === "none" || this.outOfFlow(k, si)) return;
        const t = this.textOf(k, si);
        const bg = this.ownBackground(k, si);
        const own = (k.node.childNodes ?? []).filter((c) => c.nodeName === "#text").map((c) => c.value ?? "").join("").replace(/\s+/g, " ").trim();
        if (own && (t.color.hex !== base || bg))
          out.push({ id: el.id!, tag: k.tag, text: own, color: t.color.hex, ...(bg && { background: bg }), sizePx: t.size, weight: t.weight, where: `${this.page}:${k.line}` });
        k.children.forEach(visit);
      };
      el.children.forEach(visit);
    }
    return out;
  }

  /** Lines a cluster box laid its children out on. */
  lineCount(b: Box): number {
    return linesOf(b).length;
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
      if (utility && !u.decl.startsWith(`${utility} `)) u.decl = `${utility} → ${u.decl}`;
    }
    lifted.yaml = emitYaml(lifted.data, this.page, lifted.unlifted).replace(/^# Lifted from (.*) by cadesa lift\./m, `# Lifted from $1 (${this.label}) by cadesa lift.`);
    const resp = this.els.filter((e) => e.id && e.roles.some((r) => r === "hidden") && e.roles.some((r) => r !== "hidden" && r !== "out"));
    if (resp.length)
      lifted.yaml += `\n# Shown at some widths only (display: none elsewhere): ${resp.map((e) => `#${e.id}`).join(", ")}.\n# Cadesa sources have no display: none; cadesa --tailwind lays these out only where they're shown.\n`;
  }

  /**
   * The page with generated classes and ids. For `standalone` (a fixture for plain Cadesa commands),
   * elements never displayed are removed and svg contents emptied, since the engine lays out
   * every element child it's given.
   */
  generatedHtml(standalone = false): string {
    const edits: { at: number; end: number; text: string }[] = [];
    const removed = (el: El): boolean => !!el.parent && (this.ignorable(el.parent) || removed(el.parent));
    for (const el of this.els) {
      const loc = el.node.sourceCodeLocation;
      if (standalone && loc) {
        if (removed(el)) continue;
        if (this.ignorable(el)) {
          edits.push({ at: loc.startOffset, end: loc.endOffset, text: "" });
          continue;
        }
        if (el.tag === "svg" && loc.startTag && loc.endTag) edits.push({ at: loc.startTag.endOffset, end: loc.endTag.startOffset, text: "" });
      }
      if (!el.className) continue;
      // An element the HTML parser made up (the <tbody> around rows written straight in a <table>):
      // written out around its children, so the fixture has it with its class and id.
      if (!loc && el.tag === "tbody") {
        const kids = (el.node.childNodes ?? []).filter((c) => c.sourceCodeLocation);
        const first = kids[0]?.sourceCodeLocation;
        const last = kids.at(-1)?.sourceCodeLocation;
        if (first && last) {
          edits.push({ at: first.startOffset, end: first.startOffset, text: `<tbody class="${[...el.classes, el.className].join(" ")}" data-fixture="${el.id}">` });
          edits.push({ at: last.endOffset, end: last.endOffset, text: "</tbody>" });
        }
        continue;
      }
      if (!loc?.startTag) continue;
      const cls = loc.attrs?.class;
      const value = [...el.classes, el.className].join(" ");
      if (cls) edits.push({ at: cls.startOffset, end: cls.endOffset, text: `class="${value}"` });
      else edits.push({ at: loc.startTag.startOffset + 1 + el.tag.length, end: loc.startTag.startOffset + 1 + el.tag.length, text: ` class="${value}"` });
      if (!attr(el.node, "data-fixture")) edits.push({ at: loc.startTag.startOffset + 1 + el.tag.length, end: loc.startTag.startOffset + 1 + el.tag.length, text: ` data-fixture="${el.id}"` });
    }
    // Back to front; at one offset, later-inserted text first so attributes keep their order.
    edits.sort((a, b) => b.at - a.at || b.end - a.end);
    let out = this.html;
    for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
    return out;
  }
}

/** A transform (or translate, rotate, scale) that leaves the box where it is: translateZ(0), scale(1), rotate(0deg). */
export function identityTransform(prop: string, v: string): boolean {
  const zero = (a: string) => /^[+-]?(0*\.?0+)(px|rem|em|%|deg|rad|turn|grad)?$/.test(a.trim());
  const one = (a: string) => /^[+-]?(1(\.0*)?|100%)$/.test(a.trim());
  const s = v.trim().toLowerCase();
  if (s === "none") return true;
  if (prop === "translate") return s.split(/\s+/).every(zero);
  if (prop === "scale") return s.split(/\s+/).every(one);
  if (prop === "rotate") return zero(s.split(/\s+/).at(-1)!);
  const fns = [...s.matchAll(/([a-z0-9]+)\(([^()]*)\)\s*/g)];
  if (!fns.length || fns.map((m) => m[0]).join("").trim() !== s) return false;
  return fns.every(([, name, args]) => {
    const xs = args.split(",");
    if (/^translate(x|y|z|3d)?$/.test(name) || /^skew(x|y)?$/.test(name)) return xs.every(zero);
    if (/^scale(x|y|z|3d)?$/.test(name)) return xs.every(one);
    if (/^rotate(x|y|z)?$/.test(name)) return zero(xs[0]);
    if (name === "rotate3d") return xs.length === 4 && zero(xs[3]);
    return false;
  });
}

/** How many column tracks grid-template-columns makes (none: one implicit column), or undefined (auto-fill, subgrid, line names...). */
export function gridTrackCount(v: string): number | undefined {
  const s = v.trim();
  if (s === "" || s === "none") return 1;
  if (/\[|auto-fill|auto-fit|subgrid|masonry/.test(s)) return undefined;
  let n = 0;
  let depth = 0;
  let cur = "";
  const flush = () => {
    if (!cur) return true;
    const rep = /^repeat\(\s*(\d+)\s*,\s*(.+)\)$/s.exec(cur);
    if (rep) {
      const inner = gridTrackCount(rep[2]);
      if (inner === undefined) return false;
      n += parseInt(rep[1]) * inner;
    } else n++;
    cur = "";
    return true;
  };
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (!flush()) return undefined;
    } else cur += ch;
  }
  return flush() ? n : undefined;
}

/** Absolute units (pt, pc, in, cm, mm, Q) in px, as the browser converts them (1in = 96px). */
export function absolute(v: string): string {
  if (/url\(|["']/.test(v)) return v;
  return v.replace(/(^|[^\w.-])(-?(?:\d+\.?\d*|\.\d+))(pt|pc|in|cm|mm|q)\b/gi, (_, pre, n, u) => `${pre}${Math.round(parseFloat(n) * ABSOLUTE[u.toLowerCase()] * 1e6) / 1e6}px`);
}

function innerWidth(b: Box) {
  const i = insets(b.props);
  return b.w - i.left - i.right;
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

/**
 * The text of a `content` value: its strings, with CSS escapes ("\\2022") decoded, before any
 * alternative text ("/ ..."). undefined for none and normal (no box); `{ unknown }` for anything
 * else Cadesa can't read (counter(), attr(), url(), quotes).
 */
export function contentText(v: string): string | { unknown: string } | undefined {
  const t = v.trim();
  if (/^(none|normal|initial|unset)$/.test(t)) return undefined;
  let out = "";
  let i = 0;
  const unknown = { unknown: t.slice(0, 60) };
  while (i < t.length) {
    const ch = t[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/") break;
    if (ch !== '"' && ch !== "'") return unknown;
    let j = i + 1;
    let str = "";
    while (j < t.length && t[j] !== ch) {
      if (t[j] === "\\") {
        const m = /^\\([0-9a-fA-F]{1,6})\s?/.exec(t.slice(j));
        if (m) {
          str += String.fromCodePoint(parseInt(m[1], 16));
          j += m[0].length;
        } else if (t[j + 1] === "\n") j += 2;
        else {
          str += t[j + 1] ?? "";
          j += 2;
        }
      } else str += t[j++];
    }
    if (j >= t.length) return unknown;
    out += str;
    i = j + 1;
  }
  return out;
}

/**
 * Initial values that are also every element's default in Chromium's stylesheet: a declaration of
 * one changes nothing (`font-variant: normal` on an icon, `float: none`, `transform-origin` with no
 * transform is handled elsewhere). Properties whose default differs by element (display, margins,
 * white-space, text-decoration, vertical-align, overflow) aren't listed.
 */
const INITIAL: Record<string, RegExp> = {
  "font-variant": /^normal$/,
  "font-variant-caps": /^normal$/,
  "font-variant-ligatures": /^normal$/,
  "font-variant-numeric": /^normal$/,
  "font-variant-east-asian": /^normal$/,
  "font-variant-position": /^normal$/,
  "font-variant-alternates": /^normal$/,
  "font-variant-emoji": /^normal$/,
  "font-feature-settings": /^normal$/,
  "font-variation-settings": /^normal$/,
  "font-stretch": /^(normal|100%)$/,
  "font-kerning": /^auto$/,
  "font-optical-sizing": /^auto$/,
  "font-synthesis": /^(weight style small-caps|weight style|style weight)$/,
  "font-size-adjust": /^none$/,
  "text-transform": /^none$/,
  "text-indent": /^0(px)?$/,
  "word-spacing": /^(normal|0(px)?)$/,
  "letter-spacing": /^(normal|0(px|em)?)$/,
  "word-break": /^normal$/,
  "line-break": /^auto$/,
  "hyphens": /^manual$/,
  "tab-size": /^8$/,
  "text-rendering": /^auto$/,
  "float": /^none$/,
  "clear": /^none$/,
  "position": /^static$/,
  "z-index": /^auto$/,
  "order": /^0$/,
  "flex-grow": /^0$/,
  "flex-shrink": /^1$/,
  "flex-basis": /^auto$/,
  "align-self": /^auto$/,
  "justify-self": /^auto$/,
  "min-width": /^auto$/,
  "max-width": /^none$/,
  "max-height": /^none$/,
  "aspect-ratio": /^auto$/,
  "filter": /^none$/,
  "backdrop-filter": /^none$/,
  "clip-path": /^none$/,
  "mask": /^none$/,
  "mask-image": /^none$/,
  "perspective": /^none$/,
  "transform-style": /^flat$/,
  "backface-visibility": /^visible$/,
  "will-change": /^auto$/,
  "contain": /^none$/,
  "isolation": /^auto$/,
  "mix-blend-mode": /^normal$/,
  "visibility": /^visible$/,
  "opacity": /^1$/,
  "box-shadow": /^none$/,
  "text-shadow": /^none$/,
  "outline-offset": /^0(px)?$/,
  "object-fit": /^fill$/,
  "object-position": /^(50% 50%|center|center center)$/,
  "resize": /^none$/,
  "user-select": /^auto$/,
  "pointer-events": /^auto$/,
  "touch-action": /^auto$/,
  "writing-mode": /^horizontal-tb$/,
  "unicode-bidi": /^normal$/,
  "text-orientation": /^mixed$/,
  "column-count": /^auto$/,
  "column-width": /^auto$/,
  "columns": /^auto$/,
  "content-visibility": /^visible$/,
  "scroll-behavior": /^auto$/,
  "overscroll-behavior": /^auto$/,
  "translate": /^none$/,
  "rotate": /^none$/,
  "scale": /^none$/,
};
export const isInitial = (prop: string, value: string | undefined) => value !== undefined && !!INITIAL[prop]?.test(value.trim().toLowerCase());
