/**
 * Plain-CSS front end for lift: an HTML page plus its stylesheet becomes a Cadesa source and a
 * fixture, element by element, the way the browser's cascade styles it.
 *
 *   1. Every rule (the stylesheet, the page's own <style> blocks, style="" attributes, and the parts
 *      of the browser's default stylesheet that matter for layout) is matched against every element:
 *      type, class, id, attribute and structural selectors with all four combinators, :is() /
 *      :where() / :not(). Rules that apply only in an interactive state (:hover) don't apply;
 *      selectors that can't be decided (:has(), :focus-within...) are recorded against the element.
 *   2. Declarations are ordered by importance, origin, specificity and source order, per width
 *      range: every min-width / max-width condition splits the widths into ranges, the widest the
 *      base and each narrower one a max-width breakpoint (max-width: 480px stays 480px; below
 *      min-width: 768px is 767.99px).
 *   3. The shared page lift (page.ts) does the rest: inherited text, roles, block flow (a flow, with
 *      its margins), generated classes and ids. Components and slots are named after the elements'
 *      classes (BEM .block__element gives slot "element").
 */
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from "postcss";
import { heightsHold, parseMediaQuery, type MediaInfo } from "../tailwind/css.js";
import { cssValue } from "./css.js";
import { kindOf, worst, type ImpactKind } from "./lift.js";
import { attr, longhands, PageLifter, round, type El, type Origin, type PageLift, type State } from "./page.js";

// ---------------------------------------------------------------- the browser's defaults

/**
 * What Chromium's default stylesheet sets that changes layout or measured text (display comes from
 * the tag; strong/b/small are computed down the tree). Form controls get their own font, so their
 * text isn't measured until the page sets one.
 */
const UA_CSS = `
[hidden] { display: none }
input[type=hidden i] { display: none !important }
body { margin: 8px }
p, blockquote, figure, dl, ul, ol, menu, pre { margin-top: 1em; margin-bottom: 1em }
blockquote, figure { margin-left: 40px; margin-right: 40px }
dd { margin-left: 40px }
ul, ol, menu { padding-left: 40px }
ul ul, ul ol, ol ul, ol ol, ul menu, ol menu, menu ul, menu ol, menu menu { margin-top: 0; margin-bottom: 0 }
h1 { font-size: 2em; margin-top: 0.67em; margin-bottom: 0.67em; font-weight: bold }
h2 { font-size: 1.5em; margin-top: 0.83em; margin-bottom: 0.83em; font-weight: bold }
h3 { font-size: 1.17em; margin-top: 1em; margin-bottom: 1em; font-weight: bold }
h4 { margin-top: 1.33em; margin-bottom: 1.33em; font-weight: bold }
h5 { font-size: 0.83em; margin-top: 1.67em; margin-bottom: 1.67em; font-weight: bold }
h6 { font-size: 0.67em; margin-top: 2.33em; margin-bottom: 2.33em; font-weight: bold }
table { border-collapse: separate; border-spacing: 2px; box-sizing: border-box }
thead, tbody, tfoot { vertical-align: middle }
tr, td, th { vertical-align: inherit }
td, th { padding: 1px }
th { font-weight: bold; text-align: center }
caption { text-align: center }
hr { margin: 0.5em auto; border-width: 1px; border-style: inset; color: #808080; overflow: hidden }
a:any-link { color: #0000ee; text-decoration: underline }
pre, code, kbd, samp, tt { font-family: monospace }
small { font-size: smaller }
sub { vertical-align: sub; font-size: smaller }
sup { vertical-align: super; font-size: smaller }
button, input, select, textarea { font-family: system-ui; font-size: 13.333333px; font-weight: 400; line-height: normal; letter-spacing: normal; text-transform: none; color: #000000 }
button { text-align: center }
button, select, input[type=button], input[type=submit], input[type=reset], input[type=image], input[type=checkbox], input[type=radio], input[type=color], input[type=file] { box-sizing: border-box }
button, input[type=button], input[type=submit], input[type=reset] { padding: 1px 6px; border: 2px outset #767676 }
input { padding: 1px 2px; border: 2px inset #767676 }
input[type=checkbox i] { margin: 3px 3px 3px 4px; padding: 0; border: none; box-sizing: border-box }
input[type=radio i] { margin: 3px 3px 0px 5px; padding: 0; border: none; box-sizing: border-box }
input[type=range i] { margin: 2px; padding: 0; border: none }
input[type=color i] { width: 50px; height: 27px; border-width: 1px; padding: 1px 2px }
input[type=date i], input[type=time i], input[type=datetime-local i], input[type=month i], input[type=week i] { padding: 0 0 0 1px }
select { border: 1px solid #767676 }
textarea { padding: 2px; border: 1px solid #767676; font-family: monospace }
`;

// ---------------------------------------------------------------- selectors

interface Simple {
  kind: "tag" | "id" | "class" | "attr" | "pseudo" | "pseudo-element";
  name: string;
  /** attr: operator and value; pseudo: the argument. */
  op?: string;
  value?: string;
  arg?: string;
  /** :is() / :where() / :not() arguments. */
  list?: Complex[];
  /** :has() arguments: relative selectors, each with its leading combinator. */
  relative?: { comb: " " | ">" | "+" | "~"; complex: Complex }[];
  /** :is() or :where() with an argument this matcher can't read. */
  unread?: boolean;
}
interface Compound {
  simples: Simple[];
}
/** A complex selector, right to left: `parts[0]` is the subject; `combs[i]` joins parts[i] to parts[i + 1]. */
interface Complex {
  parts: Compound[];
  combs: (" " | ">" | "+" | "~")[];
  text: string;
}

/** Split on top-level commas. */
function splitList(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0 && !quote) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const IDENT = String.raw`(?:\\.|[\w-]|[^\x00-\x7f])+`;
const unescape = (s: string) => s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));

/** Parse one complex selector. Undefined when it uses syntax this matcher doesn't read. */
export function parseSelector(text: string): Complex | undefined {
  const parts: Compound[] = [];
  const combs: Complex["combs"] = [];
  let i = 0;
  const s = text.trim();
  let cur: Simple[] = [];
  let pendingComb: Complex["combs"][number] | undefined;
  const flush = () => {
    if (!cur.length) return false;
    parts.push({ simples: cur });
    cur = [];
    return true;
  };
  const re = {
    tag: new RegExp(`^(\\*|${IDENT})`),
    id: new RegExp(`^#(${IDENT})`),
    cls: new RegExp(`^\\.(${IDENT})`),
    attr: new RegExp(`^\\[\\s*(${IDENT})\\s*(?:([~|^$*]?=)\\s*(?:"([^"]*)"|'([^']*)'|(${IDENT}))\\s*(i|s)?)?\\s*\\]`),
    pseudo: new RegExp(`^(::?)(${IDENT})`),
  };
  while (i < s.length) {
    const rest = s.slice(i);
    const ws = /^\s*([>+~])\s*|^\s+/.exec(rest);
    if (ws) {
      if (!cur.length) {
        if (ws[1] && !parts.length) return undefined; // leading combinator
      }
      if (!flush() && ws[1] && pendingComb) return undefined;
      pendingComb = (ws[1] as ">" | "+" | "~" | undefined) ?? (pendingComb && pendingComb !== " " ? pendingComb : " ");
      i += ws[0].length;
      continue;
    }
    if (pendingComb && parts.length && !cur.length) {
      combs.push(pendingComb);
      pendingComb = undefined;
    }
    let m: RegExpExecArray | null;
    if ((m = re.id.exec(rest))) cur.push({ kind: "id", name: unescape(m[1]) });
    else if ((m = re.cls.exec(rest))) cur.push({ kind: "class", name: unescape(m[1]) });
    else if ((m = re.attr.exec(rest))) cur.push({ kind: "attr", name: unescape(m[1]).toLowerCase(), op: m[2], value: m[3] ?? m[4] ?? (m[5] !== undefined ? unescape(m[5]) : undefined) });
    else if ((m = re.pseudo.exec(rest))) {
      const name = m[2].toLowerCase();
      let len = m[0].length;
      let arg: string | undefined;
      if (s[i + len] === "(") {
        let depth = 0;
        let j = i + len;
        for (; j < s.length; j++) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")" && --depth === 0) break;
        }
        if (j >= s.length) return undefined;
        arg = s.slice(i + len + 1, j);
        len = j + 1 - i;
      }
      const element = m[1] === "::" || /^(before|after|first-line|first-letter)$/.test(name);
      const simple: Simple = { kind: element ? "pseudo-element" : "pseudo", name, arg };
      if (!element && /^(is|where|not|matches|-webkit-any)$/.test(name)) {
        const list = splitList(arg ?? "").map(parseSelector);
        // :is() and :where() take a forgiving list (an argument Chromium can't read is dropped); one this
        // matcher can't read leaves the answer undecided unless another argument matches. :not() is strict.
        if (name === "not" && list.some((x) => !x)) return undefined;
        simple.list = list.filter(Boolean) as Complex[];
        if (list.some((x) => !x)) simple.unread = true;
      }
      // :has(): relative selectors, each anchored at the element (`> .a` is a child, `.a` a descendant, `+ .a` the next sibling).
      if (!element && name === "has") {
        const list = splitList(arg ?? "").map((r) => {
          const m = /^\s*([>+~])?\s*([\s\S]*)$/.exec(r)!;
          return { comb: (m[1] ?? " ") as " " | ">" | "+" | "~", complex: parseSelector(`:${ANCHOR}${m[1] ? ` ${m[1]} ` : " "}${m[2]}`) };
        });
        if (!list.length || list.some((x) => !x.complex)) return undefined;
        simple.relative = list as { comb: " " | ">" | "+" | "~"; complex: Complex }[];
      }
      cur.push(simple);
      m = { 0: s.slice(i, i + len) } as unknown as RegExpExecArray;
    } else if ((m = re.tag.exec(rest)) && !cur.length) cur.push({ kind: "tag", name: m[1] === "*" ? "*" : unescape(m[1]).toLowerCase() });
    else return undefined;
    i += m[0].length;
  }
  if (!flush()) return undefined;
  if (combs.length !== parts.length - 1) return undefined;
  parts.reverse();
  combs.reverse();
  return { parts, combs, text: s };
}

/** [ids, classes / attributes / pseudo-classes, types / pseudo-elements]. */
export function specificityOf(c: Complex): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  const add = (x: [number, number, number]) => x.forEach((v, i) => (out[i] += v));
  for (const part of c.parts)
    for (const s of part.simples) {
      if (s.kind === "id") out[0]++;
      else if (s.kind === "class" || s.kind === "attr") out[1]++;
      else if (s.kind === "tag" && s.name !== "*") out[2]++;
      else if (s.kind === "pseudo-element") out[2]++;
      else if (s.kind === "pseudo") {
        if (s.name === "where" || s.name === ANCHOR) continue;
        const list = s.list ?? s.relative?.map((r) => r.complex);
        if (list) {
          const best = list.map(specificityOf).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
          if (best) add(best);
        } else out[1]++;
      }
    }
  return out;
}

/** Match result, best first: yes, then undecided, then only in an interactive state, then no. */
type M = "yes" | "unknown" | "state" | "no";
const RANK: Record<M, number> = { yes: 3, unknown: 2, state: 1, no: 0 };
const best = (xs: M[]): M => xs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "no" as M);
/** Every part must hold: the weakest result. */
const all = (xs: M[]): M => (xs.includes("no") ? "no" : xs.includes("unknown") ? "unknown" : xs.includes("state") ? "state" : "yes");

const STATE = /^(hover|focus|focus-visible|active|focus-within|target|target-within|user-invalid|user-valid|autofill|-webkit-autofill|popover-open|modal|fullscreen|picture-in-picture|playing|paused)$/;

/** The language of an element: its own lang attribute, or the nearest ancestor's. */
const langOf = (el: El | undefined): string | undefined => {
  for (let x = el; x; x = x.parent) {
    const l = attr(x.node, "lang");
    if (l !== undefined) return l.toLowerCase();
  }
  return undefined;
};
/** Its direction: the nearest dir attribute (auto counts as ltr for Latin text), else ltr. */
const dirOf = (el: El | undefined): string => {
  for (let x = el; x; x = x.parent) {
    const d = attr(x.node, "dir")?.toLowerCase();
    if (d === "rtl" || d === "ltr") return d;
  }
  return "ltr";
};
/**
 * Constraint validation from the markup alone: a required control with no value is invalid, and so
 * is a form or fieldset holding one. Undefined when it can't be told (a pattern, a type's format).
 */
function validity(el: El): boolean | undefined {
  if (el.tag === "form" || el.tag === "fieldset") {
    const below = (x: El): El[] => x.children.flatMap((k) => [k, ...below(k)]);
    const vs = below(el).filter((k) => /^(input|select|textarea)$/.test(k.tag)).map(validity);
    return vs.includes(false) ? false : vs.includes(undefined) ? undefined : true;
  }
  if (!/^(input|select|textarea)$/.test(el.tag)) return undefined;
  if (attr(el.node, "disabled") !== undefined) return true;
  const type = (attr(el.node, "type") ?? "text").toLowerCase();
  if (/^(hidden|button|submit|reset|image)$/.test(type)) return undefined;
  if (attr(el.node, "pattern") !== undefined || attr(el.node, "minlength") !== undefined || /^(email|url|number|date|time|month|week|datetime-local|range|color|file)$/.test(type)) return undefined;
  if (attr(el.node, "required") === undefined) return true;
  if (el.tag === "select") return undefined;
  if (/^(checkbox|radio)$/.test(type)) return attr(el.node, "checked") !== undefined ? true : type === "checkbox" ? false : undefined;
  return el.tag === "textarea" ? el.ownText : !!attr(el.node, "value");
}

const TEXT_INPUT = /^(text|search|url|tel|email|password|number|date|month|week|time|datetime-local)$/;

function nthMatches(arg: string, pos: number): boolean | undefined {
  const a = arg.replace(/\s+/g, "").toLowerCase();
  if (a === "odd") return pos % 2 === 1;
  if (a === "even") return pos % 2 === 0;
  if (/^[+-]?\d+$/.test(a)) return pos === parseInt(a);
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(a);
  if (!m) return undefined;
  const k = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : parseInt(m[1]);
  const b = m[2] ? parseInt(m[2]) : 0;
  return k === 0 ? pos === b : (pos - b) / k >= 0 && (pos - b) % k === 0;
}

const siblingsOf = (el: El): El[] => (el.parent ? el.parent.children : [el]);

/** The pseudo-class that stands for :has()'s anchor element in its relative selectors. */
const ANCHOR = "-cadesa-has-anchor";
const anchors: El[] = [];

/**
 * :has(): the page is static, so it is decided against the DOM. Its descendants (or following
 * siblings and theirs) are tried against each relative selector, anchored at the element. An svg's
 * content isn't read, so a selector that might match inside one stays undecided.
 */
function hasMatches(rel: { comb: " " | ">" | "+" | "~"; complex: Complex }[], el: El): M {
  const below = (x: El): El[] => x.children.flatMap((k) => [k, ...below(k)]);
  const sibs = siblingsOf(el);
  const after = sibs.slice(sibs.indexOf(el) + 1);
  anchors.push(el);
  try {
    const out: M[] = [];
    for (const r of rel) {
      const cands = r.comb === " " || r.comb === ">" ? below(el) : (r.comb === "+" ? after.slice(0, 1) : after).flatMap((k) => [k, ...below(k)]);
      const m = best(cands.map((c) => matchComplex(r.complex, c)));
      out.push(m === "no" && cands.some((c) => c.tag === "svg" && mayMatchInside(r.complex, c)) ? "unknown" : m);
    }
    return best(out);
  } finally {
    anchors.pop();
  }
}

/**
 * Could the subject of `complex` be an element inside this svg (whose content isn't laid out)?
 * Only if every id, class and attribute it requires occurs somewhere inside: a necessary
 * condition, so "no" is certain. `[data-app-shell]` can't match inside icons that lack it.
 */
function mayMatchInside(complex: Complex, svg: El): boolean {
  const ids = new Set<string>();
  const classes = new Set<string>();
  const attrs = new Set<string>();
  const tags = new Set<string>();
  const visit = (n: { tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: unknown[] }) => {
    for (const k of (n.childNodes ?? []) as (typeof n)[]) {
      if (!k.tagName) continue;
      tags.add(k.tagName.toLowerCase());
      for (const a of k.attrs ?? []) {
        attrs.add(a.name.toLowerCase());
        if (a.name === "id") ids.add(a.value);
        if (a.name === "class") a.value.split(/\s+/).forEach((c) => classes.add(c));
      }
      visit(k);
    }
  };
  visit(svg.node as never);
  return complex.parts[0].simples.every((x) =>
    x.kind === "id" ? ids.has(x.name) : x.kind === "class" ? classes.has(x.name) : x.kind === "attr" ? attrs.has(x.name.toLowerCase()) : x.kind === "tag" ? x.name === "*" || tags.has(x.name.toLowerCase()) : true,
  );
}

function simpleMatches(s: Simple, el: El): M {
  switch (s.kind) {
    case "tag":
      return s.name === "*" || s.name === el.tag ? "yes" : "no";
    case "id":
      return attr(el.node, "id") === s.name ? "yes" : "no";
    case "class":
      return el.classes.includes(s.name) ? "yes" : "no";
    case "attr": {
      const v = attr(el.node, s.name);
      if (v === undefined) return "no";
      if (!s.op) return "yes";
      const w = s.value ?? "";
      const ok =
        s.op === "=" ? v === w : s.op === "~=" ? v.split(/\s+/).includes(w) : s.op === "|=" ? v === w || v.startsWith(`${w}-`) : s.op === "^=" ? !!w && v.startsWith(w) : s.op === "$=" ? !!w && v.endsWith(w) : !!w && v.includes(w);
      return ok ? "yes" : "no";
    }
    case "pseudo-element":
      return "yes"; // decided by the caller
    case "pseudo": {
      const n = s.name;
      if (n === ANCHOR) return el === anchors.at(-1) ? "yes" : "no";
      if (s.relative) return hasMatches(s.relative, el);
      if (s.list) {
        const r = best([...s.list.map((c) => matchComplex(c, el)), ...(s.unread ? (["unknown"] as M[]) : [])]);
        // :not(): in the default state, an interactive-state selector doesn't hold.
        if (n === "not") return r === "yes" ? "no" : r === "unknown" ? "unknown" : "yes";
        return r;
      }
      if (STATE.test(n)) return "state";
      const sibs = siblingsOf(el);
      const i = sibs.indexOf(el);
      const same = sibs.filter((x) => x.tag === el.tag);
      const j = same.indexOf(el);
      const nth = (pos: number) => {
        const r = nthMatches(s.arg ?? "", pos);
        return r === undefined ? "unknown" : r ? "yes" : "no";
      };
      switch (n) {
        case "root":
          return el.tag === "html" ? "yes" : "no";
        case "first-child":
          return i === 0 ? "yes" : "no";
        case "last-child":
          return i === sibs.length - 1 ? "yes" : "no";
        case "only-child":
          return sibs.length === 1 ? "yes" : "no";
        case "first-of-type":
          return j === 0 ? "yes" : "no";
        case "last-of-type":
          return j === same.length - 1 ? "yes" : "no";
        case "only-of-type":
          return same.length === 1 ? "yes" : "no";
        case "nth-child":
        case "nth-last-child": {
          // An+B of S: counted among the siblings that match S.
          const of = /^(.*?)\s+of\s+(.+)$/s.exec(s.arg ?? "");
          if (!of) return nth(n === "nth-child" ? i + 1 : sibs.length - i);
          const list = splitList(of[2]).map(parseSelector);
          if (list.some((x) => !x)) return "unknown";
          const ms = sibs.map((x) => best(list.map((c) => matchComplex(c!, x))));
          if (ms.some((m) => m === "unknown")) return "unknown";
          const among = sibs.filter((_, k) => ms[k] === "yes");
          const at = among.indexOf(el);
          if (at < 0) return "no";
          const r = nthMatches(of[1], n === "nth-child" ? at + 1 : among.length - at);
          return r === undefined ? "unknown" : r ? "yes" : "no";
        }
        case "nth-of-type":
          return nth(j + 1);
        case "nth-last-of-type":
          return nth(same.length - j);
        case "empty":
          return !el.children.length && !el.ownText ? "yes" : "no";
        case "link":
        case "any-link":
          return /^(a|area)$/.test(el.tag) && attr(el.node, "href") !== undefined ? "yes" : "no";
        case "visited":
          return "no";
        case "disabled":
          return /^(button|input|select|textarea|fieldset|optgroup|option)$/.test(el.tag) && attr(el.node, "disabled") !== undefined ? "yes" : "no";
        case "enabled":
          return /^(button|input|select|textarea|fieldset|optgroup|option)$/.test(el.tag) && attr(el.node, "disabled") === undefined ? "yes" : "no";
        case "checked":
          return attr(el.node, "checked") !== undefined || attr(el.node, "selected") !== undefined ? "yes" : "no";
        case "required":
          return attr(el.node, "required") !== undefined ? "yes" : "no";
        case "optional":
          return /^(input|select|textarea)$/.test(el.tag) && attr(el.node, "required") === undefined ? "yes" : "no";
        case "defined":
          return "yes";
        // Decided from the markup: the page is static.
        case "scope":
          return el.tag === "html" ? "yes" : "no";
        case "-webkit-any-link":
          return /^(a|area)$/.test(el.tag) && attr(el.node, "href") !== undefined ? "yes" : "no";
        case "lang": {
          const want = (s.arg ?? "").split(",").map((x) => x.trim().replace(/^["']|["']$/g, "").toLowerCase());
          const l = langOf(el);
          return l !== undefined && want.some((w) => w === "*" || l === w || l.startsWith(`${w}-`)) ? "yes" : "no";
        }
        case "dir":
          return dirOf(el) === (s.arg ?? "").trim().toLowerCase() ? "yes" : "no";
        case "open":
          return /^(details|dialog)$/.test(el.tag) && attr(el.node, "open") !== undefined ? "yes" : "no";
        case "placeholder-shown":
          return (el.tag === "textarea" ? !el.ownText : el.tag === "input" && TEXT_INPUT.test((attr(el.node, "type") ?? "text").toLowerCase()) && !attr(el.node, "value")) && attr(el.node, "placeholder") !== undefined ? "yes" : "no";
        case "read-only":
        case "read-write": {
          const type = (attr(el.node, "type") ?? "text").toLowerCase();
          const editable =
            (el.tag === "textarea" || (el.tag === "input" && TEXT_INPUT.test(type))) && attr(el.node, "readonly") === undefined && attr(el.node, "disabled") === undefined
              ? true
              : attr(el.node, "contenteditable") !== undefined && attr(el.node, "contenteditable") !== "false";
          return editable === (n === "read-write") ? "yes" : "no";
        }
        case "indeterminate":
          return el.tag === "progress" && attr(el.node, "value") === undefined ? "yes" : "no";
        case "host":
        case "host-context":
          // No shadow roots in a static page.
          return "no";
        case "blank":
          return !el.children.length && !el.ownText ? "yes" : "no";
        case "valid":
        case "invalid": {
          const v = validity(el);
          return v === undefined ? "unknown" : v === (n === "valid") ? "yes" : "no";
        }
        case "in-range":
        case "out-of-range": {
          if (el.tag !== "input" || !/^(number|range)$/.test((attr(el.node, "type") ?? "").toLowerCase())) return "no";
          const [v, lo, hi] = ["value", "min", "max"].map((a) => parseFloat(attr(el.node, a) ?? ""));
          if (isNaN(lo) && isNaN(hi)) return "no";
          const inside = isNaN(v) || ((isNaN(lo) || v >= lo) && (isNaN(hi) || v <= hi));
          return inside === (n === "in-range") ? "yes" : "no";
        }
        default:
          // A vendor-prefixed pseudo-class Chromium doesn't know makes the selector invalid: it matches nothing.
          return /^-(moz|ms|o)-/.test(n) ? "no" : "unknown";
      }
    }
  }
}

function compoundMatches(c: Compound, el: El): M {
  return all(c.simples.map((s) => simpleMatches(s, el)));
}

/** Does the complex selector match `el` (in the default, non-interactive state)? */
export function matchComplex(c: Complex, el: El, k = 0): M {
  const here = compoundMatches(c.parts[k], el);
  if (here === "no" || k === c.parts.length - 1) return here;
  const comb = c.combs[k];
  const next: M[] = [];
  if (comb === ">") {
    if (el.parent) next.push(matchComplex(c, el.parent, k + 1));
  } else if (comb === " ") {
    for (let a = el.parent; a; a = a.parent) {
      const r = matchComplex(c, a, k + 1);
      next.push(r);
      if (r === "yes") break;
    }
  } else {
    const sibs = siblingsOf(el);
    const i = sibs.indexOf(el);
    if (comb === "+") {
      if (i > 0) next.push(matchComplex(c, sibs[i - 1], k + 1));
    } else for (const x of sibs.slice(0, i)) next.push(matchComplex(c, x, k + 1));
  }
  return all([here, best(next)]);
}

// ---------------------------------------------------------------- the stylesheet

type Origin3 = "ua" | "author" | "inline";

interface CssRuleIn {
  selector: string;
  complex?: Complex;
  spec: [number, number, number];
  decls: { prop: string; value: string; important: boolean }[];
  media: MediaInfo[];
  order: number;
  line: number;
  file: string;
  origin: Origin3;
}

interface Sheet {
  rules: CssRuleIn[];
  /** At-rules and nested rules that were not read. */
  skipped: { file: string; line: number; text: string; reason: string }[];
  /** @font-face rules: the family and style of each face. */
  faces: { family: string; style: string }[];
  /** @keyframes rules, in order: each keyframe's offsets (0 to 1) and declarations. */
  keyframes: { name: string; blocks: { at: number[]; decls: [string, string][] }[] }[];
}

function readSheet(file: string, text: string, origin: Origin3, start: number, lineOffset = 0): Sheet {
  const rules: CssRuleIn[] = [];
  const skipped: Sheet["skipped"] = [];
  const faces: Sheet["faces"] = [];
  const keyframes: Sheet["keyframes"] = [];
  let order = start;
  const root = postcss.parse(text, { from: file });
  const declsOf = (r: Container) => {
    const out: CssRuleIn["decls"] = [];
    r.each((n) => {
      if (n.type === "decl") out.push({ prop: n.prop.startsWith("--") ? n.prop : n.prop.toLowerCase(), value: cssValue(n.value), important: n.important });
      else if (n.type === "rule") skipped.push({ file, line: (n.source?.start?.line ?? 0) + lineOffset, text: n.selector, reason: "nested rules are not supported" });
    });
    return out;
  };
  const visit = (n: ChildNode, media: MediaInfo[]) => {
    if (n.type === "rule") {
      const r = n as Rule;
      const decls = declsOf(r);
      if (!decls.length) return;
      for (const sel of splitList(r.selector)) {
        const complex = parseSelector(sel);
        rules.push({ selector: sel, complex, spec: complex ? specificityOf(complex) : [0, 0, 0], decls, media, order: order++, line: (r.source?.start?.line ?? 0) + lineOffset, file, origin });
      }
    } else if (n.type === "atrule") {
      const a = n as AtRule;
      const name = a.name.toLowerCase();
      const line = (a.source?.start?.line ?? 0) + lineOffset;
      if (name === "media") a.each((c) => visit(c, [...media, parseMediaQuery(a.params)]));
      // @supports: modern features hold in Chromium. @layer: read in source order (layer order is not modelled).
      else if (name === "supports" || name === "layer") a.each((c) => visit(c, media));
      else if (name === "font-face") {
        const get = (prop: string) => a.nodes?.find((d): d is import("postcss").Declaration => d.type === "decl" && d.prop.toLowerCase() === prop)?.value.trim();
        const family = get("font-family")?.replace(/^["']|["']$/g, "");
        if (family) faces.push({ family: family.toLowerCase(), style: (get("font-style") ?? "normal").toLowerCase() });
      } else if (/^(-webkit-)?keyframes$/.test(name)) {
        // Each keyframe: its offsets (from, to, percentages) and declarations.
        const blocks: Sheet["keyframes"][number]["blocks"] = [];
        a.each((k) => {
          if (k.type !== "rule") return;
          const at = (k as Rule).selector.split(",").map((x) => x.trim().toLowerCase()).map((x) => (x === "from" ? 0 : x === "to" ? 1 : /^[\d.]+%$/.test(x) ? parseFloat(x) / 100 : NaN));
          const decls: [string, string][] = [];
          (k as Rule).each((d) => void (d.type === "decl" && decls.push([d.prop.toLowerCase(), cssValue(d.value)])));
          blocks.push({ at, decls });
        });
        keyframes.push({ name: a.params.trim().replace(/^["']|["']$/g, ""), blocks });
      } else if (name === "import") skipped.push({ file, line, text: `@import ${a.params}`, reason: "@import is not followed; lift the imported file too" });
      else if (!/^(font-face|keyframes|-webkit-keyframes|charset|namespace|property|page|counter-style|font-feature-values)$/.test(name))
        skipped.push({ file, line, text: `@${a.name} ${a.params}`.trim(), reason: `@${a.name} is not modelled` });
    }
  };
  root.each((n) => visit(n, []));
  return { rules, skipped, faces, keyframes };
}

/**
 * What a table element's presentational attributes declare (HTML's rendering rules for tables):
 * width and height, valign and align, nowrap, and the table's cellspacing, cellpadding and border.
 */
function presentationalHints(el: El): CssRuleIn["decls"] {
  const out: CssRuleIn["decls"] = [];
  const d = (prop: string, value: string) => out.push({ prop, value, important: false });
  const a = (name: string) => attr(el.node, name)?.trim();
  const dim = (v: string | undefined, zeroOk = false) => {
    const m = v === undefined ? null : /^(\d+(?:\.\d+)?)(%?)/.exec(v);
    if (!m || (!zeroOk && parseFloat(m[1]) === 0)) return undefined;
    return `${parseFloat(m[1])}${m[2] || "px"}`;
  };
  const tag = el.tag;
  const table = (() => {
    for (let x = el.parent; x; x = x.parent) if (x.tag === "table") return x;
    return undefined;
  })();
  if (/^(table|td|th|col|colgroup)$/.test(tag)) {
    const w = dim(a("width"));
    if (w) d("width", w);
  }
  if (/^(table|td|th|tr)$/.test(tag)) {
    const h = dim(a("height"));
    if (h) d("height", h);
  }
  if (/^(td|th|tr|thead|tbody|tfoot|col|colgroup)$/.test(tag)) {
    const v = a("valign")?.toLowerCase();
    if (v && /^(top|middle|bottom|baseline)$/.test(v)) d("vertical-align", v);
    const h = a("align")?.toLowerCase();
    if (h && /^(left|center|right|justify)$/.test(h)) d("text-align", h);
  }
  if ((tag === "td" || tag === "th") && a("nowrap") !== undefined) d("white-space", "nowrap");
  if (tag === "table") {
    const sp = dim(a("cellspacing"), true);
    if (sp && !sp.endsWith("%")) d("border-spacing", sp);
    const b = a("border");
    if (b !== undefined) {
      const n = /^\d+/.test(b) ? parseInt(b, 10) : 1;
      if (n > 0) for (const s of ["top", "right", "bottom", "left"]) (d(`border-${s}-width`, `${n}px`), d(`border-${s}-style`, "outset"));
    }
  }
  if ((tag === "td" || tag === "th") && table) {
    const pad = dim(attr(table.node, "cellpadding")?.trim(), true);
    if (pad && !pad.endsWith("%")) for (const s of ["top", "right", "bottom", "left"]) d(`padding-${s}`, pad);
    const b = attr(table.node, "border")?.trim();
    if (b !== undefined && (/^\d+/.test(b) ? parseInt(b, 10) : 1) > 0) for (const s of ["top", "right", "bottom", "left"]) (d(`border-${s}-width`, "1px"), d(`border-${s}-style`, "inset"));
  }
  return out;
}

// ---------------------------------------------------------------- the lifter

const sanitize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "n$1");

/** One stylesheet given to the lift (several: comma-separated --css, in cascade order). */
export interface SheetFile {
  file: string;
  text: string;
}

export function liftCssPage(page: string, html: string, cssFile: string | SheetFile[], cssText?: string, opts: { height?: number } = {}): PageLift {
  const sheets = typeof cssFile === "string" ? [{ file: cssFile, text: cssText ?? "" }] : cssFile;
  const l = new CssLifter(page, html, sheets);
  if (opts.height) l.viewportHeight = opts.height;
  return l.run();
}

class CssLifter extends PageLifter {
  readonly label: string;
  rules: CssRuleIn[] = [];
  skipped: Sheet["skipped"] = [];
  faces: Sheet["faces"] = [];
  /** @keyframes by name (the last rule of a name wins). */
  keyframes = new Map<string, Sheet["keyframes"][number]["blocks"]>();

  constructor(page: string, html: string, files: SheetFile[]) {
    super(page, html, files.map((f) => f.file).join(","));
    this.label = `CSS, ${files.map((f) => f.file).join(", ")}`;
    this.blockFlow = "flow";
    this.uaInCascade = true;
    this.preflight = false;
    // Cascade order: the browser's defaults, then the page's stylesheets in document order (each
    // given file where the page links it; given files the page doesn't link come first, in the
    // order given), then style="" attributes.
    const ua = readSheet("browser default", UA_CSS, "ua", 0);
    const styleBlocks = [...html.matchAll(/<(link)\b([^>]*)>|<(style)\b[^>]*>([\s\S]*?)<\/style>/gi)];
    const baseOf = (f: string) => f.replace(/[?#].*$/, "").replace(/^.*[\\/]/, "");
    const hrefOf = (attrs: string) => {
      const m = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
      return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
    };
    const links = styleBlocks
      .filter((m) => m[1] && /(?:^|\s)rel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(m[2]) && !/\balternate\b/i.test(/rel\s*=\s*["']?([^"'>]*)/i.exec(m[2])?.[1] ?? ""))
      .map((m) => ({ m, href: hrefOf(m[2]) }));
    const byLink = new Map<RegExpMatchArray, SheetFile>();
    for (const l of links) {
      const given = files.find((f) => baseOf(f.file) === baseOf(l.href) && ![...byLink.values()].includes(f));
      if (given) byLink.set(l.m, given);
    }
    // Given files the page doesn't link, and links no given file matches: when there are as many
    // of each, they're the same stylesheets saved under other names (an edited copy), in order.
    const looseFiles = files.filter((f) => ![...byLink.values()].includes(f));
    const looseLinks = links.filter((l) => !byLink.has(l.m) && l.href);
    if (looseFiles.length && looseFiles.length === looseLinks.length)
      looseLinks.forEach((l, i) => {
        byLink.set(l.m, looseFiles[i]);
        this.readerNotes.push(`used ${looseFiles[i].file} where the page links ${l.href} (no --css file has that name; given in the same order)`);
      });
    const placed = new Set<SheetFile>();
    /** In cascade order: a given file, or a <style> block (its text and line offset). */
    const sources: ({ sheet: SheetFile } | { style: string; line: number })[] = [];
    for (const m of styleBlocks) {
      if (m[1]) {
        const link = links.find((l) => l.m === m);
        if (!link) continue;
        const given = byLink.get(m);
        if (given && !placed.has(given)) {
          placed.add(given);
          sources.push({ sheet: given });
        } else if (!given) {
          const names = files.map((f) => baseOf(f.file)).join(", ");
          this.skipped.push({
            file: page,
            line: lineAt(html, m.index!),
            text: `<link href="${link.href || "(empty)"}">`,
            reason: `${link.href ? "this stylesheet" : "a stylesheet with an empty href"} isn't among the --css files, so its rules are unknown and every box may differ (given: ${names}). Pass every stylesheet the page links, in order`,
          });
        }
      } else sources.push({ style: m[4] ?? "", line: lineAt(html, m.index!) - 1 });
    }
    sources.unshift(...files.filter((f) => !placed.has(f)).map((sheet) => ({ sheet })));
    let order = 1000;
    for (const src of [ua, ...sources]) {
      const s = "rules" in src ? src : "sheet" in src ? readSheet(src.sheet.file, src.sheet.text, "author", order) : readSheet(`${page} <style>`, src.style, "author", order, src.line);
      if (!("rules" in src)) order += s.rules.length + 1;
      this.rules.push(...s.rules);
      this.skipped.push(...s.skipped);
      this.faces.push(...s.faces);
      for (const k of s.keyframes) this.keyframes.set(k.name, k.blocks);
    }
    // Token names come from the custom properties declared on :root / html.
    for (const r of this.rules)
      if (r.origin === "author" && !r.media.length && /^(:root|html)$/.test(r.selector.trim()))
        for (const d of r.decls) if (d.prop.startsWith("--")) this.theme.set(d.prop, d.value);
  }

  private dateParts?: boolean;
  styledDateParts(): boolean {
    return (this.dateParts ??= this.rules.some((r) => r.origin === "author" && /::-webkit-(datetime-edit|date-and-time-value|calendar-picker-indicator)/i.test(r.selector)));
  }

  keyframesAt(name: string, offset: number): Map<string, string> | undefined {
    const blocks = this.keyframes.get(name);
    if (!blocks) return undefined;
    // Every keyframe at that offset, later declarations winning (an offset without one takes the box's own values).
    const out = new Map<string, string>();
    for (const b of blocks) if (b.at.includes(offset)) for (const [p, v] of b.decls) for (const [lp, lv] of longhands(p, v)) out.set(lp, lv);
    return out;
  }

  italicFace(family: string): boolean | undefined {
    const f = family.toLowerCase();
    const faces = this.faces.filter((x) => x.family === f);
    if (faces.length) return faces.some((x) => /^(italic|oblique)/.test(x.style));
    // A Google Fonts stylesheet serves italic faces only when its URL asks for them (ital).
    const google = [...this.html.matchAll(/<link\b[^>]*href\s*=\s*["']([^"']*fonts\.googleapis\.com[^"']*)["']/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
    const asks = google.filter((u) => decodeURIComponent(u.replace(/\+/g, " ")).toLowerCase().includes(f));
    if (asks.length) return asks.some((u) => /ital|italic|[0-9]i\b/i.test(u));
    return undefined;
  }

  webFont(family: string): boolean {
    const f = family.toLowerCase();
    if (this.faces.some((x) => x.family === f)) return true;
    const google = [...this.html.matchAll(/<link\b[^>]*href\s*=\s*["']([^"']*fonts\.googleapis\.com[^"']*)["']/gi)].map((m) => decodeURIComponent(m[1].replace(/&amp;/g, "&").replace(/\+/g, " ")).toLowerCase());
    return google.some((u) => u.includes(`family=${f}`));
  }

  declarationCount() {
    // Each declaration once, however many selectors share it.
    return new Set(this.rules.filter((r) => r.origin === "author").flatMap((r) => r.decls.filter((d) => !d.prop.startsWith("--")).map((d) => `${r.file}:${r.line}:${d.prop}:${d.value}`))).size;
  }

  nameOf(el: El, root: boolean): string | undefined {
    const cls = el.classes.find((c) => !c.startsWith("ca-") && /^[a-zA-Z]/.test(c));
    if (!cls) return undefined;
    if (root) return cls.split("__")[0];
    const parts = cls.split("__");
    return parts.length > 1 ? parts.slice(1).join("-") : cls;
  }

  extraUnlifted() {
    // At-rules, nested rules and other stylesheets apply to the page as a whole: every root.
    return this.roots
      .filter((r) => r.className)
      .flatMap((r) =>
        this.skipped.map((s) => ({ file: s.file, line: s.line, selector: `.${r.className}`, decl: s.text, reason: s.reason, kind: (/^@(font-face|keyframes)/.test(s.text) ? "none" : "geometry") as ImpactKind, className: r.className })),
      );
  }

  // ---- width ranges

  computeStates() {
    const cuts = new Set<number>();
    for (const r of this.rules) for (const m of r.media) for (const w of m.widths) cuts.add(w.px);
    const cs = [...cuts].filter((c) => c > 0).sort((a, b) => a - b);
    const bounds = [0, ...cs, Infinity];
    const out: State[] = [];
    for (let i = bounds.length - 2; i >= 0; i--) {
      const lo = bounds[i];
      const hi = bounds[i + 1];
      if (hi === Infinity) out.push({ lo, hi, key: Infinity });
      else {
        // The widest width below the cut: max-width: 480px holds up to 480px (its cut is 480.01).
        const key = round(hi - 0.01, 2);
        const raw = `${key}px`;
        out.push({ lo, hi, key, raw, name: `max-${raw.replace(/\./g, "-")}` });
      }
    }
    this.states = out;
  }

  /** The root of inheritance: Chromium's defaults (16px Times New Roman, line-height normal, black). */
  computeRootText() {
    this.rootText = {
      size: 16,
      lineHeight: "normal",
      family: { value: '"Times New Roman"' },
      weight: 400,
      color: { hex: "#000000" },
      letterSpacing: 0,
      inherited: new Map(),
    };
  }

  /** Every rule that matches, ordered by the cascade, per width range. */
  evaluate(el: El) {
    const matched: { rule: CssRuleIn; m: M; pseudoElement?: string }[] = [];
    for (const rule of this.rules) {
      if (!rule.complex) {
        // Unparsed: assume it may apply when it mentions one of the element's classes or its tag.
        const mentions = el.classes.some((c) => new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(rule.selector)) || new RegExp(`(^|[\\s>+~(,])${el.tag}(?![\\w-])`).test(rule.selector);
        if (mentions && rule.origin !== "ua") matched.push({ rule, m: "unknown" });
        continue;
      }
      const pe = rule.complex.parts[0].simples.find((s) => s.kind === "pseudo-element")?.name;
      const m = matchComplex(rule.complex, el);
      if (m !== "no") matched.push({ rule, m, pseudoElement: pe });
    }
    // style="" attribute: the highest author origin.
    const inline = attr(el.node, "style");
    if (inline) {
      try {
        const s = readSheet(`${this.page} style=""`, `x{${inline}}`, "inline", 1e9, el.line - 1);
        for (const r of s.rules) matched.push({ rule: { ...r, selector: `style="${inline.slice(0, 40)}"` }, m: "yes" });
      } catch {
        /* unparsable inline style: ignored by the browser too */
      }
    }
    // Presentational attributes (<td width="120" valign="top">, <table cellpadding="4">): author
    // declarations of no specificity, before every stylesheet's.
    const hints = presentationalHints(el);
    if (hints.length) matched.push({ rule: { selector: `presentational attributes of <${el.tag}>`, spec: [0, 0, 0], decls: hints, media: [], order: -1, line: el.line, file: this.page, origin: "author" }, m: "yes" });
    const tier = (r: CssRuleIn, important: boolean) => (r.origin === "ua" ? 0 : r.order === -1 ? 0.5 : important ? (r.origin === "inline" ? 4 : 3) : r.origin === "inline" ? 2 : 1);
    this.states.forEach((st, si) => {
      const own = new Map<string, Origin>();
      el.own[si] = own;
      el.space[si] = undefined;
      const apply: { rule: CssRuleIn; d: CssRuleIn["decls"][number]; t: number }[] = [];
      /** ::before and ::after: their own cascades. */
      const generated: Record<"before" | "after", typeof apply> = { before: [], after: [] };
      for (const { rule, m, pseudoElement } of matched) {
        const props = rule.decls.filter((d) => !d.prop.startsWith("--"));
        const k: ImpactKind = props.length ? worst(props.map((d) => kindOf(d.prop))) : "none";
        const declText = `${rule.selector} { ${rule.decls.map((d) => `${d.prop}: ${d.value}`).join("; ")} }`.slice(0, 160);
        const where = `${rule.file}:${rule.line}`;
        let skip = false;
        for (const q of rule.media) {
          if (!q.widths.every((c) => (c.op === "ge" ? st.lo >= c.px : st.lo < c.px)) || !heightsHold(q, this.viewportHeight)) skip = true;
          else if (q.dark || q.env === false) skip = true;
          else if (q.env !== true) {
            this.note(el, si, { decl: `${where} ${declText}`, reason: `${q.env.unknown} is not modelled`, kind: k });
            skip = true;
          }
        }
        if (skip) continue;
        if (pseudoElement) {
          if (pseudoElement === "before" || pseudoElement === "after") {
            // In an interactive state it doesn't apply by default; a selector that may match can't be decided.
            if (m === "unknown" && rule.decls.some((d) => d.prop === "content" && !/^(none|normal)$/.test(d.value.trim())))
              this.note(el, si, { decl: `${where} ${declText}`, reason: `::${pseudoElement} content under a selector Cadesa can't decide is not modelled`, kind: "geometry" });
            else if (m === "yes") for (const d of rule.decls) generated[pseudoElement].push({ rule, d, t: tier(rule, d.important) });
          } else if (/^(first-line|first-letter)$/.test(pseudoElement)) this.note(el, si, { decl: `${where} ${declText}`, reason: `::${pseudoElement} styles are not modelled`, kind: "text" });
          continue;
        }
        if (m === "state") {
          this.note(el, si, { decl: `${where} ${rule.selector}`, reason: "interactive state; the default state is unaffected", kind: "state" });
          continue;
        }
        if (m === "unknown") {
          this.note(el, si, { decl: `${where} ${declText}`, reason: `the selector ${rule.selector} may match; Cadesa can't decide it`, kind: k });
          continue;
        }
        for (const d of rule.decls) apply.push({ rule, d, t: tier(rule, d.important) });
      }
      const cascade = (list: typeof apply, into: Map<string, Origin>) => {
        list.sort((a, b) => a.t - b.t || a.rule.spec[0] - b.rule.spec[0] || a.rule.spec[1] - b.rule.spec[1] || a.rule.spec[2] - b.rule.spec[2] || a.rule.order - b.rule.order);
        for (const { rule, d } of list) {
          const label = rule.origin === "ua" ? `browser default (${rule.selector})` : rule.origin === "inline" ? rule.selector : `${rule.selector} (${rule.file}:${rule.line})`;
          // Sorted by the cascade, so a later declaration always wins (important ones come last).
          this.apply(into, { ...d, important: false }, label);
        }
      };
      cascade(apply, own);
      (el.pseudoOwn ??= [])[si] = {};
      for (const pe of ["before", "after"] as const)
        if (generated[pe].some(({ d }) => d.prop === "content")) cascade(generated[pe], (el.pseudoOwn[si][pe] = new Map()));
    });
  }
}

function lineAt(text: string, offset: number) {
  let n = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
