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
  runMeta: { inBlock: boolean; underlined: boolean; items: number[] }[];
  children: FixtureNode[];
  /**
   * Not an element: a run of text between block-level children (an anonymous block, or an
   * anonymous flex or grid item), laid out as a text box of its own. It has no box in the DOM.
   */
  anonymous?: boolean;
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

function textOf(n: P5Node, skip?: (n: P5Node) => boolean): string {
  if (n.nodeName === "#text") return n.value ?? "";
  return (n.childNodes ?? []).filter((c) => !skip?.(c)).map((c) => textOf(c, skip)).join("");
}

const UNDERLINED = new Set(["u", "ins", "s", "del", "strike"]);

/** Marks an inline element's start or end in raw run text. */
const EDGE = "\u0001";

/** collapse(), also returning where the EDGE marks fall (in characters of the collapsed text). */
function collapseItems(raw: string): { text: string; items: number[] } {
  let out = "";
  let n = 0;
  let pending = false;
  const items: number[] = [];
  const space = () => {
    // A collapsible space after another one (even across an element edge) disappears.
    if (pending && n > 0 && !out.endsWith(" ")) {
      out += " ";
      n++;
    }
    pending = false;
  };
  for (const ch of raw) {
    if (ch === EDGE) {
      // A space before an edge belongs to the text before it.
      space();
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
  return { text, items: items.filter((b) => b < len) };
}

function runsOf(n: P5Node, skip?: (n: P5Node) => boolean): { runs: string[]; runMeta: FixtureNode["runMeta"] } {
  const runs: string[] = [];
  const runMeta: FixtureNode["runMeta"] = [];
  let cur = "";
  let underlined = false;
  let depth = 0;
  const flush = () => {
    const { text: t, items } = collapseItems(cur);
    if (t) {
      runs.push(t);
      runMeta.push({ inBlock: depth > 0, underlined, items });
    }
    cur = "";
    underlined = false;
  };
  const walk = (k: P5Node, u: boolean) => {
    if (skip?.(k)) return;
    if (k.nodeName === "#text") {
      cur += k.value ?? "";
      if (u && /\S/.test(k.value ?? "")) underlined = true;
    } else if (k.tagName === "br") flush();
    else if (k.tagName && BLOCK.has(k.tagName)) {
      flush();
      depth++;
      (k.childNodes ?? []).forEach((c) => walk(c, u));
      flush();
      depth--;
    } else {
      const ul = u || UNDERLINED.has(k.tagName ?? "") || (k.tagName === "a" && attr(k, "href") !== undefined);
      cur += EDGE;
      (k.childNodes ?? []).forEach((c) => walk(c, ul));
      cur += EDGE;
    }
  };
  (n.childNodes ?? []).forEach((c) => walk(c, false));
  flush();
  return { runs, runMeta };
}

/**
 * Text and runs of a parse5 element, leaving out descendants `skip` rejects (e.g. elements that
 * are never displayed). Same rules as the fixture parser.
 */
export function textAndRuns(n: P5Node, skip?: (n: P5Node) => boolean): { text: string; runs: string[] } {
  return { text: collapse(textOf(n, skip)), runs: runsOf(n, skip).runs };
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
