/**
 * 2D transforms (transform, translate, rotate, scale and transform-origin) as Chromium draws them.
 * A transform never moves another box: it maps the box's border box, and everything inside it, to
 * where it is painted, which is what getBoundingClientRect() reports (the axis-aligned bounding box
 * of the mapped corners). Layout is done first; this only maps rectangles.
 */

/** An affine matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (CSS matrix() order). */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m · n (apply n first, then m). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

/** One length of a transform: px (em and rem already resolved to px), or a percentage of `ref` (the box's own size). */
function length(v: string, ref: number): number | undefined {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|%)?$/i.exec(v.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!m[2]) return n === 0 ? 0 : undefined;
  return m[2] === "%" ? (n / 100) * ref : n;
}

/** An angle in radians (deg, rad, turn, grad; a unitless 0). */
function angle(v: string): number | undefined {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|turn|grad)?$/i.exec(v.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  switch (m[2]?.toLowerCase()) {
    case "deg":
      return (n * Math.PI) / 180;
    case "rad":
      return n;
    case "turn":
      return n * 2 * Math.PI;
    case "grad":
      return (n * Math.PI) / 200;
    default:
      return n === 0 ? 0 : undefined;
  }
}

/** A number, or a percentage as a number (scale(150%)). */
function number(v: string): number | undefined {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%)?$/i.exec(v.trim());
  if (!m) return undefined;
  return parseFloat(m[1]) / (m[2] ? 100 : 1);
}

/**
 * Chromium's rotation: exact for multiples of 90° (no rounding noise in sin/cos), else the
 * double-precision sine and cosine.
 */
function rotation(a: number): Matrix {
  const deg = (a * 180) / Math.PI;
  const q = Math.round(deg / 90);
  if (Math.abs(deg - q * 90) < 1e-9) {
    const k = ((q % 4) + 4) % 4;
    const [c, s] = [[1, 0], [0, 1], [-1, 0], [0, -1]][k];
    return [c, s, -s, c, 0, 0];
  }
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, s, -s, c, 0, 0];
}

/** Split a transform list into its functions: [name, args[]]. undefined when it isn't one. */
function functions(v: string): [string, string[]][] | undefined {
  const s = v.trim();
  if (!s || s === "none") return [];
  const out: [string, string[]][] = [];
  const re = /\s*([a-zA-Z0-9]+)\(([^()]*)\)\s*/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return undefined;
    const args = m[2].includes(",") ? m[2].split(",") : m[2].trim().split(/\s+/);
    out.push([m[1].toLowerCase(), args.map((a) => a.trim()).filter((a) => a !== "")]);
    i = re.lastIndex;
  }
  return out;
}

/**
 * The matrix of a transform list for a box of size w × h (percentages in translations are of it).
 * undefined for what can't be drawn as a 2D affine map without knowing more (3D rotations,
 * perspective, matrix3d) or isn't valid.
 */
export function transformList(v: string, w: number, h: number): Matrix | undefined {
  const fns = functions(v);
  if (!fns) return undefined;
  let m = IDENTITY;
  for (const [name, a] of fns) {
    let f: Matrix | undefined;
    const n = a.length;
    switch (name) {
      case "translate": {
        const x = length(a[0] ?? "", w);
        const y = n > 1 ? length(a[1], h) : 0;
        if (n < 1 || n > 2 || x === undefined || y === undefined) return undefined;
        f = translate(x, y);
        break;
      }
      case "translatex":
      case "translatey": {
        const d = length(a[0] ?? "", name === "translatex" ? w : h);
        if (n !== 1 || d === undefined) return undefined;
        f = name === "translatex" ? translate(d, 0) : translate(0, d);
        break;
      }
      case "translatez":
        // Without perspective a translation along z draws nothing differently.
        if (n !== 1 || length(a[0], 0) === undefined) return undefined;
        f = IDENTITY;
        break;
      case "translate3d": {
        const x = length(a[0] ?? "", w);
        const y = length(a[1] ?? "", h);
        if (n !== 3 || x === undefined || y === undefined || length(a[2], 0) === undefined) return undefined;
        f = translate(x, y);
        break;
      }
      case "scale": {
        const x = number(a[0] ?? "");
        const y = n > 1 ? number(a[1]) : x;
        if (n < 1 || n > 2 || x === undefined || y === undefined) return undefined;
        f = [x, 0, 0, y, 0, 0];
        break;
      }
      case "scalex":
      case "scaley": {
        const s = number(a[0] ?? "");
        if (n !== 1 || s === undefined) return undefined;
        f = name === "scalex" ? [s, 0, 0, 1, 0, 0] : [1, 0, 0, s, 0, 0];
        break;
      }
      case "scale3d": {
        const [x, y, z] = a.map(number);
        if (n !== 3 || x === undefined || y === undefined || z === undefined) return undefined;
        f = [x, 0, 0, y, 0, 0];
        break;
      }
      case "scalez":
        if (n !== 1 || number(a[0]) === undefined) return undefined;
        f = IDENTITY;
        break;
      case "rotate":
      case "rotatez": {
        const r = angle(a[0] ?? "");
        if (n !== 1 || r === undefined) return undefined;
        f = rotation(r);
        break;
      }
      case "skew":
      case "skewx":
      case "skewy": {
        const ax = name === "skewy" ? 0 : angle(a[0] ?? "");
        const ay = name === "skewx" ? 0 : name === "skewy" ? angle(a[0] ?? "") : n > 1 ? angle(a[1]) : 0;
        if (n < 1 || n > (name === "skew" ? 2 : 1) || ax === undefined || ay === undefined) return undefined;
        f = [1, Math.tan(ay), Math.tan(ax), 1, 0, 0];
        break;
      }
      case "matrix": {
        const xs = a.map((x) => (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(x) ? parseFloat(x) : NaN));
        if (n !== 6 || xs.some(isNaN)) return undefined;
        f = xs as Matrix;
        break;
      }
      default:
        return undefined;
    }
    m = multiply(m, f);
  }
  return m;
}

/** transform-origin as a point from the border box's top left corner (default: its center). */
export function originOf(v: string | undefined, w: number, h: number): [number, number] | undefined {
  const parts = (v ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return [w / 2, h / 2];
  if (parts.length > 3) return undefined;
  // A third value (z) moves nothing without perspective.
  if (parts.length === 3 && length(parts[2], 0) === undefined) return undefined;
  const xy = parts.slice(0, 2);
  const X: Record<string, number> = { left: 0, center: 0.5, right: 1 };
  const Y: Record<string, number> = { top: 0, center: 0.5, bottom: 1 };
  // Keywords may come in either order (top left); a lone vertical keyword sets y.
  if (xy.length === 2 && (xy[0] in Y && !(xy[0] in X)) && (xy[1] in X || xy[1] === "center")) xy.reverse();
  if (xy.length === 1 && xy[0] in Y && !(xy[0] in X)) xy.unshift("center");
  const x = xy[0] in X ? X[xy[0]] * w : length(xy[0], w);
  const y = xy.length < 2 ? h / 2 : xy[1] in Y ? Y[xy[1]] * h : length(xy[1], h);
  if (x === undefined || y === undefined) return undefined;
  return [x, y];
}

/** The individual transform properties as transform functions (applied before transform, in this order). */
export function individual(prop: "translate" | "rotate" | "scale", v: string): string | undefined {
  const s = v.trim();
  if (s === "none") return "";
  const parts = s.split(/\s+/);
  if (prop === "translate") return parts.length <= 3 ? (parts.length === 3 ? `translate3d(${parts.join(", ")})` : `translate(${parts.join(", ")})`) : undefined;
  if (prop === "scale") return parts.length <= 3 ? (parts.length === 3 ? `scale3d(${parts.join(", ")})` : `scale(${parts.join(", ")})`) : undefined;
  // rotate: an angle (about z), or an axis and an angle: only z (or 0 0 1) is 2D.
  if (parts.length === 1) return `rotate(${parts[0]})`;
  if (parts.length === 2 && parts[0] === "z") return `rotate(${parts[1]})`;
  if (parts.length === 4 && parseFloat(parts[0]) === 0 && parseFloat(parts[1]) === 0 && parseFloat(parts[2]) > 0) return `rotate(${parts[3]})`;
  // About x or y, or another axis: 3D.
  if (parts.length === 2 && (parts[0] === "x" || parts[0] === "y")) return `rotate${parts[0].toUpperCase()}(${parts[1]})`;
  if (parts.length === 4) return `rotate3d(${parts.join(", ")})`;
  return undefined;
}

/** The matrix that draws a w × h border box with this transform and origin, in its own coordinates (origin at its top left). */
export function boxMatrix(list: string, origin: string | undefined, w: number, h: number): Matrix | undefined {
  const m = transformList(list, w, h);
  const o = originOf(origin, w, h);
  if (!m || !o) return undefined;
  return multiply(multiply(translate(o[0], o[1]), m), translate(-o[0], -o[1]));
}

/** The bounding box of a rectangle mapped by `m`. */
export function mapRect(m: Matrix, x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const pts = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ].map(([px, py]) => [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]]);
  // Chromium maps the quad in float.
  const f = Math.fround;
  const xs = pts.map((p) => f(p[0]));
  const ys = pts.map((p) => f(p[1]));
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

// ---------------------------------------------------------------- 3D

/** A 4×4 matrix, row-major: (x', y', z', w') = M · (x, y, z, w). */
export type Matrix4 = number[];

const I4: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** a · b (apply b first). */
export function multiply4(a: Matrix4, b: Matrix4): Matrix4 {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) out[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return out;
}

export const translate4 = (x: number, y: number, z = 0): Matrix4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const from2d = (m: Matrix): Matrix4 => [m[0], m[2], 0, m[4], m[1], m[3], 0, m[5], 0, 0, 1, 0, 0, 0, 0, 1];
/** perspective(d): a length of at least 1px (smaller ones clamp to it, as Chromium does). */
export const perspective4 = (d: number): Matrix4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1 / Math.max(1, d), 1];

/** rotate3d(x, y, z, a) as the spec builds it from the normalized axis (exact about x, y and z at multiples of 90°). */
function rotate3d(x: number, y: number, z: number, a: number): Matrix4 {
  const len = Math.hypot(x, y, z);
  if (!(len > 0)) return I4;
  [x, y, z] = [x / len, y / len, z / len];
  const r = rotation(a);
  const [c, s] = [r[0], r[1]];
  if (x === 1 && y === 0 && z === 0) return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
  if (x === 0 && y === 1 && z === 0) return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
  if (x === 0 && y === 0 && z === 1) return from2d(r);
  const sc = Math.sin(a / 2) * Math.cos(a / 2);
  const sq = Math.sin(a / 2) ** 2;
  return [
    1 - 2 * (y * y + z * z) * sq, 2 * (x * y * sq - z * sc), 2 * (x * z * sq + y * sc), 0,
    2 * (x * y * sq + z * sc), 1 - 2 * (x * x + z * z) * sq, 2 * (y * z * sq - x * sc), 0,
    2 * (x * z * sq - y * sc), 2 * (y * z * sq + x * sc), 1 - 2 * (x * x + y * y) * sq, 0,
    0, 0, 0, 1,
  ];
}

/**
 * A transform list as a 4×4 matrix for a box of size w × h: the 2D functions, and translateZ,
 * translate3d, scaleZ, scale3d, rotateX, rotateY, rotate3d, perspective() and matrix3d. undefined
 * when it isn't one Cadesa reads.
 */
export function transformList4(v: string, w: number, h: number): Matrix4 | undefined {
  const fns = functions(v);
  if (!fns) return undefined;
  let m = I4;
  for (const [name, a] of fns) {
    let f: Matrix4 | undefined;
    const n = a.length;
    const z = (s: string | undefined) => (s === undefined ? undefined : length(s, 0));
    switch (name) {
      case "translatez": {
        const d = z(a[0]);
        if (n !== 1 || d === undefined) return undefined;
        f = translate4(0, 0, d);
        break;
      }
      case "translate3d": {
        const x = length(a[0] ?? "", w);
        const y = length(a[1] ?? "", h);
        const d = z(a[2]);
        if (n !== 3 || x === undefined || y === undefined || d === undefined) return undefined;
        f = translate4(x, y, d);
        break;
      }
      case "scalez": {
        const s = number(a[0] ?? "");
        if (n !== 1 || s === undefined) return undefined;
        f = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
        break;
      }
      case "scale3d": {
        const [x, y, s] = a.map(number);
        if (n !== 3 || x === undefined || y === undefined || s === undefined) return undefined;
        f = [x, 0, 0, 0, 0, y, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
        break;
      }
      case "rotatex":
      case "rotatey": {
        const r = angle(a[0] ?? "");
        if (n !== 1 || r === undefined) return undefined;
        f = name === "rotatex" ? rotate3d(1, 0, 0, r) : rotate3d(0, 1, 0, r);
        break;
      }
      case "rotate3d": {
        const xs = a.slice(0, 3).map(number);
        const r = angle(a[3] ?? "");
        if (n !== 4 || xs.some((x) => x === undefined) || r === undefined) return undefined;
        f = rotate3d(xs[0]!, xs[1]!, xs[2]!, r);
        break;
      }
      case "perspective": {
        if (n !== 1) return undefined;
        if (a[0] === "none") f = I4;
        else {
          const d = length(a[0], 0);
          if (d === undefined || d < 0) return undefined;
          f = perspective4(d);
        }
        break;
      }
      case "matrix3d": {
        const xs = a.map((x) => (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(x) ? parseFloat(x) : NaN));
        if (n !== 16 || xs.some(isNaN)) return undefined;
        // Column-major in CSS.
        f = [0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => xs[c * 4 + r]));
        break;
      }
      default: {
        const two = transformList(`${name}(${a.join(", ")})`, w, h);
        if (!two) return undefined;
        f = from2d(two);
      }
    }
    m = multiply4(m, f);
  }
  return m;
}

/** transform-origin with its z (a length): from the border box's top left corner. */
export function originOf3(v: string | undefined, w: number, h: number): [number, number, number] | undefined {
  const parts = (v ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length > 3) return undefined;
  const xy = originOf(parts.slice(0, 2).join(" ") || undefined, w, h);
  const zv = parts.length === 3 ? length(parts[2], 0) : 0;
  if (!xy || zv === undefined) return undefined;
  return [xy[0], xy[1], zv];
}

/** The 4×4 matrix that draws a w × h border box with this transform and origin, in its own coordinates. */
export function boxMatrix4(list: string, origin: string | undefined, w: number, h: number): Matrix4 | undefined {
  const m = transformList4(list, w, h);
  const o = originOf3(origin, w, h);
  if (!m || !o) return undefined;
  return multiply4(multiply4(translate4(o[0], o[1], o[2]), m), translate4(-o[0], -o[1], -o[2]));
}

/**
 * Map a point (on the z = 0 plane) through each matrix in turn, flattening after each (dividing by
 * w, dropping z), as Chromium maps a box's quad to the page with transform-style: flat. undefined
 * when a point ends up behind the viewer (w ≤ 0: Chromium clips the quad there).
 */
export function project(chain: Matrix4[], x: number, y: number): [number, number] | undefined {
  for (const m of chain) {
    const X = m[0] * x + m[1] * y + m[3];
    const Y = m[4] * x + m[5] * y + m[7];
    const W = m[12] * x + m[13] * y + m[15];
    if (!(W > 1e-9)) return undefined;
    [x, y] = [X / W, Y / W];
  }
  return [x, y];
}

/** The bounding box of a rectangle mapped by `chain` (see project); undefined when it is clipped. */
export function projectRect(chain: Matrix4[], x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } | undefined {
  const pts = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ].map(([px, py]) => project(chain, px, py));
  if (pts.some((p) => !p)) return undefined;
  // Chromium maps the quad in float.
  const f = Math.fround;
  const xs = pts.map((p) => f(p![0]));
  const ys = pts.map((p) => f(p![1]));
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}
