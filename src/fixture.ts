import { readFileSync } from "node:fs";
import { parse } from "parse5";

export interface FixtureNode {
  tag: string;
  classes: string[];
  attrs: Record<string, string>;
  fixtureId?: string;
  line?: number;
  /** Collapsed text of this element's own text nodes and descendants. */
  text: string;
  /** Collapsed text of this element's own text nodes only (not its descendants'). */
  ownText: string;
  /**
   * The text split into runs that each start on a new line: block-level descendants (<p>, <li>,
   * <div>...) and <br> separate runs. Most elements have one run.
   */
  runs: string[];
  /**
   * Per run: whether it sits in a block-level descendant (its own block container) rather than
   * directly in this element, and whether any of it is inside an underlined inline element
   * (<a href>, <u>, <ins>, <s>, <del>, <strike>). `items`: where inline elements start or end in
   * the run (character offsets): Chromium measures each such piece of text separately when fitting lines.
   */
  runMeta: RunMeta[];
  children: FixtureNode[];
  /**
   * A form control's intrinsic content width (px), as Chromium sizes it: a select's widest option,
   * a text field's characters, a textarea's columns, a button input's label. Set by the lift.
   */
  controlWidth?: number;
  /** A form control's baseline from its border box's top (px), where it isn't its bottom: a text field's, select's or button input's line. */
  controlBaseline?: number;
  /**
   * Not an element: a run of text between block-level children (an anonymous block, or an
   * anonymous flex or grid item), laid out as a text box of its own. It has no box in the DOM.
   */
  anonymous?: boolean;
}

/** How a run of text is laid out, beyond its characters. */
export interface RunMeta {
  inBlock: boolean;
  underlined: boolean;
  items: number[];
  /**
   * Inline boxes of the run with something of their own (character offsets `from`-`to`, at item
   * edges): text measured at another weight, and the margin, border and padding at their start
   * (`open`) and end (`close`), in px.
   */
  spans?: Span[];
  /**
   * A float at the start of the run (a ::before with float: left): its text, at its weight, and its
   * margin, border and padding (px). The first line fits beside it.
   */
  lead?: { text: string; weight?: number; extra: number };
  /**
   * Floats among the run's text (element children of the text box that float): where each occurs
   * (a character offset) and which one it is (its index among the text box's floats, in order).
   */
  floats?: { at: number; index: number; edge?: boolean }[];
}

export interface Span extends RunStyle {
  from: number;
  to: number;
  /** The box opens before `from`, right after a kept space (its own leading space collapsed away): it is on the line that space ends too. */
  lead?: boolean;
  open?: number;
  close?: number;
  /** An atomic inline whose width follows the font size (em): its width at a font size, instead of `open`. */
  openAt?: (sizePx: number) => number;
}

/**
 * How an inline box's text differs from the text box's, and where the box sits on its lines. Each
 * field is set only where it differs from the box around it (the innermost one that sets it wins).
 */
export interface RunStyle {
  weight?: number;
  /** Text in another font: its font-family value (measured with that family's metrics). */
  font?: string;
  /** Text at another font size (px). */
  size?: number;
  /** Text in (or out of) the font's italic face: measured with its italic (or upright) table. */
  italic?: boolean;
  /**
   * The inline box (or an atomic inline's margin box) on each line it is on: how far it reaches
   * above and below the line's baseline in px, after its vertical-align. A line box is the union of
   * these and the text box's own strut.
   */
  above?: number;
  below?: number;
  /**
   * vertical-align: top or bottom: the box (`above` + `below` tall) is placed against the line box's
   * top or bottom once the rest of the line is, growing the line box below or above if it is taller.
   */
  align?: "top" | "bottom";
  /**
   * vertical-align: middle, text-top or text-bottom on an inline box whose content reaches past its
   * strut and is split across lines: it is placed by its extent on each line it is on (its strut
   * `sa` / `sd` and what of it is on that line), around its parent's baseline, `base` px below the
   * line's (in its parent: x-height / 2 `xh2`, ascent and descent). Instead of `above` / `below`.
   */
  byExtent?: { mode: "middle" | "text-top" | "text-bottom"; sa: number; sd: number; base: number; xh2: number; ascent: number; descent: number };
  /** Inside such a box: `above` and `below` are from its baseline, not the line's. */
  rel?: boolean;
  /** An atomic inline holding text: the fonts its text is set in, and that text (for `cadesa fonts`). */
  inner?: { font: string; weight: number; italic: boolean; text: string }[];
  /** Text in a font of its own that isn't measured (the box is ≈): which font, for `cadesa fonts` only. */
  face?: { font: string; weight: number; italic: boolean };
}

/** Whether a run style changes anything. */
export const styled = (s: RunStyle | undefined) => !!s && (s.weight !== undefined || s.font !== undefined || s.size !== undefined || s.italic !== undefined || s.above !== undefined || s.below !== undefined || s.byExtent !== undefined);

/** What an inline element adds to the text it is part of (see textAndRuns). */
export interface InlineInfo extends RunStyle {
  open?: number;
  close?: number;
  /** Generated content at its start and end (::before, ::after), laid out as inline boxes. */
  before?: Generated;
  /**
   * An atomic inline (an inline-block, an icon <svg>) of this margin-box width (or its width at a
   * font size): one unbreakable object on the line, reaching `above` and `below` the baseline.
   */
  atomic?: number | ((sizePx: number) => number);
  after?: Generated;
  /** A float among the text: a box of its own (see RunMeta.floats); its text isn't the text box's. */
  float?: boolean;
}

export interface Generated extends RunStyle {
  text: string;
  open?: number;
  close?: number;
  /** An inline-block of one line of text (an icon glyph in its font): one object on the line, this wide (margin box). */
  atomic?: number;
  /** Floated to the start of the first line instead: a box as wide as its text plus `open` and `close`. */
  float?: boolean;
}

export interface Fixture {
  file: string;
  stylesheets: string[];
  body: FixtureNode[];
}

export interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
  content?: P5Node;
  sourceCodeLocation?: { startLine: number };
}

const attr = (n: P5Node, name: string) => n.attrs?.find((a) => a.name === name)?.value;

// CSS white-space: normal collapses only ASCII whitespace. No-break spaces (U+00A0, U+202F) are
// text: they must survive collapsing, and lines never break at them.
const collapse = (s: string) => s.replace(/[ \t\n\r\f]+/g, " ").trim();

const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol",
  "p", "pre", "section", "summary", "table", "tr", "ul",
]);

function textOf(n: P5Node, skip?: (n: P5Node) => boolean, inline?: (n: P5Node) => InlineInfo | undefined): string {
  if (n.nodeName === "#text") return n.value ?? "";
  const info = inline?.(n);
  if (info?.float) return "";
  if (info?.atomic !== undefined) return "\uFFFC";
  const inner = (n.childNodes ?? []).filter((c) => !skip?.(c)).map((c) => textOf(c, skip, inline)).join("");
  const gen = (g?: Generated) => (!g || g.float ? "" : g.atomic !== undefined ? "\uFFFC" : g.text);
  return `${gen(info?.before)}${inner}${gen(info?.after)}`;
}

const UNDERLINED = new Set(["u", "ins", "s", "del", "strike"]);

/** Marks an inline element's start or end in raw run text. */
const EDGE = "\u0001";

/** Marks span `i` opening (OPEN i END) or closing (CLOSE i END), next to an EDGE. Control characters never occur in collapsed text. */
const OPEN = "\u0002";
const CLOSE = "\u0004";
const END = "\u0003";
/** Marks float `i` among the text (FLOAT i END): an item edge, no text. */
const FLOAT = "\u0005";

/** collapse(), also returning where the EDGE marks fall (in characters of the collapsed text). */
function collapseItems(raw: string): { text: string; items: number[]; marks: { id: number; open: boolean; at: number; lead?: boolean }[]; floats: { index: number; at: number; edge?: boolean }[] } {
  let out = "";
  let n = 0;
  let pending = false;
  const items: number[] = [];
  const marks: { id: number; open: boolean; at: number; lead?: boolean }[] = [];
  const floats: { index: number; at: number; edge?: boolean }[] = [];
  /** Inline boxes open where the scan is, and the floats met inside one. */
  const live = new Set<number>();
  const nested = new Set<number>();
  const space = (edge = false) => {
    // A collapsible space after another one (even across an element edge) disappears.
    if (pending && n > 0 && !out.endsWith(" ")) {
      out += " ";
      n++;
    } else if (pending && n > 0 && edge) {
      // Whitespace of its own (a text node of only spaces) right after a box opened behind a kept
      // space, before an element: removed, it is still an item of that box at the end of the line
      // the kept space ends, so LayoutNG keeps the box's start on that line.
      for (const m of marks) if (m.open && m.at === n) m.lead = true;
    }
    pending = false;
  };
  const chars = [...raw];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === FLOAT) {
      // A float: an item edge where it occurs (the spaces around it collapse as if it weren't there).
      const end = chars.indexOf(END, i);
      floats.push({ index: Number(chars.slice(i + 1, end).join("")), at: n + (pending && n > 0 && !out.endsWith(" ") ? 1 : 0) });
      if (live.size) nested.add(floats.length - 1);
      i = end;
      continue;
    }
    if (ch === OPEN || ch === CLOSE) {
      // A space before an inline box's end is its text (the spaces after it collapse into it).
      if (ch === CLOSE) space();
      const end = chars.indexOf(END, i);
      marks.push({ id: Number(chars.slice(i + 1, end).join("")), open: ch === OPEN, at: n });
      if (ch === OPEN) live.add(marks.at(-1)!.id);
      else live.delete(marks.at(-1)!.id);
      i = end;
      continue;
    }
    if (ch === EDGE) {
      // A space before an edge belongs to the text before it.
      space(true);
      if (n > 0 && items.at(-1) !== n) items.push(n);
    } else if (/[ \t\n\r\f]/.test(ch)) pending = true;
    else {
      space();
      out += ch;
      n++;
    }
  }
  const text = out.replace(/ $/, "");
  const len = [...text].length;
  const cuts = [...new Set([...items, ...floats.map((f) => f.at)])].filter((b) => b > 0 && b < len).sort((a, b) => a - b);
  // A float inside an inline box, at one of an inline box's edges: whether that edge comes before
  // it on its line isn't told apart here (flagged, see layoutText).
  const edge = (f: { at: number }, k: number) => nested.has(k) && marks.some((m) => m.at === f.at || m.at === f.at - 1);
  return { text, items: cuts, marks: marks.map((m) => ({ ...m, at: Math.min(m.at, len) })), floats: floats.map((f, k) => ({ ...f, at: Math.min(f.at, len), ...(edge(f, k) && { edge: true }) })) };
}

function runsOf(n: P5Node, skip?: (n: P5Node) => boolean, inline?: (n: P5Node) => InlineInfo | undefined): { runs: string[]; runMeta: FixtureNode["runMeta"] } {
  const runs: string[] = [];
  const runMeta: FixtureNode["runMeta"] = [];
  let cur = "";
  let underlined = false;
  let depth = 0;
  /** Spans with something of their own, by id; `live`: open ones (carried into the next run when a <br> splits them). */
  const spans: (RunStyle & { open?: number; close?: number; openAt?: (sizePx: number) => number })[] = [];
  const style = (sp: RunStyle): RunStyle => ({
    ...(sp.weight !== undefined && { weight: sp.weight }),
    ...(sp.font !== undefined && { font: sp.font }),
    ...(sp.size !== undefined && { size: sp.size }),
    ...(sp.italic !== undefined && { italic: sp.italic }),
    ...(sp.above !== undefined && { above: sp.above }),
    ...(sp.below !== undefined && { below: sp.below }),
    ...(sp.align !== undefined && { align: sp.align }),
    ...(sp.byExtent !== undefined && { byExtent: sp.byExtent }),
    ...(sp.rel && { rel: true }),
    ...(sp.inner && { inner: sp.inner }),
    ...(sp.face && { face: sp.face }),
  });
  const live: number[] = [];
  let lead: RunMeta["lead"];
  /** Spans open when a run starts (split from the run before by a <br>): they start at 0, with no open edge. */
  let carried: number[] = [];
  const flush = () => {
    const { text: t, items, marks, floats: found } = collapseItems(cur);
    const floats = found.map((f) => (edgeFloats.has(f.index) ? { ...f, edge: true } : f));
    if (t) {
      runs.push(t);
      const out: Span[] = [];
      // Which span opened first: an inner span with the same range as its parent comes after it.
      const order = new Map<Span, number>();
      const from = new Map<number, { at: number; opened: boolean; lead?: boolean }>();
      for (const id of carried) from.set(id, { at: 0, opened: false });
      for (const m of marks) {
        if (m.open) from.set(m.id, { at: m.at, opened: true, lead: m.lead });
        else {
          const f = from.get(m.id) ?? { at: 0, opened: false };
          from.delete(m.id);
          const sp = spans[m.id];
          const s: Span = { from: f.at, to: m.at, ...style(sp), ...(f.opened && f.lead && { lead: true }), ...(f.opened && sp.open && { open: sp.open }), ...(f.opened && sp.openAt && { openAt: sp.openAt }), ...(sp.close && { close: sp.close }) };
          out.push(s);
          order.set(s, m.id);
        }
      }
      const len = [...t].length;
      for (const [id, f] of from) {
        const sp = spans[id];
        const s: Span = { from: f.at, to: len, ...style(sp), ...(f.opened && f.lead && { lead: true }), ...(f.opened && sp.open && { open: sp.open }) };
        out.push(s);
        order.set(s, id);
      }
      const useful = out.filter((s) => styled(s) || s.open || s.close || s.face);
      runMeta.push({ inBlock: depth > 0, underlined, items, ...(useful.length && { spans: useful.sort((a, b) => a.from - b.from || b.to - a.to || order.get(a)! - order.get(b)!) }), ...(lead !== undefined && runs.length === 1 && { lead }), ...(floats.length && { floats }) });
    }
    carried = [...live];
    cur = "";
    underlined = false;
  };
  /** Text in an inline box of its own (an element, or generated content). */
  const span = (info: (RunStyle & { open?: number; close?: number; openAt?: (sizePx: number) => number }) | undefined, body: () => void) => {
    if (!info || (!styled(info) && !info.open && !info.close && !info.face)) {
      cur += EDGE;
      body();
      cur += EDGE;
      return;
    }
    const id = spans.push(info) - 1;
    cur += EDGE + OPEN + id + END;
    live.push(id);
    body();
    live.splice(live.indexOf(id), 1);
    carried = carried.filter((x) => x !== id);
    cur += CLOSE + id + END + EDGE;
  };
  const generated = (g: Generated | undefined) => {
    if (!g) return;
    if (g.float) lead = { text: collapse(g.text), ...(g.weight !== undefined && { weight: g.weight }), extra: (g.open ?? 0) + (g.close ?? 0) };
    else if (g.atomic !== undefined) span({ open: g.atomic, ...(g.above !== undefined && { above: g.above, below: g.below }), ...(g.align && { align: g.align }) }, () => (cur += "\uFFFC"));
    else span(g, () => (cur += g.text));
  };
  /** Floats among the text, in order. */
  let floatCount = 0;
  /** Floats inside an inline element with nothing but whitespace before or after them in it. */
  const edgeFloats = new Set<number>();
  const walk = (k: P5Node, u: boolean) => {
    if (skip?.(k)) return;
    if (k.tagName && inline?.(k)?.float) {
      const parent = (k as { parentNode?: P5Node }).parentNode;
      if (parent && parent !== n) {
        const sibs = parent.childNodes ?? [];
        const i = sibs.indexOf(k);
        const blank = (c: P5Node) => c.nodeName === "#text" && !/\S/.test(c.value ?? "");
        if (sibs.slice(0, i).every(blank) || sibs.slice(i + 1).every(blank)) edgeFloats.add(floatCount);
      }
      cur += FLOAT + floatCount++ + END;
      return;
    }
    if (k.nodeName === "#text") {
      cur += k.value ?? "";
      if (u && /\S/.test(k.value ?? "")) underlined = true;
    } else if (k.tagName === "br") flush();
    else if (inline?.(k)?.atomic !== undefined) {
      const info = inline!(k)!;
      const a = info.atomic!;
      const v = { ...(info.above !== undefined && { above: info.above, below: info.below, ...(info.align && { align: info.align }) }), ...(info.inner && { inner: info.inner }) };
      span(typeof a === "number" ? { open: a, ...v } : { open: 1, openAt: a, ...v }, () => (cur += "\uFFFC"));
    }
    else if (k.tagName && BLOCK.has(k.tagName)) {
      flush();
      depth++;
      const info = inline?.(k);
      generated(info?.before);
      (k.childNodes ?? []).forEach((c) => walk(c, u));
      generated(info?.after);
      flush();
      depth--;
    } else {
      const ul = u || UNDERLINED.has(k.tagName ?? "") || (k.tagName === "a" && attr(k, "href") !== undefined);
      const info = inline?.(k);
      span(info, () => {
        generated(info?.before);
        (k.childNodes ?? []).forEach((c) => walk(c, ul));
        generated(info?.after);
      });
    }
  };
  const own = inline?.(n);
  generated(own?.before);
  (n.childNodes ?? []).forEach((c) => walk(c, false));
  generated(own?.after);
  flush();
  return { runs, runMeta };
}

/**
 * Text and runs of a parse5 element, leaving out descendants `skip` rejects (e.g. elements that
 * are never displayed). Same rules as the fixture parser.
 */
export function textAndRuns(n: P5Node, skip?: (n: P5Node) => boolean, inline?: (n: P5Node) => InlineInfo | undefined): { text: string; runs: string[]; runMeta: FixtureNode["runMeta"] } {
  return { text: collapse(textOf(n, skip, inline)), ...runsOf(n, skip, inline) };
}

function convert(n: P5Node): FixtureNode {
  return {
    tag: n.tagName!,
    classes: (attr(n, "class") ?? "").split(/\s+/).filter(Boolean),
    attrs: Object.fromEntries((n.attrs ?? []).map((a) => [a.name, a.value])),
    fixtureId: attr(n, "data-fixture"),
    line: n.sourceCodeLocation?.startLine,
    text: collapse(textOf(n)),
    ownText: collapse((n.childNodes ?? []).filter((c) => c.nodeName === "#text").map((c) => c.value ?? "").join("")),
    ...runsOf(n),
    children: (n.childNodes ?? []).filter((c) => c.tagName).map(convert),
  };
}

function find(n: P5Node, pred: (n: P5Node) => boolean, out: P5Node[] = []): P5Node[] {
  if (pred(n)) out.push(n);
  for (const c of n.childNodes ?? []) find(c, pred, out);
  return out;
}

export function parseFixture(file: string, html = readFileSync(file, "utf8")): Fixture {
  const doc = parse(html, { sourceCodeLocationInfo: true }) as unknown as P5Node;
  const stylesheets = find(doc, (n) => n.tagName === "link" && attr(n, "rel") === "stylesheet").map(
    (n) => attr(n, "href") ?? "",
  );
  const body = find(doc, (n) => n.tagName === "body")[0];
  const skip = new Set(["script", "style", "template", "noscript"]);
  return {
    file,
    stylesheets,
    body: (body?.childNodes ?? []).filter((c) => c.tagName && !skip.has(c.tagName)).map(convert),
  };
}
