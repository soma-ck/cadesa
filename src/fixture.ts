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
  children: FixtureNode[];
}

export interface Fixture {
  file: string;
  stylesheets: string[];
  body: FixtureNode[];
}

interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
  content?: P5Node;
  sourceCodeLocation?: { startLine: number };
}

const attr = (n: P5Node, name: string) => n.attrs?.find((a) => a.name === name)?.value;

function textOf(n: P5Node): string {
  if (n.nodeName === "#text") return n.value ?? "";
  return (n.childNodes ?? []).map(textOf).join("");
}

function convert(n: P5Node): FixtureNode {
  return {
    tag: n.tagName!,
    classes: (attr(n, "class") ?? "").split(/\s+/).filter(Boolean),
    attrs: Object.fromEntries((n.attrs ?? []).map((a) => [a.name, a.value])),
    fixtureId: attr(n, "data-fixture"),
    line: n.sourceCodeLocation?.startLine,
    text: textOf(n).replace(/\s+/g, " ").trim(),
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
