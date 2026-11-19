/**
 * Lengths that follow the viewport width: `vw`, and calc() / min() / max() / clamp() built from
 * px, rem, em and vw. They have one value per width, which the engine computes as Chromium does
 * (in floating point; box lengths are then cut to layout units like any other length).
 *
 * parseLengthExpr reads such an expression (em against a given font size, the viewport height as
 * a given px value for vh) and returns its canonical form, in px and vw only, which is valid CSS
 * and what a Cadesa token holds: "clamp(16px, 8px + 2vw, 32px)". An expression without vw is a
 * constant and comes back as plain px.
 */

type Node =
  | { t: "num"; v: number; unit: "px" | "vw" | "" }
  | { t: "op"; op: "+" | "-" | "*" | "/"; a: Node; b: Node }
  | { t: "fn"; name: "min" | "max" | "clamp"; args: Node[] };

export interface ExprOptions {
  /** px per em (the element's font size); undefined: em is not allowed. */
  em?: number;
  /** The viewport height in px for vh, dvh, svh and lvh (and vmin / vmax); undefined: not allowed. */
  vh?: number;
}

/** Absolute units in px (CSS: 1in = 96px). */
export const ABSOLUTE: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);

/** Parse a length expression; undefined when it uses anything else (%, other units, other functions). */
export function parseExpr(src: string, opts: ExprOptions = {}): Node | undefined {
  const s = src.trim();
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const fail = () => {
    throw new Error("unparsable");
  };
  const expr = (): Node => {
    let a = term();
    for (;;) {
      ws();
      const c = s[i];
      // + and - need whitespace around them in CSS; a sign glued to a number is the number's.
      if ((c === "+" || c === "-") && /\s/.test(s[i - 1] ?? "") && /\s/.test(s[i + 1] ?? "")) {
        i++;
        a = { t: "op", op: c, a, b: term() };
      } else return a;
    }
  };
  const term = (): Node => {
    let a = factor();
    for (;;) {
      ws();
      const c = s[i];
      if (c === "*" || c === "/") {
        i++;
        a = { t: "op", op: c, a, b: factor() };
      } else return a;
    }
  };
  const factor = (): Node => {
    ws();
    const fn = /^(calc|min|max|clamp)\(/i.exec(s.slice(i));
    if (fn) {
      i += fn[0].length;
      const args: Node[] = [expr()];
      ws();
      while (s[i] === ",") {
        i++;
        args.push(expr());
        ws();
      }
      if (s[i] !== ")") fail();
      i++;
      const name = fn[1].toLowerCase();
      if (name === "calc") {
        if (args.length !== 1) fail();
        return args[0];
      }
      if (name === "clamp" && args.length !== 3) fail();
      return { t: "fn", name: name as "min" | "max" | "clamp", args };
    }
    if (s[i] === "(") {
      i++;
      const e = expr();
      ws();
      if (s[i] !== ")") fail();
      i++;
      return e;
    }
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/i.exec(s.slice(i));
    if (!m) fail();
    i += m![0].length;
    const n = parseFloat(m![1]);
    const unit = m![2].toLowerCase();
    if (unit === "") return { t: "num", v: n, unit: "" };
    if (unit === "vw") return { t: "num", v: n, unit: "vw" };
    if (ABSOLUTE[unit] !== undefined) return { t: "num", v: n * ABSOLUTE[unit], unit: "px" };
    if (unit === "rem") return { t: "num", v: n * 16, unit: "px" };
    if (unit === "em" && opts.em !== undefined) return { t: "num", v: n * opts.em, unit: "px" };
    if (/^[dsl]?vh$/.test(unit) && opts.vh !== undefined) return { t: "num", v: (n * opts.vh) / 100, unit: "px" };
    if (/^[dsl]?vmin$/.test(unit) && opts.vh !== undefined) return { t: "fn", name: "min", args: [{ t: "num", v: n, unit: "vw" }, { t: "num", v: (n * opts.vh) / 100, unit: "px" }] };
    if (/^[dsl]?vmax$/.test(unit) && opts.vh !== undefined) return { t: "fn", name: "max", args: [{ t: "num", v: n, unit: "vw" }, { t: "num", v: (n * opts.vh) / 100, unit: "px" }] };
    return fail();
  };
  try {
    const e = expr();
    ws();
    if (i !== s.length) return undefined;
    return kind(e) === "length" ? e : undefined;
  } catch {
    return undefined;
  }
}

/** "length" or "number" (unitless), or throws on a mix CSS rejects (px + 2). */
function kind(n: Node): "length" | "number" {
  if (n.t === "num") return n.unit ? "length" : "number";
  if (n.t === "fn") {
    const ks = n.args.map(kind);
    if (ks.some((k) => k !== ks[0])) throw new Error("mixed");
    return ks[0];
  }
  const [a, b] = [kind(n.a), kind(n.b)];
  if (n.op === "+" || n.op === "-") {
    if (a !== b) throw new Error("mixed");
    return a;
  }
  if (n.op === "*") {
    if (a === "length" && b === "length") throw new Error("mixed");
    return a === "length" || b === "length" ? "length" : "number";
  }
  if (b === "length") throw new Error("mixed");
  return a;
}

const hasVw = (n: Node): boolean => (n.t === "num" ? n.unit === "vw" : n.t === "op" ? hasVw(n.a) || hasVw(n.b) : n.args.some(hasVw));

/** The value in px at a viewport width. */
export function evalExpr(n: Node, viewport: number): number {
  if (n.t === "num") return n.unit === "vw" ? (n.v * viewport) / 100 : n.v;
  if (n.t === "fn") {
    const xs = n.args.map((a) => evalExpr(a, viewport));
    if (n.name === "min") return Math.min(...xs);
    if (n.name === "max") return Math.max(...xs);
    return Math.max(xs[0], Math.min(xs[1], xs[2]));
  }
  const [a, b] = [evalExpr(n.a, viewport), evalExpr(n.b, viewport)];
  return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : a / b;
}

function print(n: Node, top = false): string {
  if (n.t === "num") return `${fmt(n.v)}${n.unit}`;
  if (n.t === "fn") return `${n.name}(${n.args.map((a) => print(a)).join(", ")})`;
  const inner = `${print(n.a)} ${n.op} ${print(n.b)}`;
  return top ? `calc(${inner})` : `(${inner})`;
}

export interface Fluid {
  /** Canonical CSS: plain px for a constant, else an expression in px and vw. */
  css: string;
  /** Its value in px at a viewport width. */
  at(viewport: number): number;
  /** It changes with the viewport width. */
  fluid: boolean;
}

/** A length expression: its canonical CSS and its value per viewport width (undefined: not one Cadesa computes). */
export function lengthExpr(src: string, opts: ExprOptions = {}): Fluid | undefined {
  const n = parseExpr(src, opts);
  if (!n) return undefined;
  if (!hasVw(n)) {
    const v = evalExpr(n, 0);
    return isFinite(v) ? { css: `${fmt(v)}px`, at: () => v, fluid: false } : undefined;
  }
  return { css: n.t === "num" ? print(n) : print(n, true), at: (w) => evalExpr(n, w), fluid: true };
}

/** A value that mentions the viewport, math functions or absolute units, and so may be one for lengthExpr. */
export const MATHY = /\b(?:calc|min|max|clamp)\(|\d(?:[dsl]?v(?:w|h|min|max)|pt|pc|in|cm|mm|q)\b/i;
