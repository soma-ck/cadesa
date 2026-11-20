/**
 * CSS Grid: templates, placement and the track sizing algorithm (CSS Grid 1 §7–§12), as Chromium
 * runs it. Pure functions: the engine (layout.ts) measures items and calls these.
 *
 *   - Track lists: lengths (px, %), <n>fr, auto, min-content, max-content, minmax(), fit-content(),
 *     repeat(<n>, …), repeat(auto-fill | auto-fit, …) of fixed tracks, and [line names].
 *   - grid-template-areas, and placement by line number (negative too), span, line name or area.
 *   - Auto-placement in row order (sparse or dense).
 *   - Track sizing in layout units (1/64 px): intrinsic sizes from the items spanning each track
 *     (span 1 first, then wider spans), maximizing, flexible tracks, stretching auto tracks.
 */
import type { Pct } from "../resolve.js";
import { sizeAt } from "../resolve.js";

/** One side of a track size. */
export type Breadth = { len: number | Pct } | { fr: number } | "auto" | "min-content" | "max-content";
/** A track: minmax(min, max); fit-content(L) is max-content capped at L (min auto). */
export interface TrackSize {
  min: Breadth;
  max: Breadth;
  fit?: number | Pct;
}
export interface TrackList {
  tracks: TrackSize[];
  /** Names of each line (tracks.length + 1 of them). */
  names: string[][];
  /** repeat(auto-fill | auto-fit, …): its tracks and names, repeated at index `at`. */
  repeat?: { type: "auto-fill" | "auto-fit"; at: number; tracks: TrackSize[]; names: string[][] };
}

/** One end of an item's placement: auto, a line (number, maybe with a name: "2 foo" is the 2nd line named foo), a span, or a name. */
export type Line = { auto: true } | { n: number; name?: string } | { span: number; name?: string } | { name: string };
export interface LinePair {
  start: Line;
  end: Line;
}

// ---------------------------------------------------------------- parsing

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;
const isIdent = (s: string) => /^-?[a-zA-Z_][\w-]*$/.test(s) && !/^(span|auto|inherit|initial|unset|default)$/i.test(s);

/** Top-level tokens: words and functions with their arguments, and [names] groups. */
function tokens(s: string): string[] | undefined {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let bracket = false;
  for (const ch of s.trim()) {
    if (ch === "[" && depth === 0) {
      if (cur) out.push(cur);
      cur = "[";
      bracket = true;
      continue;
    }
    if (ch === "]" && bracket) {
      out.push(`${cur}]`);
      cur = "";
      bracket = false;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0) return undefined;
    if (/\s/.test(ch) && depth === 0 && !bracket) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (depth || bracket) return undefined;
  if (cur) out.push(cur);
  return out;
}

/** A track breadth: a length (px or %), <n>fr, auto, min-content or max-content. */
function breadth(s: string, allowFr: boolean): Breadth | undefined {
  const t = s.trim().toLowerCase();
  if (t === "auto" || t === "min-content" || t === "max-content") return t;
  const fr = new RegExp(`^(${NUM})fr$`).exec(t);
  if (fr) return allowFr && parseFloat(fr[1]) >= 0 ? { fr: parseFloat(fr[1]) } : undefined;
  const len = new RegExp(`^(${NUM})(px|%)?$`).exec(t);
  if (len) {
    const n = parseFloat(len[1]);
    if (n < 0 || (!len[2] && n !== 0)) return undefined;
    return { len: len[2] === "%" ? { pct: n } : n };
  }
  return undefined;
}

/** A track size: a breadth, minmax(a, b) or fit-content(L). */
export function trackSize(s: string): TrackSize | undefined {
  const t = s.trim().toLowerCase();
  const mm = /^minmax\((.*)\)$/.exec(t);
  if (mm) {
    const parts = mm[1].split(",");
    if (parts.length !== 2) return undefined;
    const min = breadth(parts[0], false);
    const max = breadth(parts[1], true);
    return min && max ? { min, max } : undefined;
  }
  const fc = /^fit-content\((.*)\)$/.exec(t);
  if (fc) {
    const b = breadth(fc[1], false);
    return b && typeof b === "object" && "len" in b ? { min: "auto", max: "max-content", fit: b.len } : undefined;
  }
  const b = breadth(t, true);
  if (!b) return undefined;
  // <n>fr alone is minmax(auto, <n>fr).
  return typeof b === "object" && "fr" in b ? { min: "auto", max: b } : { min: b, max: b };
}

/** A track list (grid-template-columns / -rows, or grid-auto-*), or undefined when Cadesa can't read it. */
export function parseTrackList(s: string): TrackList | undefined {
  const toks = tokens(s);
  if (!toks || !toks.length) return undefined;
  if (toks.length === 1 && toks[0].toLowerCase() === "none") return { tracks: [], names: [[]] };
  const out: TrackList = { tracks: [], names: [[]] };
  const lastNames = () => out.names[out.names.length - 1];
  for (const tok of toks) {
    if (tok.startsWith("[")) {
      const names = tok.slice(1, -1).trim().split(/\s+/).filter(Boolean);
      if (!names.every(isIdent)) return undefined;
      lastNames().push(...names);
      continue;
    }
    const rep = /^repeat\((.*)\)$/is.exec(tok);
    if (rep) {
      const comma = rep[1].indexOf(",");
      if (comma < 0) return undefined;
      const count = rep[1].slice(0, comma).trim().toLowerCase();
      const inner = parseTrackList(rep[1].slice(comma + 1));
      if (!inner || !inner.tracks.length || inner.repeat) return undefined;
      if (count === "auto-fill" || count === "auto-fit") {
        if (out.repeat) return undefined;
        // Only fixed sizes (a length, or minmax with a length on one side) can repeat to fill.
        const fixed = (b: Breadth) => typeof b === "object" && "len" in b;
        if (!inner.tracks.every((t) => (fixed(t.min) || fixed(t.max)) && !t.fit && !(typeof t.min === "object" && "fr" in t.min))) return undefined;
        // names[at] holds the names before the repeat; a new entry collects the names after it.
        out.repeat = { type: count, at: out.tracks.length, tracks: inner.tracks, names: inner.names };
        out.names.push([]);
        continue;
      }
      const n = /^\d+$/.test(count) ? parseInt(count) : NaN;
      if (!(n >= 1 && n <= 1000)) return undefined;
      for (let i = 0; i < n; i++) {
        lastNames().push(...inner.names[0]);
        inner.tracks.forEach((t, k) => {
          out.tracks.push(t);
          out.names.push([...inner.names[k + 1]]);
        });
      }
      continue;
    }
    const t = trackSize(tok);
    if (!t) return undefined;
    out.tracks.push(t);
    out.names.push([]);
  }
  return out.tracks.length || out.repeat ? out : undefined;
}

/**
 * The explicit tracks of a list, with repeat(auto-fill | auto-fit) expanded for `available` px (the
 * content box, when definite: as many repetitions as fit, at least one). `collapse`: for auto-fit,
 * the indices of the repeated tracks (empty ones collapse after placement).
 */
export function expandTracks(l: TrackList, available: number | undefined, gap: number): { tracks: TrackSize[]; names: string[][]; autoFit?: number[] } {
  if (!l.repeat) return { tracks: l.tracks, names: l.names };
  const r = l.repeat;
  const size = (t: TrackSize, b: number) => {
    const fixed = (x: Breadth) => (typeof x === "object" && "len" in x ? sizeAt(x.len, b) : undefined);
    // The max size when it is a length, else the min (CSS Grid §7.2.3.2).
    return fixed(t.max) ?? fixed(t.min) ?? 0;
  };
  let reps = 1;
  if (available !== undefined) {
    const others = l.tracks.reduce((s, t) => s + size(t, available), 0) + gap * Math.max(0, l.tracks.length);
    const one = r.tracks.reduce((s, t) => s + Math.max(1, size(t, available)), 0) + gap * r.tracks.length;
    reps = Math.max(1, Math.floor((available - others + gap) / one + 1e-9));
    reps = Math.min(reps, 1000);
  }
  // l.names: the lines before the repeat (names[at] is where it starts), then one entry for the
  // line after it, then one after each remaining track.
  const tracks: TrackSize[] = l.tracks.slice(0, r.at);
  const names: string[][] = l.names.slice(0, r.at).map((x) => [...x]);
  const fit: number[] = [];
  const m = r.tracks.length;
  let line = [...l.names[r.at]];
  for (let k = 0; k < reps; k++) {
    for (let j = 0; j < m; j++) {
      line.push(...r.names[j]);
      names.push(line);
      line = [];
      if (r.type === "auto-fit") fit.push(tracks.length);
      tracks.push(r.tracks[j]);
    }
    line.push(...r.names[m]);
  }
  line.push(...l.names[r.at + 1]);
  names.push(line);
  for (let i = r.at; i < l.tracks.length; i++) {
    tracks.push(l.tracks[i]);
    names.push([...l.names[i + 2]]);
  }
  return { tracks, names, ...(r.type === "auto-fit" && { autoFit: fit }) };
}

/** grid-template-areas: each named area's rows and columns (0-based lines), or undefined when invalid. */
export function parseAreas(rows: string[]): { rows: number; cols: number; areas: Map<string, { r0: number; r1: number; c0: number; c1: number }> } | undefined {
  const grid = rows.map((r) => r.trim().split(/\s+/).map((c) => (/^\.+$/.test(c) ? "." : c)));
  const cols = grid[0]?.length ?? 0;
  if (!cols || grid.some((r) => r.length !== cols)) return undefined;
  const areas = new Map<string, { r0: number; r1: number; c0: number; c1: number }>();
  grid.forEach((row, r) =>
    row.forEach((name, c) => {
      if (name === ".") return;
      const a = areas.get(name);
      if (!a) areas.set(name, { r0: r, r1: r + 1, c0: c, c1: c + 1 });
      else {
        a.r1 = Math.max(a.r1, r + 1);
        a.c1 = Math.max(a.c1, c + 1);
      }
    }),
  );
  // Each area must be a filled rectangle.
  for (const [name, a] of areas) for (let r = a.r0; r < a.r1; r++) for (let c = a.c0; c < a.c1; c++) if (grid[r][c] !== name) return undefined;
  return { rows: grid.length, cols, areas };
}

/** One grid line spec: auto, <integer> [<name>], span <integer> [<name>], <name>. */
export function parseLine(s: string): Line | undefined {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return undefined;
  if (words.length === 1 && words[0].toLowerCase() === "auto") return { auto: true };
  let span = false;
  let n: number | undefined;
  let name: string | undefined;
  for (const w of words) {
    if (w.toLowerCase() === "span" && !span) span = true;
    else if (/^[+-]?\d+$/.test(w) && n === undefined) n = parseInt(w);
    else if (isIdent(w) && name === undefined) name = w;
    else return undefined;
  }
  if (span) {
    if (n !== undefined && n < 1) return undefined;
    return { span: n ?? 1, ...(name && { name }) };
  }
  if (n !== undefined) return n === 0 ? undefined : { n, ...(name && { name }) };
  return name ? { name } : undefined;
}

/** grid-row / grid-column: "<start> [/ <end>]". A lone name is that area's (or line's) both ends. */
export function parseLinePair(s: string): LinePair | undefined {
  const parts = s.split("/");
  if (parts.length > 2) return undefined;
  const start = parseLine(parts[0]);
  if (!start) return undefined;
  const end = parts.length > 1 ? parseLine(parts[1]) : "name" in start && !("n" in start) && !("span" in start) ? { name: start.name } : { auto: true as const };
  return end ? { start, end } : undefined;
}

/** grid-area: "<row-start> / <column-start> / <row-end> / <column-end>" (missing ends as CSS fills them). */
export function parseArea(s: string): { row: LinePair; column: LinePair } | undefined {
  const parts = s.split("/").map((p) => parseLine(p));
  if (!parts.length || parts.length > 4 || parts.some((p) => !p)) return undefined;
  const [rs, cs, re, ce] = parts as Line[];
  const named = (l: Line | undefined, other: Line): Line => l ?? ("name" in other && !("n" in other) && !("span" in other) ? { name: other.name } : { auto: true });
  const c0 = named(cs, rs);
  return { row: { start: rs, end: named(re, rs) }, column: { start: c0, end: named(ce, c0) } };
}

// ---------------------------------------------------------------- placement

export interface Area {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** The explicit grid's lines: names per line, per axis, and the named areas. */
export interface Explicit {
  cols: number;
  rows: number;
  colNames: string[][];
  rowNames: string[][];
  areas?: Map<string, Area>;
}

/**
 * Place every item by grid-auto-flow: row flow (place), or column flow, which is row flow with the
 * axes swapped (CSS Grid §8.5 swaps "row" and "column" for it).
 */
export function placeFlow(ex: Explicit, items: { row: LinePair; column: LinePair }[], dense: boolean, column: boolean): ReturnType<typeof place> {
  if (!column) return place(ex, items, dense);
  const areas = ex.areas && new Map([...ex.areas].map(([n, a]) => [n, { r0: a.c0, r1: a.c1, c0: a.r0, c1: a.r1 }] as const));
  const t = place({ cols: ex.rows, rows: ex.cols, colNames: ex.rowNames, rowNames: ex.colNames, ...(areas && { areas }) }, items.map((it) => ({ row: it.column, column: it.row })), dense);
  if ("why" in t) return t;
  return { areas: t.areas.map((a) => ({ r0: a.c0, r1: a.c1, c0: a.r0, c1: a.r1 })), rows: t.cols, cols: t.rows, rowOffset: t.colOffset, colOffset: t.rowOffset };
}

/**
 * Place every item (CSS Grid §8.5, row flow): items with a definite row and column first, then
 * those locked to a row, then the rest by the auto-placement cursor. Returns each item's area
 * (0-based lines, possibly in implicit tracks before the explicit grid: `offset` rows/columns were
 * added there) and the grid's size, or a reason it isn't modelled.
 */
export function place(ex: Explicit, items: { row: LinePair; column: LinePair }[], dense: boolean): { areas: Area[]; rows: number; cols: number; rowOffset: number; colOffset: number } | { why: string } {
  type R = { a: number; b: number } | { span: number };
  const resolve = (p: LinePair, axis: "row" | "col"): R | { why: string } => {
    const count = axis === "row" ? ex.rows : ex.cols;
    const names = axis === "row" ? ex.rowNames : ex.colNames;
    // A named line: an explicit name, or an area's implicit <area>-start / <area>-end.
    const named = (name: string, k: number, side: "start" | "end"): number | undefined => {
      const lines: number[] = [];
      for (let i = 0; i <= count; i++) {
        const own = names[i] ?? [];
        const areaLine = ex.areas && [...ex.areas].some(([n, a]) => (`${n}-start` === name && (axis === "row" ? a.r0 : a.c0) === i) || (`${n}-end` === name && (axis === "row" ? a.r1 : a.c1) === i));
        if (own.includes(name) || areaLine) lines.push(i);
      }
      if (!lines.length) return undefined;
      if (k > 0) return lines[k - 1];
      if (k < 0) return lines[lines.length + k];
      return side === "start" ? lines[0] : lines[0];
    };
    const line = (l: Line, side: "start" | "end"): number | undefined | "span" | "auto" | { why: string } => {
      if ("auto" in l) return "auto";
      if ("span" in l) return "span";
      if ("n" in l) {
        if (l.name) {
          const v = named(l.name, l.n, side);
          return v === undefined ? { why: `the grid line "${l.n} ${l.name}" isn't in the explicit grid` } : v;
        }
        return l.n > 0 ? l.n - 1 : count + 1 + l.n;
      }
      // A name: its area's start or end line, else the first line of that name.
      const v = named(`${l.name}-${side}`, 1, side) ?? named(l.name, 1, side);
      return v === undefined ? { why: `the grid line or area "${l.name}" isn't in the explicit grid` } : v;
    };
    const s = line(p.start, "start");
    const e = line(p.end, "end");
    if (typeof s === "object") return s;
    if (typeof e === "object") return e;
    const spanOf = (l: Line) => ("span" in l ? l : undefined);
    if ((spanOf(p.start)?.name || spanOf(p.end)?.name)) return { why: "a span to a named line isn't modelled" };
    if (typeof s === "number" && typeof e === "number") return s === e ? { a: s, b: s + 1 } : { a: Math.min(s, e), b: Math.max(s, e) };
    if (typeof s === "number") return { a: s, b: s + (e === "span" ? spanOf(p.end)!.span : 1) };
    if (typeof e === "number") {
      const n = s === "span" ? spanOf(p.start)!.span : 1;
      return { a: e - n, b: e };
    }
    // Both auto (or spans): auto-placed, spanning the start's span (an end span alone too).
    return { span: s === "span" ? spanOf(p.start)!.span : e === "span" ? spanOf(p.end)!.span : 1 };
  };
  const rs: R[] = [];
  const cs: R[] = [];
  for (const it of items) {
    const r = resolve(it.row, "row");
    const c = resolve(it.column, "col");
    if ("why" in r) return r;
    if ("why" in c) return c;
    rs.push(r);
    cs.push(c);
  }
  // Implicit tracks before the explicit grid (a line before the first): shift everything after.
  const rowOffset = Math.max(0, ...rs.map((r) => ("a" in r ? -r.a : 0)));
  const colOffset = Math.max(0, ...cs.map((c) => ("a" in c ? -c.a : 0)));
  const shift = (x: R, o: number): R => ("a" in x ? { a: x.a + o, b: x.b + o } : x);
  for (let i = 0; i < items.length; i++) {
    rs[i] = shift(rs[i], rowOffset);
    cs[i] = shift(cs[i], colOffset);
  }
  let cols = Math.max(ex.cols + colOffset, ...cs.map((c) => ("a" in c ? c.b : c.span)));
  let rows = Math.max(ex.rows + rowOffset, ...rs.map((r) => ("a" in r ? r.b : 0)));
  const occupied: boolean[][] = [];
  const free = (a: Area) => {
    for (let r = a.r0; r < a.r1; r++) for (let c = a.c0; c < a.c1; c++) if (occupied[r]?.[c]) return false;
    return true;
  };
  const take = (a: Area) => {
    for (let r = a.r0; r < a.r1; r++) for (let c = a.c0; c < a.c1; c++) (occupied[r] ??= [])[c] = true;
    rows = Math.max(rows, a.r1);
    cols = Math.max(cols, a.c1);
  };
  const areas: (Area | undefined)[] = items.map(() => undefined);
  // 1. Definite row and column.
  items.forEach((_, i) => {
    const r = rs[i];
    const c = cs[i];
    if ("a" in r && "a" in c) take((areas[i] = { r0: r.a, r1: r.b, c0: c.a, c1: c.b }));
  });
  // 2. Locked to a row: the first columns that are free (sparse: after the last one placed in that row).
  const rowCursor = new Map<number, number>();
  items.forEach((_, i) => {
    const r = rs[i];
    const c = cs[i];
    if (!("a" in r) || "a" in c) return;
    const span = c.span;
    let start = dense ? 0 : rowCursor.get(r.a) ?? 0;
    for (; ; start++) {
      const a = { r0: r.a, r1: r.b, c0: start, c1: start + span };
      if (free(a)) {
        take((areas[i] = a));
        rowCursor.set(r.a, a.c1);
        break;
      }
    }
  });
  // 3. The rest: the cursor walks rows, columns within them.
  let cr = 0;
  let cc = 0;
  items.forEach((_, i) => {
    if (areas[i]) return;
    const r = rs[i] as { span: number };
    const c = cs[i];
    if (dense) {
      cr = 0;
      cc = 0;
    }
    if ("a" in c) {
      // A definite column: move to it (the next row if that's behind the cursor), down until it fits.
      if (!dense && c.a < cc) cr++;
      cc = c.a;
      for (; ; cr++) {
        const a = { r0: cr, r1: cr + r.span, c0: c.a, c1: c.b };
        if (free(a)) {
          take((areas[i] = a));
          break;
        }
      }
      return;
    }
    for (;;) {
      if (cc + c.span > cols) {
        cr++;
        cc = 0;
        continue;
      }
      const a = { r0: cr, r1: cr + r.span, c0: cc, c1: cc + c.span };
      if (free(a)) {
        take((areas[i] = a));
        cc = a.c1;
        break;
      }
      cc++;
    }
  });
  return { areas: areas as Area[], rows, cols, rowOffset, colOffset };
}

// ---------------------------------------------------------------- track sizing

/** An item's sizes along one axis (outer: margins included), px. */
export interface Contribution {
  /** First and last+1 track it spans. */
  a: number;
  b: number;
  minContent: number;
  maxContent: number;
  /** Its minimum contribution (the automatic minimum: min-content, or 0 for a scroll container; or its min size). */
  minimum: number;
  /** Its minimum contribution when it spans several tracks, a flexible one among them: no automatic minimum (its padding, border and margins). */
  minimumSpanningFlex?: number;
}

const LU = (px: number) => Math.round(px * 64);
const PXU = (u: number) => u / 64;

/**
 * Size the tracks of one axis (CSS Grid §12.3–§12.8). `available`: the content box size when
 * definite, else "min-content" or "max-content" (sizing the grid to its content). `stretch`:
 * auto tracks share leftover space (align/justify-content normal or stretch). Returns each
 * track's size in px (whole layout units).
 */
export function sizeTracks(tracks: TrackSize[], items: Contribution[], gap: number, available: number | "min-content" | "max-content", stretch: boolean): number[] {
  const n = tracks.length;
  const definite = typeof available === "number";
  const g = LU(gap);
  // Percentages of an indefinite size behave as auto.
  const norm = (b: Breadth): Breadth => (typeof b === "object" && "len" in b ? (typeof b.len === "number" ? b : definite ? { len: sizeAt(b.len, available as number) } : "auto") : b);
  const ts = tracks.map((t) => ({ min: norm(t.min), max: norm(t.max), fit: t.fit === undefined ? undefined : typeof t.fit === "number" ? t.fit : definite ? sizeAt(t.fit, available as number) : undefined }));
  const isLen = (b: Breadth): b is { len: number } => typeof b === "object" && "len" in b;
  const isFr = (b: Breadth): b is { fr: number } => typeof b === "object" && "fr" in b;
  const flexible = ts.map((t) => isFr(t.max));
  const base = ts.map((t) => (isLen(t.min) ? LU(t.min.len) : 0));
  const limit = ts.map((t, i) => (isLen(t.max) ? Math.max(LU(t.max.len), base[i]) : Infinity));
  const intrinsicMin = (t: (typeof ts)[number]) => !isLen(t.min);
  const intrinsicMax = (t: (typeof ts)[number]) => !isLen(t.max) && !isFr(t.max);
  // Under a min-content constraint an auto minimum takes the items' min-content; under max-content their max-content (limited).
  const minOf = (it: Contribution) => (available === "max-content" ? it.maxContent : available === "min-content" ? it.minContent : it.minimum);
  const spansFlex = (it: Contribution) => flexible.slice(it.a, it.b).some(Boolean);
  const gapsIn = (it: Contribution) => g * (it.b - it.a - 1);

  // §12.5 step 2: items spanning one track (not a flexible one).
  for (let i = 0; i < n; i++) {
    const t = ts[i];
    const its = items.filter((it) => it.a === i && it.b === i + 1);
    if (!its.length || flexible[i]) continue;
    if (t.min === "min-content") base[i] = Math.max(base[i], ...its.map((it) => LU(it.minContent)));
    else if (t.min === "max-content") base[i] = Math.max(base[i], ...its.map((it) => LU(it.maxContent)));
    else if (t.min === "auto") base[i] = Math.max(base[i], ...its.map((it) => LU(minOf(it))));
    if (t.max === "min-content") limit[i] = Math.max(isFinite(limit[i]) ? limit[i] : 0, ...its.map((it) => LU(it.minContent)));
    else if (t.max === "max-content" || t.max === "auto") {
      let l = Math.max(...its.map((it) => LU(it.maxContent)));
      if (t.fit !== undefined) l = Math.min(l, Math.max(LU(t.fit), base[i]));
      limit[i] = Math.max(isFinite(limit[i]) ? limit[i] : 0, l);
    }
    if (limit[i] < base[i]) limit[i] = base[i];
  }
  // A fit-content() track no item reaches: its growth limit is still capped by its argument.

  /** §12.5.1: distribute an item's extra space to `affected` tracks' base sizes or growth limits. */
  const distribute = (group: Contribution[], affected: (i: number) => boolean, size: (it: Contribution) => number, target: "base" | "limit", beyond: (i: number) => boolean) => {
    const planned = new Array(n).fill(0);
    for (const it of group) {
      const span = Array.from({ length: it.b - it.a }, (_, k) => it.a + k);
      const aff = span.filter(affected);
      if (!aff.length) continue;
      const cur = (i: number) => (target === "base" ? base[i] : isFinite(limit[i]) ? limit[i] : base[i]);
      let extra = LU(size(it)) - span.reduce((s, i) => s + cur(i), 0) - gapsIn(it);
      if (extra <= 0) continue;
      const inc = new Map<number, number>(aff.map((i) => [i, 0]));
      // Up to each track's limit (base sizes: its growth limit; growth limits: none for an infinitely
      // growable track, its own for any other, so it takes nothing until they are all frozen).
      const cap = (i: number) => (target === "base" ? (isFinite(limit[i]) ? limit[i] - base[i] : Infinity) : growable.has(i) ? (fitCap(i) ?? Infinity) - cur(i) : 0);
      const share = (list: number[], capped: boolean) => {
        let open = list.filter((i) => !capped || inc.get(i)! < cap(i));
        while (extra > 0 && open.length) {
          const each = Math.floor(extra / open.length);
          // Spread the remainder one unit at a time (layout units can't be split further).
          let rem = extra - each * open.length;
          const next: number[] = [];
          let given = 0;
          for (const i of open) {
            let want = each + (rem > 0 ? 1 : 0);
            if (rem > 0) rem--;
            if (capped) want = Math.min(want, cap(i) - inc.get(i)!);
            inc.set(i, inc.get(i)! + want);
            given += want;
            if (!capped || inc.get(i)! < cap(i)) next.push(i);
          }
          extra -= given;
          if (!given) break;
          open = capped ? next : [];
          if (!capped) break;
        }
      };
      share(aff, true);
      if (extra > 0) {
        const more = aff.filter(beyond);
        share(more.length ? more : target === "base" ? aff : [], false);
      }
      for (const [i, v] of inc) planned[i] = Math.max(planned[i], v);
    }
    for (let i = 0; i < n; i++) {
      if (!planned[i]) continue;
      if (target === "base") base[i] += planned[i];
      else limit[i] = (isFinite(limit[i]) ? limit[i] : base[i]) + planned[i];
    }
  };
  const fitCap = (i: number) => (ts[i].fit !== undefined ? Math.max(LU(ts[i].fit!), base[i]) : undefined);
  let growable = new Set<number>();

  // §12.5 step 3: spanning items that cross no flexible track, by span size.
  const spans = [...new Set(items.filter((it) => it.b - it.a > 1 && !spansFlex(it)).map((it) => it.b - it.a))].sort((a, b) => a - b);
  for (const s of spans) {
    const group = items.filter((it) => it.b - it.a === s && !spansFlex(it));
    distribute(group, (i) => intrinsicMin(ts[i]), minOf, "base", (i) => intrinsicMax(ts[i]));
    distribute(group, (i) => ts[i].min === "min-content" || ts[i].min === "max-content", (it) => it.minContent, "base", (i) => intrinsicMax(ts[i]));
    distribute(group, (i) => ts[i].min === "max-content" || (ts[i].min === "auto" && available === "max-content"), (it) => it.maxContent, "base", (i) => ts[i].max === "max-content" || ts[i].max === "auto");
    for (let i = 0; i < n; i++) if (limit[i] < base[i]) limit[i] = base[i];
    // Infinitely growable (§12.5.1): a growth limit still infinite, or one this step made finite for the next.
    growable = new Set(Array.from({ length: n }, (_, i) => i).filter((i) => !isFinite(limit[i])));
    const wasInfinite = new Set(growable);
    distribute(group, (i) => intrinsicMax(ts[i]), (it) => it.minContent, "limit", () => true);
    growable = new Set([...wasInfinite, ...Array.from({ length: n }, (_, i) => i).filter((i) => !isFinite(limit[i]))]);
    distribute(group, (i) => ts[i].max === "max-content" || ts[i].max === "auto", (it) => it.maxContent, "limit", () => true);
  }
  // §12.5 step 4: items crossing flexible tracks give their minimum to the flexible tracks' base sizes, in proportion to their flex factors.
  for (const it of items.filter(spansFlex)) {
    const span = Array.from({ length: it.b - it.a }, (_, k) => it.a + k);
    const flex = span.filter((i) => flexible[i] && intrinsicMin(ts[i]));
    if (!flex.length) continue;
    // (An item spanning more than one track, a flexible one among them, has no automatic minimum: only its padding and border.)
    const min = it.b - it.a > 1 ? (it.minimumSpanningFlex ?? it.minimum) : it.minimum;
    let extra = LU(min) - span.reduce((s, i) => s + base[i], 0) - gapsIn(it);
    if (extra <= 0) continue;
    const sum = flex.reduce((s, i) => s + (ts[i].max as { fr: number }).fr, 0);
    if (flex.length === 1) {
      base[flex[0]] += extra;
      continue;
    }
    // Equal shares when the factors add up to nothing.
    let acc = 0;
    let prev = 0;
    for (const i of flex) {
      acc += sum > 0 ? (ts[i].max as { fr: number }).fr : 1;
      const edge = Math.floor((acc / (sum > 0 ? sum : flex.length)) * extra + 1e-6);
      base[i] += edge - prev;
      prev = edge;
    }
    extra = 0;
  }
  // §12.5 step 5: growth limits still infinite become the base size.
  for (let i = 0; i < n; i++) {
    if (!isFinite(limit[i])) limit[i] = base[i];
    if (ts[i].fit !== undefined) limit[i] = Math.max(base[i], Math.min(limit[i], LU(ts[i].fit!)));
    if (limit[i] < base[i]) limit[i] = base[i];
  }
  const used = () => base.reduce((s, x) => s + x, 0) + g * Math.max(0, n - 1);

  // §12.6: maximize tracks (non-flexible ones, up to their growth limits).
  if (available === "max-content") {
    for (let i = 0; i < n; i++) if (!flexible[i]) base[i] = limit[i];
  } else if (definite) {
    let free = LU(available as number) - used();
    let open = Array.from({ length: n }, (_, i) => i).filter((i) => !flexible[i] && limit[i] > base[i]);
    while (free > 0 && open.length) {
      const each = Math.floor(free / open.length);
      if (!each) break;
      let given = 0;
      for (const i of open) {
        const v = Math.min(each, limit[i] - base[i]);
        base[i] += v;
        given += v;
      }
      free -= given;
      open = open.filter((i) => limit[i] > base[i]);
    }
  }

  // §12.7: flexible tracks.
  const flexIdx = Array.from({ length: n }, (_, i) => i).filter((i) => flexible[i]);
  if (flexIdx.length && available !== "min-content") {
    const fr = (i: number) => (ts[i].max as { fr: number }).fr;
    if (definite) {
      // Find the size of an fr (§12.7.1): tracks whose base size beats their share are inflexible.
      const space = LU(available as number) - g * Math.max(0, n - 1);
      const flex = new Set(flexIdx);
      let leftover = 0;
      let sumFr = 0;
      for (;;) {
        leftover = space - base.reduce((s, x, i) => s + (flex.has(i) ? 0 : x), 0);
        sumFr = [...flex].reduce((s, i) => s + fr(i), 0);
        const size = leftover / Math.max(1, sumFr);
        const frozen = [...flex].filter((i) => base[i] > size * fr(i) + 1e-6);
        if (!frozen.length) break;
        for (const i of frozen) flex.delete(i);
      }
      // Each flexible track ends at floor(its cumulative fraction × the space), so the shares add up.
      let acc = 0;
      let prev = 0;
      for (const i of [...flex].sort((a, b) => a - b)) {
        acc += fr(i);
        const edge = sumFr >= 1 ? Math.floor((acc / sumFr) * Math.max(0, leftover) + 1e-6) : Math.floor(acc * Math.max(0, leftover) + 1e-6);
        base[i] = Math.max(base[i], edge - prev);
        prev = edge;
      }
    } else {
      // An indefinite size: the fr is the largest of each flexible track's base per fr, and of each
      // item's max-content contribution shared over the flexible tracks it spans.
      let size = 0;
      for (const i of flexIdx) size = Math.max(size, fr(i) > 1 ? base[i] / fr(i) : base[i]);
      for (const it of items.filter(spansFlex)) {
        const span = Array.from({ length: it.b - it.a }, (_, k) => it.a + k);
        const fixed = span.filter((i) => !flexible[i]).reduce((s, i) => s + base[i], 0);
        const sum = span.filter((i) => flexible[i]).reduce((s, i) => s + fr(i), 0);
        size = Math.max(size, (LU(it.maxContent) - fixed - gapsIn(it)) / Math.max(1, sum));
      }
      for (const i of flexIdx) base[i] = Math.max(base[i], Math.floor(size * fr(i) + 1e-6));
    }
  }

  // §12.8: auto tracks share what is left (equal shares, each ending at floor of its cumulative share).
  if (stretch && definite) {
    const free = LU(available as number) - used();
    const autos = Array.from({ length: n }, (_, i) => i).filter((i) => ts[i].max === "auto");
    if (free > 0 && autos.length) {
      let prev = 0;
      autos.forEach((i, k) => {
        const edge = Math.floor(((k + 1) / autos.length) * free + 1e-6);
        base[i] += edge - prev;
        prev = edge;
      });
    }
  }
  return base.map(PXU);
}

/**
 * Where tracks start along an axis, with content distribution (justify-content / align-content)
 * of the free space: start, center, end, space-between, -around and -evenly. Returns each track's
 * start and the gap actually used between tracks.
 */
export function trackStarts(sizes: number[], gap: number, available: number, content: string): number[] {
  const n = sizes.length;
  const total = sizes.reduce((s, x) => s + LU(x), 0) + LU(gap) * Math.max(0, n - 1);
  const free = LU(available) - total;
  let offset = 0;
  let between = 0;
  if (free > 0 || /^(center|end|flex-end|right|safe)/.test(content)) {
    if (/^(center)$/.test(content)) offset = Math.trunc(free / 2);
    else if (/^(end|flex-end|right)$/.test(content)) offset = free;
    else if (content === "space-between" && n > 1) between = free / (n - 1);
    else if (content === "space-around") {
      between = free / n;
      offset = between / 2;
    } else if (content === "space-evenly") {
      between = free / (n + 1);
      offset = between;
    }
  }
  const out: number[] = [];
  let x = offset;
  for (let i = 0; i < n; i++) {
    out.push(PXU(Math.floor(x + 1e-6)));
    x += LU(sizes[i]) + LU(gap) + between;
  }
  return out;
}
