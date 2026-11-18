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
  /**
   * The text split into runs that each start on a new line: block-level descendants (<p>, <li>,
   * <div>...) and <br> separate runs. Most elements have one run.
   */
  runs: string[];
  children: FixtureNode[];
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

function runsOf(n: P5Node, skip?: (n: P5Node) => boolean): string[] {
  const runs: string[] = [];
  let cur = "";
  const flush = () => {
    const t = collapse(cur);
    if (t) runs.push(t);
    cur = "";
  };
  const walk = (k: P5Node) => {
    if (skip?.(k)) return;
    if (k.nodeName === "#text") cur += k.value ?? "";
    else if (k.tagName === "br") flush();
    else if (k.tagName && BLOCK.has(k.tagName)) {
      flush();
      (k.childNodes ?? []).forEach(walk);
      flush();
    } else (k.childNodes ?? []).forEach(walk);
  };
  (n.childNodes ?? []).forEach(walk);
  flush();
  return runs;
}

/**
 * Text and runs of a parse5 element, leaving out descendants `skip` rejects (e.g. elements that
 * are never displayed). Same rules as the fixture parser.
 */
export function textAndRuns(n: P5Node, skip?: (n: P5Node) => boolean): { text: string; runs: string[] } {
  return { text: collapse(textOf(n, skip)), runs: runsOf(n, skip) };
}

function convert(n: P5Node): FixtureNode {
  return {
    tag: n.tagName!,
    classes: (attr(n, "class") ?? "").split(/\s+/).filter(Boolean),
    attrs: Object.fromEntries((n.attrs ?? []).map((a) => [a.name, a.value])),
    fixtureId: attr(n, "data-fixture"),
    line: n.sourceCodeLocation?.startLine,
    text: collapse(textOf(n)),
    runs: runsOf(n),
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
