/**
 * Value helpers for compiled Tailwind CSS: var() substitution, calc() evaluation and color
 * conversion (Tailwind v4 colors are oklch(); Cadesa tokens are hex).
 */

// ---------------------------------------------------------------- balanced scanning

/** Index of the parenthesis closing the one at `open`, or -1. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Split on top-level commas. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth === 0 && c === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

// ---------------------------------------------------------------- var()

/** Marker for a guaranteed-invalid value (an undefined var() without fallback). */
export const INVALID = "\u0000invalid";

/**
 * Replace every var(--x, fallback) in `value`. `lookup` returns the variable's (already
 * substituted) value, or undefined when it has none. Returns INVALID when a reference can't be
 * resolved, as browsers do (the declaration becomes invalid at computed-value time).
 */
export function substitute(value: string, lookup: (name: string) => string | undefined, depth = 0): string {
  if (depth > 16) return INVALID;
  if (depth === 0 && value.includes("env(")) {
    const v = substitute(value, lookup, 1);
    return v === INVALID ? v : resolveEnv(v);
  }
  let out = "";
  let i = 0;
  for (;;) {
    const at = value.indexOf("var(", i);
    if (at < 0) return out + value.slice(i);
    const end = closing(value, at + 3);
    if (end < 0) return INVALID;
    out += value.slice(i, at);
    const inner = value.slice(at + 4, end);
    const comma = splitTop(inner);
    const name = comma[0].trim();
    const fallback = comma.length > 1 ? inner.slice(inner.indexOf(",") + 1).trim() : undefined;
    let v = lookup(name);
    if (v === undefined || v === INVALID) {
      if (fallback === undefined) return INVALID;
      v = substitute(fallback, lookup, depth + 1);
      if (v === INVALID) return INVALID;
    }
    out += v;
    i = end + 1;
  }
}

/**
 * env() as a desktop browser window has it: the safe-area and keyboard insets are 0, anything
 * else takes its fallback (or makes the value invalid without one, as Chromium does).
 */
export function resolveEnv(value: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = value.indexOf("env(", i);
    if (at < 0) return out + value.slice(i);
    const end = closing(value, at + 3);
    if (end < 0) return INVALID;
    out += value.slice(i, at);
    const inner = value.slice(at + 4, end);
    const parts = splitTop(inner);
    const name = parts[0].trim();
    const fallback = parts.length > 1 ? inner.slice(inner.indexOf(",") + 1).trim() : undefined;
    if (/^(safe-area-inset|keyboard-inset)-/.test(name) || /^safe-area-max-inset-/.test(name)) out += "0px";
    else if (fallback !== undefined) out += resolveEnv(fallback);
    else return INVALID;
    i = end + 1;
  }
}

// ---------------------------------------------------------------- calc()

type Unit = "" | "px" | "%" | "em";
interface Dim {
  n: number;
  u: Unit;
}

function tokenize(s: string): string[] | undefined {
  const re = /\s*(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?(?:px|rem|em|%)?|infinity|calc\(|\(|\)|\*|\/|\+|-)\s*/gy;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while (re.lastIndex < s.length && (m = re.exec(s))) out.push(m[1] === "calc(" ? "(" : m[1]);
  return re.lastIndex === s.length || s.slice(re.lastIndex).trim() === "" ? out : undefined;
}

function evalTokens(tokens: string[]): Dim | undefined {
  let pos = 0;
  const peek = () => tokens[pos];
  const atom = (): Dim | undefined => {
    const t = tokens[pos++];
    if (t === undefined) return undefined;
    if (t === "(") {
      const v = sum();
      if (tokens[pos++] !== ")") return undefined;
      return v;
    }
    if (t === "infinity") return { n: Infinity, u: "" };
    if (t === "-" ) {
      const v = atom();
      return v && { n: -v.n, u: v.u };
    }
    const m = /^(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?)(px|rem|em|%)?$/.exec(t);
    if (!m) return undefined;
    const n = parseFloat(m[1]);
    return m[2] === "rem" ? { n: n * 16, u: "px" } : { n, u: (m[2] ?? "") as Unit };
  };
  const product = (): Dim | undefined => {
    let a = atom();
    while (a && (peek() === "*" || peek() === "/")) {
      const op = tokens[pos++];
      const b = atom();
      if (!b) return undefined;
      if (op === "*") {
        if (a.u && b.u) return undefined;
        a = { n: a.n * b.n, u: a.u || b.u };
      } else {
        if (b.u) return undefined;
        a = { n: a.n / b.n, u: a.u };
      }
    }
    return a;
  };
  const sum = (): Dim | undefined => {
    let a = product();
    while (a && (peek() === "+" || peek() === "-")) {
      const op = tokens[pos++];
      const b = product();
      if (!b) return undefined;
      // 0 is unit-agnostic in practice (Tailwind writes calc(x * 0)).
      const u = a.u === b.u ? a.u : a.n === 0 ? b.u : b.n === 0 ? a.u : undefined;
      if (u === undefined) return undefined;
      a = { n: op === "+" ? a.n + b.n : a.n - b.n, u };
    }
    return a;
  };
  const v = sum();
  return pos === tokens.length ? v : undefined;
}

const fmt = (d: Dim) => {
  if (!Number.isFinite(d.n)) return `${d.n > 0 ? 9999 : -9999}${d.u || ""}`;
  const n = Math.round(d.n * 1e6) / 1e6;
  return `${Object.is(n, -0) ? 0 : n}${d.u}`;
};

/** Evaluate a single calc() expression (without the calc( wrapper). */
export function evalCalc(expr: string): string | undefined {
  const t = tokenize(expr);
  const v = t && evalTokens(t);
  return v ? fmt(v) : undefined;
}

/** Replace every evaluable calc(...) in `value` with its result; rem becomes px. */
export function simplify(value: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = value.indexOf("calc(", i);
    if (at < 0) {
      out += value.slice(i);
      break;
    }
    const end = closing(value, at + 4);
    if (end < 0) return value;
    out += value.slice(i, at);
    const inner = value.slice(at + 5, end);
    out += evalCalc(inner) ?? `calc(${simplify(inner)})`;
    i = end + 1;
  }
  // Bare rem lengths become px (16px root).
  return out.replace(/(^|[\s(,])(-?(?:\d+\.?\d*|\.\d+))rem\b/g, (_, pre, n) => `${pre}${Math.round(parseFloat(n) * 16 * 1e6) / 1e6}px`);
}

// ---------------------------------------------------------------- colors

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toLinear = (c: number) => (Math.abs(c) <= 0.04045 ? c / 12.92 : Math.sign(c) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (Math.abs(c) <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * Math.abs(c) ** (1 / 2.4) - 0.055));

function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const NAMED: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  transparent: "#00000000",
  red: "#ff0000",
  currentcolor: "currentcolor",
  canvastext: "#000000",
  canvas: "#ffffff",
};

const num = (s: string, scale = 1) => (s.endsWith("%") ? (parseFloat(s) / 100) * scale : s === "none" ? 0 : parseFloat(s));

/** Parse a CSS color (hex, rgb(), hsl() not included, oklch(), oklab(), color-mix(), named). */
export function parseColor(raw: string, current?: RGBA): RGBA | undefined {
  const s = raw.trim().toLowerCase();
  if (s === "currentcolor") return current;
  if (NAMED[s] && NAMED[s] !== "currentcolor") return parseColor(NAMED[s]);
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  m = /^(rgba?|oklch|oklab)\((.*)\)$/.exec(s);
  if (m) {
    const [chans, alpha] = m[2].includes("/") ? m[2].split("/") : [m[2], undefined];
    const p = chans.trim().split(/[\s,]+/);
    if (m[1].startsWith("rgb") && p.length === 4 && alpha === undefined) p.length = 3; // rgba(r, g, b, a)
    const a = alpha !== undefined ? clamp01(num(alpha.trim())) : m[1].startsWith("rgb") && chans.split(",").length === 4 ? clamp01(num(chans.split(",")[3].trim())) : 1;
    if (p.length < 3) return undefined;
    if (m[1].startsWith("rgb")) return { r: num(p[0], 255) / 255, g: num(p[1], 255) / 255, b: num(p[2], 255) / 255, a };
    const L = num(p[0]);
    let A: number;
    let B: number;
    if (m[1] === "oklch") {
      const C = num(p[1], 0.4);
      const h = (num(p[2]) * Math.PI) / 180;
      A = C * Math.cos(h);
      B = C * Math.sin(h);
    } else {
      A = num(p[1], 0.4);
      B = num(p[2], 0.4);
    }
    const [r, g, b] = oklabToRgb(L, A, B);
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a };
  }
  m = /^color-mix\(\s*in\s+(srgb|oklab|oklch)\s*,(.*)\)$/.exec(s);
  if (m) {
    const parts = splitTop(m[2]);
    if (parts.length !== 2) return undefined;
    const side = (p: string) => {
      const pm = /^(.*?)\s+([\d.]+)%$/.exec(p.trim());
      return pm ? { c: parseColor(pm[1], current), pct: parseFloat(pm[2]) / 100 } : { c: parseColor(p, current), pct: undefined as number | undefined };
    };
    const x = side(parts[0]);
    const y = side(parts[1]);
    if (!x.c || !y.c) return undefined;
    let p1 = x.pct ?? (y.pct !== undefined ? 1 - y.pct : 0.5);
    let p2 = y.pct ?? 1 - p1;
    const total = p1 + p2;
    const alphaMult = total < 1 ? total : 1;
    p1 /= total;
    p2 /= total;
    // Premultiplied interpolation.
    const a = x.c.a * p1 + y.c.a * p2;
    const conv = (c: RGBA) => (m![1] === "srgb" ? [c.r, c.g, c.b] : rgbToOklab(c.r, c.g, c.b));
    const cx = conv(x.c);
    const cy = conv(y.c);
    const mixed = cx.map((v, i) => (a === 0 ? 0 : (v * x.c!.a * p1 + cy[i] * y.c!.a * p2) / a));
    const [r, g, b] = m[1] === "srgb" ? mixed : oklabToRgb(mixed[0], mixed[1], mixed[2]);
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: a * alphaMult };
  }
  return undefined;
}

export function hexOf(c: RGBA): string {
  const h = (n: number) => Math.round(clamp01(n) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a >= 0.9995 ? "" : h(c.a)}`;
}

/** A color as hex, or undefined. */
export function toHexColor(raw: string, current?: string): string | undefined {
  const c = parseColor(raw, current ? parseColor(current) : undefined);
  return c && hexOf(c);
}

/** Replace every color function / hex inside a paint value (gradient, shadow) with hex. */
export function hexifyColors(value: string, current?: string): string {
  let out = value.replace(/\b(oklch|oklab|rgba?|color-mix)\(/g, "\u0001$1(");
  for (let at = out.indexOf("\u0001"); at >= 0; at = out.indexOf("\u0001")) {
    const open = out.indexOf("(", at);
    const end = closing(out, open);
    const fn = out.slice(at + 1, end + 1).replace(/\u0001/g, "");
    const hex = toHexColor(fn, current);
    out = out.slice(0, at) + (hex ?? fn) + out.slice(end + 1);
  }
  return current ? out.replace(/\bcurrentcolor\b/gi, current) : out;
}
