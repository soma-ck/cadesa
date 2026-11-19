/**
 * What an edit does to check's findings (fixed, still there, new), and, for rules added with
 * `whatif --add-css`, which of them lost the cascade to a rule already in the page's CSS.
 */
import postcss, { type AtRule, type Declaration, type Rule } from "postcss";
import type { Finding } from "./check.js";
import { matchComplex, parseSelector, specificityOf } from "./lift/css-page.js";
import { longhands, type El, type PageLift } from "./lift/page.js";

/** The same issue before and after an edit: same check, element and message apart from its numbers. */
export const issueKey = (f: Finding) =>
  [
    f.check,
    f.id,
    f.message
      .replace(/ \(inconclusive: [^)]*\)$/, "")
      .replace(/-?\d+(?:\.\d+)?/g, "#")
      .replace(/ #px\b/g, ""),
  ].join("|");

export interface FindingChange {
  /** "fixed": only before the edit; "still": before and after; "new": only after. */
  status: "fixed" | "still" | "new";
  check: Finding["check"];
  /** The finding after the edit (before it, for a fixed one), at the first width it occurs. */
  finding: Finding;
  /** For "still": the finding before the edit, when its message differs (the numbers changed). */
  was?: Finding;
  widths: number[];
}

/** Compare check's findings before and after an edit, width by width, one entry per issue. */
export function compareFindings(before: Finding[], after: Finding[]): FindingChange[] {
  const out = new Map<string, FindingChange>();
  const add = (status: FindingChange["status"], f: Finding, was?: Finding) => {
    const k = `${status}|${issueKey(f)}|${f.severity}|${f.inconclusive ? 1 : 0}`;
    const c = out.get(k);
    if (c) {
      c.widths.push(f.width);
      if (was && !c.was && was.message !== f.message) c.was = was;
    } else out.set(k, { status, check: f.check, finding: f, ...(was && was.message !== f.message && { was }), widths: [f.width] });
  };
  const widths = [...new Set([...before, ...after].map((f) => f.width))].sort((a, b) => a - b);
  for (const w of widths) {
    const b = before.filter((f) => f.width === w);
    const a = after.filter((f) => f.width === w);
    const bk = new Map(b.map((f) => [issueKey(f), f]));
    const ak = new Map(a.map((f) => [issueKey(f), f]));
    for (const f of b) if (!ak.has(issueKey(f))) add("fixed", f);
    for (const f of a) {
      const was = bk.get(issueKey(f));
      add(was ? "still" : "new", f, was);
    }
  }
  const rank = { new: 0, still: 1, fixed: 2 };
  return [...out.values()].sort((x, y) => rank[x.status] - rank[y.status]);
}

// ------------------------------------------------------------------ --add-css

export interface LostRule {
  /** The added rule, e.g. ".x { padding: 2px 0 }". */
  rule: string;
  /** The longhands it sets that another rule overrides. */
  props: string[];
  /** The elements it matches where it lost: `<button.x>`. */
  elements: string[];
  /** The rule that won, e.g. ".a .x { … } at app.css:12". */
  winner: string;
  why: string;
  /** The widths where it loses, when not all of them ("≤ 767.98px"). */
  at?: string;
}

export interface AddedCssReport {
  /** Added rules that match no element on the page. */
  unmatched: string[];
  lost: LostRule[];
}

const short = (el: El) => {
  const cls = el.classes.filter((c) => !c.startsWith("ca-"));
  return `<${el.tag}${cls.slice(0, 3).map((c) => `.${c}`).join("")}${cls.length > 3 ? "…" : ""}>`;
};
const spec = (s: [number, number, number]) => s.join(",");
const more = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** "≤ 767.98px", "≥ 768px" or "768–991.98px" for the lift's width ranges `sis`. */
function describeStates(lift: PageLift, sis: number[]): string {
  const st = sis.map((i) => lift.states[i]).sort((a, b) => a.lo - b.lo);
  const parts: string[] = [];
  for (let i = 0; i < st.length; ) {
    let j = i;
    while (j + 1 < st.length && Math.abs(st[j + 1].lo - st[j].hi) < 0.001) j++;
    const lo = st[i].lo;
    const hi = st[j].hi;
    const top = Math.round((hi - 0.01) * 100) / 100;
    parts.push(hi === Infinity ? `≥ ${lo}px` : lo <= 0 ? `≤ ${top}px` : `${lo}–${top}px`);
    i = j + 1;
  }
  return parts.join(", ");
}

/**
 * For rules appended to `file` from line `firstLine` on (whatif --add-css), lifted into `lift`:
 * the ones that match nothing, and the ones a rule already in the cascade beats on an element they
 * match (a more specific selector, !important, a style attribute or a later rule).
 */
export function checkAddedCss(lift: PageLift, addCss: string, file: string, firstLine: number, readFile: (f: string) => string | undefined): AddedCssReport {
  const report: AddedCssReport = { unmatched: [], lost: [] };
  let root: postcss.Root;
  try {
    root = postcss.parse(addCss);
  } catch {
    return report; // the lift reports what it can't read
  }
  const els = lift.elements.els.filter((e) => e.anonymous === undefined);
  const lines = new Map<string, string[]>();
  /** A rule's text from the line it starts on to its closing brace. */
  const ruleText = (f: string, n: number) => {
    if (!lines.has(f)) lines.set(f, (readFile(f) ?? "").split("\n"));
    const all = lines.get(f)!.slice(n - 1, n + 60).join("\n");
    const end = all.indexOf("}");
    return end < 0 ? all : all.slice(0, end + 1);
  };
  const isOurs = (label: string) => {
    const at = /\(([^()]+):(\d+)\)$/.exec(label);
    return !!at && at[1] === file && Number(at[2]) >= firstLine;
  };
  root.walkRules((r: Rule) => {
    const parent = r.parent?.type === "atrule" ? (r.parent as AtRule) : undefined;
    if (parent && !/^(media|supports|layer)$/i.test(parent.name)) return;
    const inMedia = !!parent;
    const decls = r.nodes.filter((n): n is Declaration => n.type === "decl" && !n.prop.startsWith("--"));
    if (!decls.length) return;
    const text = `${r.selector.replace(/\s+/g, " ").trim()} { ${decls.map((d) => `${d.prop}: ${d.value}${d.important ? " !important" : ""}`).join("; ")} }`;
    let matched = false;
    const lost = new Map<string, LostRule>();
    for (const sel of r.selectors) {
      const complex = parseSelector(sel.trim());
      // A selector Cadesa can't read, or a pseudo-element: don't claim anything about it.
      if (!complex || complex.parts.some((p) => p.simples.some((s) => s.kind === "pseudo-element"))) {
        matched = true;
        continue;
      }
      const ours = specificityOf(complex);
      for (const el of els) {
        const m = matchComplex(complex, el);
        if (m === "no") continue;
        matched = true;
        if (m !== "yes") continue;
        for (const d of decls) {
          for (const [p] of longhands(d.prop.toLowerCase(), d.value)) {
            // Every width range where something else sets it (for a rule inside @media: only when it never wins).
            const states = el.own.map((own, si) => ({ si, o: own?.get(p) })).filter((x): x is { si: number; o: NonNullable<typeof x.o> } => !!x.o);
            const lostAt = states.filter((x) => !isOurs(x.o.utility));
            if (!lostAt.length || (inMedia && lostAt.length < states.length)) continue;
            const o = lostAt[0].o;
            let winner: string;
            let why: string;
            if (o.utility.startsWith('style="')) {
              winner = `the style attribute ${o.utility}`;
              why = "beats any stylesheet rule";
            } else {
              const at = /^(.*) \(([^()]+):(\d+)\)$/.exec(o.utility);
              if (!at) continue; // a browser default can't beat an author rule
              const [, wsel, wfile, wline] = at;
              winner = `${wsel} { … } at ${wfile}:${wline}`;
              const wc = parseSelector(wsel);
              const theirs = wc ? specificityOf(wc) : undefined;
              const family = d.prop.toLowerCase().split("-")[0];
              const decl = ruleText(wfile, Number(wline)).split(/[;{}]/).find((x) => new RegExp(`(^|\\s)${family}[\\w-]*\\s*:`, "i").test(x)) ?? "";
              if (/!\s*important/i.test(decl) && !d.important) why = "is !important";
              else if (theirs && more(theirs, ours) > 0) why = `is more specific (${spec(theirs)} vs your ${spec(ours)})`;
              else why = "comes later in the cascade";
            }
            const ranges = !inMedia && lostAt.length < el.own.filter(Boolean).length ? describeStates(lift, lostAt.map((x) => x.si)) : undefined;
            const k = `${winner}|${why}|${ranges ?? ""}`;
            const l = lost.get(k) ?? { rule: text, props: [], elements: [], winner, why, ...(ranges && { at: ranges }) };
            if (!l.props.includes(p)) l.props.push(p);
            const name = short(el);
            if (!l.elements.includes(name)) l.elements.push(name);
            lost.set(k, l);
          }
        }
      }
    }
    if (!matched) report.unmatched.push(text);
    report.lost.push(...lost.values());
  });
  return report;
}
