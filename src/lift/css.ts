/** Parse CSS into flat rules with media context, specificity and source lines. */
import postcss, { type AtRule, type ChildNode, type Rule } from "postcss";

export interface Decl {
  prop: string;
  value: string;
  important: boolean;
  line: number;
}

export interface Media {
  raw: string;
  /** Set for `(max-width: X)` queries, the only kind Cascadio models. */
  maxPx?: number;
  maxRaw?: string;
  minPx?: number;
}

export interface CssRule {
  selector: string;
  decls: Decl[];
  line: number;
  media?: Media;
  order: number;
}

export interface Skipped {
  line: number;
  text: string;
  reason: string;
}

export interface ParsedCss {
  file: string;
  rules: CssRule[];
  /** Custom property definitions (`--x: value`), last definition wins. */
  vars: Map<string, Decl>;
  /** Top-level comments of the form `/* name: text *\/`, as Cascadio emits for `intent`. */
  notes: Map<string, string>;
  skipped: Skipped[];
}

const MEDIA = /^(?:only\s+)?(?:screen\s+and\s+)?\(\s*(max|min)-width\s*:\s*([\d.]+)(px|rem|em)\s*\)$/i;

export function parseMedia(raw: string): Media {
  const m = MEDIA.exec(raw.trim());
  if (!m) return { raw };
  const px = parseFloat(m[2]) * (m[3].toLowerCase() === "px" ? 1 : 16);
  return m[1].toLowerCase() === "max" ? { raw, maxPx: px, maxRaw: `${m[2]}${m[3]}` } : { raw, minPx: px };
}

/** Split a selector list on top-level commas. */
export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of list) {
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((s) => s.replace(/\s+/g, " "));
}

/** [ids, classes/attributes/pseudo-classes, types]. :where() counts 0; :is/:not count their argument. */
export function specificity(sel: string): [number, number, number] {
  const s = sel.replace(/:where\([^)]*\)/g, "").replace(/:(?:is|not)\(([^)]*)\)/g, " $1 ");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g) ?? []).length;
  const types = (s.replace(/\[[^\]]*\]/g, "").match(/(?:^|[\s>+~(])([a-zA-Z][\w-]*)|::[\w-]+/g) ?? []).length;
  return [ids, classes, types];
}

export function parseCss(file: string, text: string): ParsedCss {
  const root = postcss.parse(text, { from: file });
  const rules: CssRule[] = [];
  const vars = new Map<string, Decl>();
  const skipped: Skipped[] = [];
  const notes = new Map<string, string>();
  let order = 0;

  const visitRule = (r: Rule, media?: Media) => {
    const decls: Decl[] = [];
    r.each((n) => {
      if (n.type !== "decl") {
        if (n.type !== "comment")
          skipped.push({ line: n.source?.start?.line ?? 0, text: n.toString().split("\n")[0], reason: "nested rules are not supported" });
        return;
      }
      const d = { prop: n.prop.toLowerCase(), value: n.value.trim(), important: n.important, line: n.source?.start?.line ?? 0 };
      if (d.prop.startsWith("--")) vars.set(n.prop, d);
      else decls.push(d);
    });
    if (decls.length) rules.push({ selector: r.selector, decls, line: r.source?.start?.line ?? 0, media, order: order++ });
  };

  const visit = (n: ChildNode, media?: Media) => {
    if (n.type === "rule") visitRule(n, media);
    else if (n.type === "atrule") {
      const a = n as AtRule;
      if (a.name.toLowerCase() === "media" && !media) a.each((c) => visit(c, parseMedia(a.params)));
      else if (a.name.toLowerCase() === "media")
        skipped.push({ line: a.source?.start?.line ?? 0, text: `@media ${a.params}`, reason: "nested @media is not supported" });
      else
        skipped.push({
          line: a.source?.start?.line ?? 0,
          text: `@${a.name} ${a.params}`.trim(),
          reason:
            a.name === "font-face"
              ? "fonts load outside Cascadio; text is measured only for fonts with Cascadio metrics"
              : `@${a.name} is not modelled`,
        });
    }
  };
  root.each((n) => {
    if (n.type === "comment") {
      const m = /^([a-z][a-z0-9-]*): (.+)$/s.exec(n.text.trim());
      if (m) notes.set(m[1], m[2].replace(/\s+/g, " "));
    } else visit(n);
  });
  return { file, rules, vars, skipped, notes };
}
