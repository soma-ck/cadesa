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
  | { t: "num"; v: number; unit: "px" | "vw" | "%" | "" }
  | { t: "op"; op: "+" | "-" | "*" | "/"; a: Node; b: Node }
  | { t: "fn"; name: "min" | "max" | "clamp"; args: Node[] };

export interface ExprOptions {
  /** px per em (the element's font size); undefined: em is not allowed. */
  em?: number;
  /** The viewport height in px for vh, dvh, svh and lvh (and vmin / vmax); undefined: not allowed. */
  vh?: number;
  /**
   * Percentages are allowed (of a base the caller gives at evaluation: the containing block's
   * width for a width or max-width). Such an expression is returned with `pct`.
   */
  pct?: boolean;
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
    if (unit === "%" && opts.pct) return { t: "num", v: n, unit: "%" };
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
const hasPct = (n: Node): boolean => (n.t === "num" ? n.unit === "%" : n.t === "op" ? hasPct(n.a) || hasPct(n.b) : n.args.some(hasPct));

type Linear = { px: number; vw: number; pct: number };
/** A sum of px, vw and % terms (no min(), max() or clamp() inside), or undefined. */
function linear(n: Node): Linear | undefined {
  if (n.t === "num") return n.unit === "" ? undefined : { px: n.unit === "px" ? n.v : 0, vw: n.unit === "vw" ? n.v : 0, pct: n.unit === "%" ? n.v : 0 };
  if (n.t === "fn") return undefined;
  const num = (x: Node): number | undefined => (kindSafe(x) === "number" ? evalExpr(x, 0) : undefined);
  if (n.op === "+" || n.op === "-") {
    const [a, b] = [linear(n.a), linear(n.b)];
    if (!a || !b) return undefined;
    const s = n.op === "+" ? 1 : -1;
    return { px: a.px + s * b.px, vw: a.vw + s * b.vw, pct: a.pct + s * b.pct };
  }
  const scale = (l: Linear | undefined, k: number | undefined) => (l && k !== undefined && isFinite(k) ? { px: l.px * k, vw: l.vw * k, pct: l.pct * k } : undefined);
  if (n.op === "*") return scale(linear(n.a), num(n.b)) ?? scale(linear(n.b), num(n.a));
  const d = num(n.b);
  return d ? scale(linear(n.a), 1 / d) : undefined;
}
function kindSafe(n: Node): "length" | "number" | undefined {
  try {
    return kind(n);
  } catch {
    return undefined;
  }
}

/**
 * The value in px of an expression with percentages of `base`, as Chromium evaluates it: in float
 * (float32), each sum of px and % as one pixels-and-percent value (pixels + percent / 100 × base),
 * min(), max() and clamp() of those, and other arithmetic in float. A width is never negative.
 */
export function evalPct(n: Node, viewport: number, base: number): number {
  const f = Math.fround;
  const go = (x: Node): number => {
    const l = linear(x);
    if (l) return f(f(l.px + (l.vw * viewport) / 100) + f(f(f(l.pct) / 100) * f(base)));
    if (x.t === "num") return f(x.v);
    if (x.t === "fn") {
      const xs = x.args.map(go);
      if (x.name === "min") return Math.min(...xs);
      if (x.name === "max") return Math.max(...xs);
      return Math.max(xs[0], Math.min(xs[1], xs[2]));
    }
    const [a, b] = [go(x.a), go(x.b)];
    return f(x.op === "+" ? a + b : x.op === "-" ? a - b : x.op === "*" ? a * b : a / b);
  };
  return Math.max(0, go(n));
}

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
  /** It has percentages (only with the `pct` option): its px for a viewport width and a percentage base; `at` is then NaN. */
  pct?: (viewport: number, base: number) => number;
}

/** A length expression: its canonical CSS and its value per viewport width (undefined: not one Cadesa computes). */
export function lengthExpr(src: string, opts: ExprOptions = {}): Fluid | undefined {
  const n = parseExpr(src, opts);
  if (!n) return undefined;
  if (hasPct(n)) return { css: n.t === "num" ? print(n) : print(n, true), at: () => NaN, fluid: hasVw(n), pct: (w, base) => evalPct(n, w, base) };
  if (!hasVw(n)) {
    const v = evalExpr(n, 0);
    return isFinite(v) ? { css: `${fmt(v)}px`, at: () => v, fluid: false } : undefined;
  }
  return { css: n.t === "num" ? print(n) : print(n, true), at: (w) => evalExpr(n, w), fluid: true };
}

/** A value that mentions the viewport, math functions or absolute units, and so may be one for lengthExpr. */
export const MATHY = /\b(?:calc|min|max|clamp)\(|\d(?:[dsl]?v(?:w|h|min|max)|pt|pc|in|cm|mm|q)\b/i;
