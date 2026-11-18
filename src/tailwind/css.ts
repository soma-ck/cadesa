/**
 * Read a compiled Tailwind stylesheet: theme variables, registered properties, preflight, and every
 * utility rule indexed by the class it styles, with its media conditions and source order.
 */
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from "postcss";

export interface TwDecl {
  prop: string;
  value: string;
  important: boolean;
}

/** A width condition: true when `width >= px` (ge) or `width < px` (lt). */
export interface WidthCond {
  op: "ge" | "lt";
  px: number;
  /** As written, e.g. "48rem". */
  raw: string;
}

export interface MediaInfo {
  raw: string;
  widths: WidthCond[];
  /** Non-width features: true/false when known in a default desktop browser, else the reason it isn't. */
  env: true | false | { unknown: string };
  /** The query is `prefers-color-scheme: dark` (the `dark:` variant). */
  dark?: boolean;
}

export interface TwRule {
  selector: string;
  /** The class this rule styles (unescaped), when the class is the selector's subject. */
  subject?: string;
  /** Pseudo-classes on the subject compound, e.g. ["hover"], ["first-child"]. */
  pseudos: string[];
  pseudoElement?: string;
  /** `:where(.space-y-4 > :not(:last-child))`: styles the children of `.space-y-4`. */
  spaceChildren?: "y" | "x";
  /** The selector is more than `.class` + pseudo-classes (descendant, group-*, peer-*, ...). */
  complex: boolean;
  media: MediaInfo[];
  decls: TwDecl[];
  order: number;
  line: number;
  layer?: string;
}

export interface Registered {
  inherits: boolean;
  initial?: string;
}

export interface TailwindCss {
  file: string;
  /** Custom properties defined on :root / :host (the theme), unresolved. */
  theme: Map<string, string>;
  registered: Map<string, Registered>;
  /** Utility (and other class) rules, by every class name they mention. */
  byClass: Map<string, TwRule[]>;
  /** Rules outside the theme/base/utilities layers that don't style a class subject (custom CSS). */
  other: TwRule[];
  /** Tailwind's preflight is present (margins, padding and borders reset; border-box everywhere). */
  preflight: boolean;
  /** The root `html` declarations from the base layer (font-family, line-height). */
  rootDecls: Map<string, string>;
  version?: string;
}

/** Unescape a CSS identifier (`md\:p-4` → `md:p-4`, `\32 xl` → `2xl`). */
export function unescapeIdent(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));
}

const CLASS = /\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)/g;

export function classesIn(selector: string): string[] {
  return [...selector.matchAll(CLASS)].map((m) => unescapeIdent(m[1]));
}

const LEN = /^(-?[\d.]+)(px|rem|em)$/;
const toPx = (v: string) => {
  const m = LEN.exec(v.trim());
  return m ? parseFloat(m[1]) * (m[2] === "px" ? 1 : 16) : undefined;
};

/** Parse one media query (Tailwind v4 range syntax or min-/max-width). */
export function parseMediaQuery(raw: string): MediaInfo {
  const q = raw.trim();
  const out: MediaInfo = { raw: q, widths: [], env: true };
  if (/,/.test(q) || /^not\b/.test(q)) return { ...out, env: { unknown: `@media ${q}` } };
  const parts = q.split(/\s+and\s+/i);
  for (const p0 of parts) {
    const p = p0.trim();
    if (/^(?:only\s+)?(?:screen|all)$/i.test(p)) continue;
    if (/^print$/i.test(p)) {
      out.env = false;
      continue;
    }
    let m = /^\(\s*width\s*(>=|>|<=|<)\s*([^)]+?)\s*\)$/.exec(p);
    if (m && toPx(m[2]) !== undefined) {
      const px = toPx(m[2])!;
      const raw = m[2].trim();
      if (m[1] === ">=") out.widths.push({ op: "ge", px, raw });
      else if (m[1] === "<") out.widths.push({ op: "lt", px, raw });
      else if (m[1] === ">") out.widths.push({ op: "ge", px: px + 0.01, raw: `${raw}+` });
      else out.widths.push({ op: "lt", px: px + 0.01, raw: `${raw}+` });
      continue;
    }
    m = /^\(\s*(min|max)-width\s*:\s*([^)]+?)\s*\)$/.exec(p);
    if (m && toPx(m[2]) !== undefined) {
      const px = toPx(m[2])!;
      out.widths.push(m[1] === "min" ? { op: "ge", px, raw: m[2].trim() } : { op: "lt", px: px + 0.01, raw: `${m[2].trim()}+` });
      continue;
    }
    m = /^\(\s*([a-z-]+)\s*:\s*([a-z-]+)\s*\)$/i.exec(p);
    const known: Record<string, Record<string, boolean>> = {
      hover: { hover: true, none: false },
      "any-hover": { hover: true, none: false },
      pointer: { fine: true, coarse: false, none: false },
      "any-pointer": { fine: true, coarse: false, none: false },
      "prefers-reduced-motion": { "no-preference": true, reduce: false },
      "prefers-contrast": { "no-preference": true, more: false, less: false },
      "forced-colors": { none: true, active: false },
      "prefers-color-scheme": { light: true, dark: false },
      scripting: { enabled: true, none: false },
    };
    if (m && known[m[1]] && m[2] in known[m[1]]) {
      if (m[1] === "prefers-color-scheme" && m[2] === "dark") out.dark = true;
      if (!known[m[1]][m[2]] && out.env === true) out.env = false;
      continue;
    }
    if (out.env === true || out.env === false) out.env = { unknown: `@media ${p}` };
  }
  return out;
}

/** Does `width` satisfy every width condition? */
export function widthsHold(conds: WidthCond[], width: number) {
  return conds.every((c) => (c.op === "ge" ? width >= c.px : width < c.px));
}

/** `@supports` inside utilities: modern-feature checks hold in Chromium; Safari/Firefox sniffing doesn't. */
const supportsHolds = (params: string) => !/-webkit-hyphens|-moz-orient|margin-trim/.test(params);

const STATE = /^(hover|focus|focus-visible|focus-within|active|visited|target|checked|disabled|enabled|invalid|valid|placeholder-shown|open|indeterminate|required|optional|read-only|autofill|user-invalid|user-valid|in-range|out-of-range|default|popover-open)$/;
export const isStatePseudo = (p: string) => STATE.test(p.replace(/\(.*$/, ""));

function analyse(selector: string): Pick<TwRule, "subject" | "pseudos" | "pseudoElement" | "spaceChildren" | "complex"> {
  const s = selector.trim();
  const space = /^:where\(\s*(\.(?:\\.|[\w-])+)\s*>\s*:not\(:last-child\)\s*\)$/.exec(s);
  if (space) {
    const cls = classesIn(space[1])[0];
    const axis = /^space-(x|y)-|:space-(x|y)-/.exec(cls);
    if (axis) return { subject: cls, pseudos: [], spaceChildren: (axis[1] ?? axis[2]) as "x" | "y", complex: false };
  }
  // A single compound: .class followed by pseudo-classes / one pseudo-element.
  const m = /^\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)((?::{1,2}[\w-]+(?:\([^)]*\))?)*)$/.exec(s);
  if (m) {
    const pseudos: string[] = [];
    let pseudoElement: string | undefined;
    for (const pm of m[2].matchAll(/(:{1,2})([\w-]+(?:\([^)]*\))?)/g)) {
      if (pm[1] === "::" || /^(before|after|first-line|first-letter|marker|placeholder|selection|file-selector-button|backdrop)$/.test(pm[2])) pseudoElement = pm[2];
      else pseudos.push(pm[2]);
    }
    return { subject: unescapeIdent(m[1]), pseudos, pseudoElement, complex: false };
  }
  const classes = classesIn(s);
  return { subject: classes[classes.length - 1], pseudos: [], complex: true };
}

export function parseTailwindCss(file: string, text: string): TailwindCss {
  const root = postcss.parse(text, { from: file });
  const theme = new Map<string, string>();
  const registered = new Map<string, Registered>();
  const byClass = new Map<string, TwRule[]>();
  const other: TwRule[] = [];
  const rootDecls = new Map<string, string>();
  let preflight = false;
  let order = 0;
  const version = /tailwindcss v([\d.]+)/.exec(text)?.[1];

  const declsOf = (r: Container): TwDecl[] => {
    const out: TwDecl[] = [];
    r.each((n) => {
      if (n.type === "decl") out.push({ prop: n.prop.toLowerCase().startsWith("--") ? n.prop : n.prop.toLowerCase(), value: n.value.trim(), important: n.important });
      else if (n.type === "atrule" && n.name === "supports" && supportsHolds(n.params)) out.push(...declsOf(n));
    });
    return out;
  };

  const visitRule = (r: Rule, media: MediaInfo[], layer: string | undefined, parentSel?: string) => {
    const selectors = (parentSel ? r.selectors.map((s) => (s.includes("&") ? s.replace(/&/g, parentSel) : `${parentSel} ${s}`)) : r.selectors).map((s) => s.trim());
    const decls = declsOf(r);
    const line = r.source?.start?.line ?? 0;
    if (layer === "theme") {
      for (const d of decls) if (d.prop.startsWith("--")) theme.set(d.prop, d.value);
      return;
    }
    if (layer === "base") {
      const all = selectors.join(",");
      const props = new Map(decls.map((d) => [d.prop, d.value]));
      if (/^\*/.test(all) && props.get("box-sizing") === "border-box" && props.get("margin") === "0" && props.get("padding") === "0" && /^0 solid$/.test(props.get("border") ?? ""))
        preflight = true;
      if (selectors.includes("html") && !media.length) for (const [k, v] of props) rootDecls.set(k, v);
      return;
    }
    if (layer === "properties") return;
    for (const sel of selectors) {
      if (/^(:root|:host)$/.test(sel) && !media.length) {
        for (const d of decls) if (d.prop.startsWith("--")) theme.set(d.prop, d.value);
      }
      const rule: TwRule = { selector: sel, ...analyse(sel), media, decls, order: order++, line, layer };
      if (rule.subject && layer === "utilities") {
        const list = byClass.get(rule.subject) ?? [];
        list.push(rule);
        byClass.set(rule.subject, list);
      } else if (decls.some((d) => !d.prop.startsWith("--")) || !/^(:root|:host)$/.test(sel)) other.push(rule);
    }
    // Nested rules (CSS nesting, e.g. `&:hover`) and nested @media.
    r.each((n) => {
      if (n.type === "rule") for (const sel of selectors) visitRule(n.clone({ selectors: n.selectors }) as Rule, media, layer, sel);
      else if (n.type === "atrule" && n.name === "media") {
        for (const sel of selectors) {
          const wrap = postcss.rule({ selector: "&" });
          n.each((c) => void wrap.append(c.clone()));
          visitRule(wrap, [...media, parseMediaQuery(n.params)], layer, sel);
        }
      }
    });
  };

  const visit = (n: ChildNode, media: MediaInfo[], layer: string | undefined) => {
    if (n.type === "rule") visitRule(n, media, layer);
    else if (n.type === "atrule") {
      const a = n as AtRule;
      const name = a.name.toLowerCase();
      if (name === "layer" && a.nodes) a.each((c) => visit(c, media, a.params.trim() || layer));
      else if (name === "media") a.each((c) => visit(c, [...media, parseMediaQuery(a.params)], layer));
      else if (name === "supports" && supportsHolds(a.params)) a.each((c) => visit(c, media, layer));
      else if (name === "property") {
        const props = new Map(declsOf(a).map((d) => [d.prop, d.value]));
        registered.set(a.params.trim(), { inherits: props.get("inherits") !== "false", initial: props.get("initial-value") });
      }
      // @font-face, @keyframes, @layer declarations: nothing to lay out.
    }
  };
  root.each((n) => visit(n, [], undefined));
  return { file, theme, registered, byClass, other, preflight, rootDecls, version };
}
