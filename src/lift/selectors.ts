/** Classify selectors against the BEM contract, and match arbitrary simple selectors to fixture nodes. */
import type { FixtureNode } from "../fixture.js";

export type Target =
  | { kind: "root"; block: string }
  | { kind: "slot"; block: string; element: string }
  | { kind: "reset"; block: string }
  | { kind: "other" };

const NAME = "([a-z][a-z0-9]*(?:-[a-z0-9]+)*)";
const ROOT = new RegExp(`^\\.${NAME}$`);
const SLOT = new RegExp(`^(?:\\.${NAME} (?:> )?)?\\.${NAME}__${NAME}$`);
const RESET = new RegExp(`^\\.${NAME} (?::where\\(\\*\\)|\\*)$`);

export function classify(selector: string): Target {
  const s = selector.replace(/\s*>\s*/g, " > ").replace(/\s+/g, " ").trim();
  let m = ROOT.exec(s);
  if (m && !s.includes("__")) return { kind: "root", block: m[1] };
  m = SLOT.exec(s);
  if (m && (!m[1] || m[1] === m[2])) return { kind: "slot", block: m[2], element: m[3] };
  m = RESET.exec(s);
  if (m) return { kind: "reset", block: m[1] };
  return { kind: "other" };
}

const STATE = new Set([
  "hover",
  "focus",
  "focus-visible",
  "focus-within",
  "active",
  "visited",
  "target",
  "checked",
  "disabled",
  "enabled",
  "invalid",
  "valid",
  "placeholder-shown",
]);

export interface MatchResult {
  matches: boolean;
  /** Matches only in an interactive state (e.g. :hover), never in the default state. */
  state: boolean;
  pseudoElement: boolean;
}

export interface Located {
  node: FixtureNode;
  parent?: Located;
  index: number;
  siblings: number;
}

interface Compound {
  tag?: string;
  classes: string[];
  ids: string[];
  attrs: string[];
  pseudos: { name: string; arg?: string }[];
  pseudoElement: boolean;
}

function parseCompound(text: string): Compound | undefined {
  const c: Compound = { classes: [], ids: [], attrs: [], pseudos: [], pseudoElement: false };
  const re = /(\*|[a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([^\]]*)\]|(::?)([\w-]+)(?:\(([^)]*)\))?/g;
  let pos = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index !== pos) return undefined;
    pos = re.lastIndex;
    if (m[1]) c.tag = m[1] === "*" ? undefined : m[1].toLowerCase();
    else if (m[2]) c.classes.push(m[2]);
    else if (m[3]) c.ids.push(m[3]);
    else if (m[4] !== undefined) c.attrs.push(m[4]);
    else if (m[5] === "::" || ["before", "after", "first-line", "first-letter", "marker"].includes(m[6])) c.pseudoElement = true;
    else c.pseudos.push({ name: m[6].toLowerCase(), arg: m[7] });
  }
  return pos === text.length ? c : undefined;
}

function nth(arg: string | undefined, index: number): boolean {
  const a = (arg ?? "").replace(/\s/g, "");
  const i = index + 1;
  if (a === "odd") return i % 2 === 1;
  if (a === "even") return i % 2 === 0;
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(a);
  if (m) {
    const k = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : parseInt(m[1]);
    const b = m[2] ? parseInt(m[2]) : 0;
    return k === 0 ? i === b : (i - b) / k >= 0 && (i - b) % k === 0;
  }
  return /^\d+$/.test(a) ? i === parseInt(a) : true; // unknown: over-approximate
}

/** Does a compound match? Unknown parts match (over-approximation means more boxes flagged, never fewer). */
function compoundMatches(c: Compound, l: Located): { ok: boolean; state: boolean } {
  const n = l.node;
  if (c.tag && c.tag !== n.tag) return { ok: false, state: false };
  if (c.classes.some((k) => !n.classes.includes(k))) return { ok: false, state: false };
  if (c.ids.some((id) => n.attrs.id !== id)) return { ok: false, state: false };
  for (const a of c.attrs) {
    const m = /^([\w-]+)(?:([~|^$*]?=)["']?([^"']*)["']?)?$/.exec(a.trim());
    if (!m) continue;
    const v = n.attrs[m[1]];
    if (v === undefined) return { ok: false, state: false };
    if (m[2] === "=" && v !== m[3]) return { ok: false, state: false };
  }
  let state = false;
  for (const p of c.pseudos) {
    if (STATE.has(p.name)) state = true;
    else if (p.name === "first-child" && l.index !== 0) return { ok: false, state: false };
    else if (p.name === "last-child" && l.index !== l.siblings - 1) return { ok: false, state: false };
    else if (p.name === "only-child" && l.siblings !== 1) return { ok: false, state: false };
    else if (p.name === "nth-child" && !nth(p.arg, l.index)) return { ok: false, state: false };
  }
  return { ok: true, state };
}

export function match(selector: string, l: Located): MatchResult {
  const no = { matches: false, state: false, pseudoElement: false };
  const parts = selector.replace(/\s*([>+~])\s*/g, " $1 ").trim().split(/\s+/);
  const compounds: { c: Compound; comb: string }[] = [];
  let comb = " ";
  for (const p of parts) {
    if ([">", "+", "~"].includes(p)) {
      comb = p;
      continue;
    }
    const c = parseCompound(p);
    if (!c) return { matches: true, state: false, pseudoElement: false }; // unparseable: assume it may match
    compounds.push({ c, comb });
    comb = " ";
  }
  if (!compounds.length) return no;
  const last = compounds[compounds.length - 1];
  const self = compoundMatches(last.c, l);
  if (!self.ok) return no;
  let state = self.state;
  // Walk ancestors right to left. Sibling combinators are over-approximated as "any ancestor context".
  let cur: Located | undefined = l;
  for (let i = compounds.length - 2; i >= 0; i--) {
    const comb = compounds[i + 1].comb;
    const want = compounds[i].c;
    if (comb === "+" || comb === "~") continue;
    let found = false;
    for (let a: Located | undefined = cur?.parent; a; a = comb === ">" ? undefined : a.parent) {
      const r = compoundMatches(want, a);
      if (r.ok) {
        state ||= r.state;
        cur = a;
        found = true;
        break;
      }
    }
    if (!found) return no;
  }
  return { matches: true, state, pseudoElement: last.c.pseudoElement };
}

export function locate(roots: FixtureNode[]): Located[] {
  const out: Located[] = [];
  const visit = (nodes: FixtureNode[], parent?: Located) =>
    nodes.forEach((node, index) => {
      const l: Located = { node, parent, index, siblings: nodes.length };
      out.push(l);
      visit(node.children, l);
    });
  visit(roots);
  return out;
}
