/**
 * Text measurement and line breaking for the reference engine.
 *
 * Widths come from a precomputed metrics table (glyph advances + pair kerning, sampled per
 * weight and interpolated). Line breaking is greedy, like CSS `white-space: normal` with
 * `overflow-wrap: normal`: break opportunities after spaces, and between other characters where
 * Chromium's line breaker puts them (hyphens, dashes, soft hyphens, some punctuation), from a
 * table measured once in Chromium (breaks.generated.ts). Scope: Latin text in the measured set.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Span } from "../fixture.js";
import { metricsFileName, readMetrics, type MetricsFace } from "../metrics.js";
import { BREAK_CHARS, BREAKS, BREAKS_ALL, BREAKS_ANYWHERE } from "./breaks.generated.js";

export interface MetricsInfo {
  source: string;
  generatedWith: string;
  /** The table ships with Cadesa (fonts/). */
  bundled: boolean;
  kind: "variable" | "static";
  weights: number[];
  files?: MetricsFace[];
  /** Set for a font measured as installed on one machine (a system font). */
  machineSpecific?: string;
  /** The font shapes more runs in context than were measured (contextualIncomplete): its text widths are approximate. */
  contextualIncomplete?: boolean;
}

const BUNDLED = fileURLToPath(new URL("../../fonts/", import.meta.url));

export interface Wraps {
  opps: number[];
  fit: number[][];
  width: number[][];
}

export interface FontMetrics {
  family: string;
  file: string;
  /** Where the table came from: what was measured, with what, and whether it ships with Cadesa. */
  info: MetricsInfo;
  /** A table of an italic face (measured with font-style: italic). */
  italic: boolean;
  /**
   * For a font whose contextual forms the search couldn't cover: the width of this text laid out
   * whole on one line at a size and weight (px, as its line box reports it), when it was measured
   * (MetricsFile.lines); undefined otherwise.
   */
  lineWidth(text: string, sizePx: number, weight: number): number | undefined;
  /**
   * Where such text wraps, when that was measured (MetricsFile.wraps): its break opportunities
   * (character offsets: 0, each word after spaces, its length), and for a line from opportunity a
   * to b (a < b), `fit[a][b - a - 1]`, the least room (px) in which it reaches b, and `width`, its
   * width there (px); a row ends where lines grew wider than were measured.
   */
  wraps(text: string, sizePx: number, weight: number): Wraps | undefined;
  /** Width in px, or undefined if the text has a character outside the measured set. */
  /** With `spaced`, as letter-spaced text (no contextual alternates); letter-spacing itself isn't added. */
  measure(text: string, sizePx: number, weight: number, spaced?: boolean): number | undefined;
  unsupported(text: string): string[];
  /**
   * A ligature or contextual run of this font in the text (a pair the font shapes differently when
   * letter-spacing turns ligatures off, or a longer run), if any: Chromium never breaks inside one.
   */
  ligatureIn(text: string): string | undefined;
  /**
   * The font's ascent, descent and line gap at a size, as Chromium rounds them (whole px), and its
   * x-height (px); undefined for a table measured before vertical metrics were recorded.
   */
  vertical(sizePx: number, weight: number): { ascent: number; descent: number; lineGap: number; xHeight: number; avgChar?: number; maxChar?: number } | undefined;
  /**
   * What a table measured by an older Cadesa lacks ("vertical metrics", "character widths"), so
   * that `cadesa fonts --measure` measures it again; undefined for a complete table.
   */
  outdated?: string;
}

const registry = new Map<string, FontMetrics | undefined>();
/** metricsFor's answers, by where tables are looked for and the family asked for. */
const lookups = new Map<string, FontMetrics | undefined>();

/** What a metrics table from an older Cadesa lacks: vertical metrics, or a text field's character widths. */
function outdatedTable(m: { kind: string; weights: number[]; vertical?: { byWeight: Record<string, { avgChar?: number; maxChar?: number }> } }): string | undefined {
  const faces = m.vertical ? Object.values(m.vertical.byWeight) : [];
  if (!faces.length) return "vertical metrics and character widths";
  // Every static face has its own (a face merged in from an older table has none).
  const lacking = m.kind === "static" ? m.weights.filter((w) => !m.vertical!.byWeight[w]) : [];
  if (lacking.length) return `vertical metrics and character widths for weight${lacking.length > 1 ? "s" : ""} ${lacking.join(", ")}`;
  if (faces.some((f) => f.avgChar === undefined || f.maxChar === undefined)) return "average and maximum character widths";
  return undefined;
}

/** Forget loaded (and missing) metrics, after new tables were written. */
export function clearMetricsCache() {
  registry.clear();
  lookups.clear();
}

/**
 * CSS Fonts 4 §5.2 weight matching for a family made of static faces. A weight the matched face
 * doesn't have (600 or 700 from a 400 or 500 face) is synthesized bold, which in Chromium on Linux
 * emboldens the outlines only: advances and vertical metrics stay the matched face's (probed at
 * 8–100px), so such text is measured with that face's table.
 */
export function matchWeight(available: number[], desired: number): number {
  const asc = [...available].sort((a, b) => a - b);
  const desc = [...asc].reverse();
  if (asc.includes(desired)) return desired;
  if (desired >= 400 && desired <= 500)
    return (
      asc.find((w) => w > desired && w <= 500) ?? desc.find((w) => w < desired) ?? asc.find((w) => w > 500)!
    );
  if (desired < 400) return desc.find((w) => w < desired) ?? asc.find((w) => w > desired)!;
  return asc.find((w) => w > desired) ?? desc.find((w) => w < desired)!;
}

function load(file: string): FontMetrics {
  const m = readMetrics(file);
  const kind = m.kind ?? "variable";
  const index = new Map([...m.chars].map((c, i) => [c, i]));
  const kernChars = new Set(m.kernChars ?? "");
  const kernBase = (c: string) => (kernChars.has(c) || (c.length === 1 && c.charCodeAt(0) > 0xff) ? c : c.normalize("NFD")[0]);

  // Variable: interpolate between the sampled weights around `weight`. Static: the matched face.
  const bracket = (weight: number): [number, number, number] => {
    const ws = m.weights;
    if (kind === "static") {
      const w = matchWeight(ws, weight);
      return [w, w, 0];
    }
    if (weight <= ws[0]) return [ws[0], ws[0], 0];
    if (weight >= ws[ws.length - 1]) return [ws[ws.length - 1], ws[ws.length - 1], 0];
    const hi = ws.findIndex((w) => w >= weight);
    const a = ws[hi - 1];
    const b = ws[hi];
    return [a, b, (weight - a) / (b - a)];
  };

  const wrapCache = new Map<string, Wraps | undefined>();
  // Exact advances at an integer weight of a variable font, built from the fine table on first use.
  const fineRows = new Map<number, number[]>();
  const fineDeltas = m.fine?.deltas.map((d) => d.split(",").map(Number));
  const fineRow = (weight: number): number[] | undefined => {
    const f = m.fine;
    if (!f || !Number.isInteger(weight)) return undefined;
    const w = Math.min(Math.max(weight, f.from), f.to);
    let row = fineRows.get(w);
    if (!row) {
      row = f.base.map((b, i) => {
        let a = b;
        for (let k = 0; k < w - f.from; k++) a += fineDeltas![i][k];
        return a;
      });
      fineRows.set(w, row);
    }
    return row;
  };
  /** Exact values of the contextual runs at an integer weight of a variable font. */
  const runRows = new Map<number, Map<string, number>>();
  const runDeltas = m.fine?.runDeltas?.map((d) => d.split(",").map(Number));
  const runRow = (weight: number): Map<string, number> | undefined => {
    const f = m.fine;
    if (!f?.runs || !Number.isInteger(weight)) return undefined;
    const w = Math.min(Math.max(weight, f.from), f.to);
    let row = runRows.get(w);
    if (!row) {
      row = new Map(
        f.runs.map((r, i) => {
          let a = f.runBase![i];
          for (let k = 0; k < w - f.from; k++) a += runDeltas![i][k];
          return [r, a];
        }),
      );
      runRows.set(w, row);
    }
    return row;
  };

  // The font's units per em, when the measured advances are whole font units at one of the usual
  // sizes (as for Inter): widths can then be computed exactly as
  // Chromium does. Otherwise they are scaled from the measured fractions.
  const upm = m.upm ?? [2048, 1000, 1024, 4096, 2000, 512, 256].find((u) =>
    Object.values(m.advances).every((row) => row.every((a) => Math.abs((a / m.units) * u - Math.round((a / m.units) * u)) < 0.003)),
  );
  // A table that records the font file's units per em scales the way FreeType and HarfBuzz do, in
  // fixed point. With a units per em that isn't a power of two, that differs from exact scaling.
  // (The measured values carry the same rounding, from Chromium's 64px canonical size: a few
  // thousandths of a unit.)
  const fixedPoint = m.upm !== undefined;
  /** A value in font units, whole when it is within the metrics' precision of a whole unit. */
  const snap = (v: number) => (Math.abs(v - Math.round(v)) < (fixedPoint ? 0.02 : 0.003) ? Math.round(v) : v);
  /** A length in px rounded to 1/65536 px. */
  const fixed = (v: number) => Math.round(v * 65536) / 65536;
  /** A glyph advance in px: FreeType's x_scale = FT_DivFix(size in 26.6, upm), advance = FT_MulDiv(units, x_scale, 64). */
  const advancePx = (u: number, gs: number) => {
    if (!fixedPoint || !Number.isInteger(u) || u < 0) return fixed((u * gs) / upm!);
    const xs = Math.floor((gs * 64 * 65536 + upm! / 2) / upm!);
    return Math.floor((u * xs + 32) / 64) / 65536;
  };
  /** A kerning value in px: HarfBuzz's scale is the size in 16.16, and em_scale(v) = (v * ((scale << 16) / upm) + 32768) >> 16. */
  const kernPx = (k: number, sizePx: number) => {
    if (!fixedPoint || !Number.isInteger(k)) return fixed((k * sizePx) / upm!);
    const mult = Math.floor((Math.trunc(Math.fround(sizePx) * 65536) * 65536) / upm!);
    return Math.floor((k * mult + 32768) / 65536) / 65536;
  };

  // Letter-spaced kerning: the normal table with the pairs that differ replaced, merged once.
  const ctxRuns = Object.values(m.contextual ?? {}).flatMap((c) => Object.keys(c));
  const ctxStarts = new Set(ctxRuns.map((r) => [...r][0]));
  // Tables from before ligatures were measured (no upm) don't say which pairs are ligatures.
  const ligRuns =
    m.upm === undefined ? [] : [...new Set([...Object.values(m.kerningSpaced ?? {}), ...Object.values(m.contextual ?? {})].flatMap((k) => Object.keys(k)))];
  const ctxMax = Math.max(0, ...ctxRuns.map((r) => [...r].length));

  const spacedTables = new Map<number, Record<string, number>>();
  const kerningAt = (w: number, spaced: boolean): Record<string, number> => {
    const over = spaced ? m.kerningSpaced?.[w] : undefined;
    if (!over) return m.kerning[w];
    let t = spacedTables.get(w);
    if (!t) spacedTables.set(w, (t = { ...m.kerning[w], ...over }));
    return t;
  };

  return {
    family: m.family,
    file,
    italic: m.style === "italic",
    info: {
      source: m.source,
      generatedWith: m.generatedWith,
      bundled: file.startsWith(BUNDLED),
      kind,
      weights: m.weights,
      ...(m.files && { files: m.files }),
      ...(m.machineSpecific && { machineSpecific: m.machineSpecific }),
      ...(m.contextualIncomplete && { contextualIncomplete: true }),
    },
    ...(outdatedTable(m) && { outdated: outdatedTable(m) }),
    unsupported: (text) => [...new Set([...text].filter((c) => !index.has(c)))],
    ligatureIn(text) {
      if (!ligRuns.length) return undefined;
      return ligRuns.find((r) => text.includes(r));
    },
    vertical(sizePx, weight) {
      const v = m.vertical;
      if (!v) return undefined;
      const ws = Object.keys(v.byWeight).map(Number);
      const face = v.byWeight[kind === "static" ? matchWeight(ws, weight) : ws[0]];
      if (!face) return undefined;
      // Skia scales them in single precision; Chromium rounds each to whole px (SkScalarRoundToScalar).
      const f = Math.fround;
      const px = (u: number) => f(f(u / v.size) * f(sizePx));
      const round = (x: number) => Math.floor(x + 0.5);
      // A text field's average and maximum character widths at this size (px, unrounded).
      const chars = face.avgChar !== undefined && face.maxChar !== undefined ? { avgChar: px(face.avgChar), maxChar: px(face.maxChar) } : {};
      return { ascent: round(px(face.ascent)), descent: round(px(face.descent)), lineGap: round(px(face.lineGap)), xHeight: px(face.xHeight), ...chars };
    },
    lineWidth(text, sizePx, weight) {
      return m.lines?.[`${sizePx}|${weight}`]?.[text];
    },
    wraps(text, sizePx, weight) {
      const key = `${sizePx}|${weight}|${text}`;
      if (wrapCache.has(key)) return wrapCache.get(key);
      const enc = m.wraps?.[`${sizePx}|${weight}`]?.[text];
      let out: Wraps | undefined;
      if (enc !== undefined) {
        const opps = [0];
        for (let i = 1; i < text.length; i++) if (text[i - 1] === " " && text[i] !== " ") opps.push(i);
        opps.push(text.length);
        const rows = enc.split(";").map((r) => (r ? r.split(",").map((x) => x.split(":").map(Number)) : []));
        if (rows.length === opps.length - 1) out = { opps, fit: rows.map((r) => r.map((x) => x[0] / 64)), width: rows.map((r) => r.map((x) => (x[1] ?? x[0]) / 64)) };
      }
      wrapCache.set(key, out);
      return out;
    },
    measure(text, sizePx, weight, spaced) {
      // Text measured whole (a handwriting font's line): that width.
      const whole = spaced ? undefined : m.lines?.[`${sizePx}|${weight}`]?.[text];
      if (whole !== undefined) return whole;
      const [wa, wb, t] = bracket(weight);
      const exact = fineRow(weight);
      const advA = exact ?? m.advances[wa];
      const advB = exact ?? m.advances[wb];
      const kernA = kerningAt(wa, !!spaced);
      const kernB = kerningAt(wb, !!spaced);
      const gs = glyphSize(sizePx);
      // A variable font's ligatures and contextual runs, exact at an integer weight (not letter-spaced).
      const exactRuns = spaced ? undefined : runRow(weight);
      let units = 0;
      let kern = 0;
      let px = 0;
      let prev: string | undefined;
      for (const c of text) {
        const i = index.get(c);
        if (i === undefined) return undefined;
        const adv = advA[i] + (advB[i] - advA[i]) * t;
        if (upm) px += advancePx(snap((adv / m.units) * upm), gs);
        else units += adv;
        if (prev !== undefined) {
          const pair = kernBase(prev) + kernBase(c);
          const ka = kernA[pair] ?? 0;
          const kb = kernB[pair] ?? 0;
          const k = exactRuns?.get(pair) ?? ka + (kb - ka) * t;
          if (upm) px += k ? kernPx(snap((k / m.units) * upm), sizePx) : 0;
          else kern += k;
        }
        prev = c;
      }
      // Ligatures and contextual forms (not in letter-spaced text): what each listed run adds,
      // mostly a substituted glyph's advance, so at the glyph size.
      if (ctxMax && !spaced) {
        const cs = [...text];
        const ca = m.contextual![wa] ?? {};
        const cb = m.contextual![wb] ?? {};
        for (let i = 0; i + 3 <= cs.length; i++) {
          if (!ctxStarts.has(cs[i])) continue;
          let run = cs[i] + cs[i + 1];
          for (let n = 3; n <= ctxMax && i + n <= cs.length; n++) {
            run += cs[i + n - 1];
            const va = ca[run] ?? 0;
            const v = exactRuns ? (exactRuns.get(run) ?? 0) : va + ((cb[run] ?? 0) - va) * t;
            if (!v) continue;
            if (upm) px += fixed((snap((v / m.units) * upm) * gs) / upm);
            else units += v;
            // (A run's value is a difference of advances, so it isn't rounded like one: at most
            // 1/65536 px off where the units per em isn't a power of two.)
          }
        }
      }
      // Glyph advances come from the font set up at the quantized glyph size; kerning is applied by
      // the shaper at the size as specified. Each is rounded to 1/65536 px (HarfBuzz positions).
      return upm ? px : (units / m.units) * gs + (kern / m.units) * sizePx;
    },
  };
}

/**
 * Where metrics tables are found, in priority order: $CADESA_METRICS (path list),
 * ./.cadesa/metrics (written by `cadesa metrics`), then the fonts bundled with Cadesa.
 */
export function metricsDirs(): string[] {
  return [
    ...(process.env.CADESA_METRICS?.split(delimiter).filter(Boolean) ?? []),
    join(process.cwd(), ".cadesa", "metrics"),
    BUNDLED,
  ];
}

/**
 * Metrics for the first family in a font-family list, if it has been measured. With `italic`, its
 * italic table (for text in a real italic face; a synthesized one is as wide as upright text).
 */
export function metricsFor(fontFamily: string | undefined, italic = false): FontMetrics | undefined {
  if (!fontFamily) return undefined;
  const asked = `${process.env.CADESA_METRICS ?? ""}\0${process.cwd()}\0${italic}\0${fontFamily}`;
  if (lookups.has(asked)) return lookups.get(asked);
  const found = lookupMetrics(fontFamily, italic);
  lookups.set(asked, found);
  return found;
}

function lookupMetrics(fontFamily: string, italic: boolean): FontMetrics | undefined {
  const first = fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
  const name = metricsFileName(first, italic);
  // A table may be gzipped (.metrics.json.gz), as the bundled ones are.
  const file = metricsDirs()
    .flatMap((d) => [join(d, name), join(d, `${name}.gz`)])
    .find(existsSync);
  const key = file ?? `missing:${name}`;
  if (!registry.has(key)) {
    const m = file ? load(file) : undefined;
    registry.set(key, m && m.family.toLowerCase() === first.toLowerCase() && m.italic === italic ? m : undefined);
  }
  return registry.get(key);
}

/**
 * The characters of a run of text that its fonts have no widths for, each in the font of its
 * innermost span that sets one (or the italic face a span asks for), else the text's (`m`).
 */
export function unsupportedInRuns(m: FontMetrics, text: string, spans: readonly { from: number; to: number; font?: string; italic?: boolean }[] = []): string[] {
  const out = new Set<string>();
  let i = 0;
  for (const c of text) {
    if (c !== "￼") {
      let font: string | undefined;
      let italic: boolean | undefined;
      for (const sp of spans) {
        if (!(sp.from <= i && i < sp.to)) continue;
        if (sp.font !== undefined) font = sp.font;
        if (sp.italic !== undefined) italic = sp.italic;
      }
      const it = italic ?? m.italic;
      const f = font !== undefined || it !== m.italic ? metricsFor(font ?? JSON.stringify(m.family), it) : m;
      if (!f || f.unsupported(c).length) out.add(c);
    }
    i += c.length;
  }
  return [...out];
}

export interface Line {
  text: string;
  width: number;
  /** Where the line starts in the text (characters). */
  at?: number;
  /** Its height, when inline boxes on it may reach past the text's strut (see layoutText's `strut`), and its baseline from its top. */
  h?: number;
  base?: number;
  /**
   * Beside floats (see layoutText's `band`): where the line box starts from the content box's left
   * edge, how wide its room is, and its top from the content box's top (px).
   */
  x?: number;
  room?: number;
  top?: number;
}

export interface TextLayout {
  lines: Line[];
  /** Width of the whole text on one line. */
  maxContent: number;
  /** Width of the widest unbreakable piece. */
  minContent: number;
  widestPiece: string;
  /**
   * Set when a word had to break between characters (overflow-wrap: anywhere) at a point the
   * engine can't call exactly: how Chromium measures the fragments of a word is only partly
   * known, so a fragment within reach of the line's width, or a soft hyphen in the word, makes
   * the break points approximate.
   */
  approximate?: string;
}

/**
 * The size glyphs are scaled at. Chromium keys its font cache on the size in hundredths of a px,
 * truncated in single precision (16.3px is 1629.9999 hundredths: 16.29px), and the font is set up
 * at that size truncated to 1/64 px (16.29px draws at 16.28125px, 38.64px at 38.625px).
 */
export function glyphSize(sizePx: number): number {
  const hundredths = Math.trunc(Math.fround(Math.fround(sizePx) * 100));
  return Math.floor(Math.fround(hundredths / 100) * 64 + 1e-6) / 64;
}

/**
 * The precision of text widths, in layout units (1/64 px): widths are computed in 1/65536 px, as
 * Chromium positions glyphs, so this only absorbs floating-point error.
 */
export const TEXT_EPS = 1e-6;

const LETTER = /\p{L}/u;

const SHY = "­";

/** Grapheme clusters: where a word may break between characters (overflow-wrap: anywhere). */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** An atomic inline (an inline-block, an icon <svg>) in a run of text: no glyph, its width is its inline box's (a span's open edge). */
export const OBJ = "\uFFFC";

const breakIndex = new Map([...BREAK_CHARS].map((c, i) => [c, i]));
/** How lines may break between characters: ordinary text (and word-break: keep-all, the same for the measured characters), word-break: break-all, line-break: anywhere. */
export type BreakMode = "normal" | "all" | "anywhere";
const breakTables: Record<BreakMode, Buffer> = { normal: Buffer.from(BREAKS, "base64"), all: Buffer.from(BREAKS_ALL, "base64"), anywhere: Buffer.from(BREAKS_ANYWHERE, "base64") };
const N = breakIndex.size;

/** Whether Chromium may break between two non-space characters, given the character before `a`. */
function canBreak(before: string | undefined, a: string, b: string, mode: BreakMode = "normal"): boolean {
  // An atomic inline: a break before and after it (UAX #14 CB), punctuation or not (probed in
  // Chromium: "(" before an inline-block, an image or an svg, and "." or ")" after one, are broken
  // from it), except before a mark or joiner that attaches to it.
  if (a === OBJ) return !/^[\p{M}‍⁠]$/u.test(b);
  if (b === OBJ) return !/^[‍⁠]$/.test(a);
  const i = breakIndex.get(a);
  const j = breakIndex.get(b);
  // Outside the measured set the text is flagged anyway; keep to the plain rules.
  if (i === undefined || j === undefined) return (a === "-" || a === "–" || a === "—" || a === SHY) && LETTER.test(b);
  const ascii = before !== undefined && before < "\u0080";
  const ctx =
    before === undefined || before === " " ? 0 : ascii && /[A-Za-z]/.test(before) ? 1 : ascii && /[0-9]/.test(before) ? 2 : LETTER.test(before) ? 3 : 4;
  const bit = (ctx * N + i) * N + j;
  return (breakTables[mode][bit >> 3] & (1 << (bit & 7))) !== 0;
}

/**
 * Split collapsed text into pieces that end at break opportunities (trailing space kept). Breaks
 * come after spaces, and between other characters where Chromium's line breaker allows them
 * (hyphens, dashes, soft hyphens, some punctuation), from a table measured in Chromium.
 */
export function pieces(text: string, mode: BreakMode = "normal"): string[] {
  const out: string[] = [];
  let cur = "";
  const chars = [...text];
  chars.forEach((c, i) => {
    const next = chars[i + 1];
    cur += c;
    const breakAfter = next !== undefined && (c === " " ? next !== " " : next !== " " && canBreak(chars[i - 1], c, next, mode));
    if (breakAfter) {
      out.push(cur);
      cur = "";
    }
  });
  if (cur) out.push(cur);
  return out;
}

/** Only collapsible spaces hang at a line end; no-break and thin spaces (which JS trimEnd also strips) take room. */
const trimSpaces = (s: string) => s.replace(/ +$/, "");

export function layoutText(
  m: FontMetrics,
  text: string,
  sizePx: number,
  weight: number,
  maxWidth0: number,
  opts: {
    letterSpacing?: number;
    spacesOnly?: boolean;
    hangKern?: boolean;
    wrapAnywhere?: boolean;
    /** With wrapAnywhere: overflow-wrap: break-word, whose min-content still counts whole words. */
    breakWord?: boolean;
    /**
     * word-break: break-all or line-break: anywhere: lines may break between the characters of a
     * word wherever Chromium's table for it allows (see canBreak), not only where it doesn't fit.
     */
    breaks?: BreakMode;
    /** Inline element edges (character offsets): the text between them is shaped separately. */
    items?: number[];
    /** Inline boxes with text at another weight, or margin, border and padding at their edges. */
    spans?: Span[];
    /** A float at the start of the text, this wide: the first line fits beside it. */
    lead?: number;
    /**
     * The text box's strut: how far its lines reach above and below the baseline (px). With it,
     * each line is as tall as the union of the strut and the inline boxes on it (spans' `above`
     * and `below`), and lines record their height.
     */
    strut?: { above: number; below: number };
    /**
     * Floats beside the text: the room for a line `h` tall at `top` (from the content box's top),
     * the first band from there down whose room fits the line's first piece (see Exclusions.find).
     * With it, lines record where they are (Line.x, room and top), each `lineH` tall.
     */
    band?: (top: number, h: number, fits: (w: number) => boolean) => { top: number; l: number; r: number };
    lineH?: number;
    /**
     * Floats among the text (with `band`): where each occurs (a character offset), its margin box's
     * width, and `place`, which puts it in the formatting context at a line's top (px from the
     * content box's top). As Chromium's line breaker does: a float met at the start of a line is
     * placed at that line's top; one met on a line it fits beside (what is on the line so far,
     * a space at its end hanging, and its width within the line's room), and with no float before it waiting,
     * at that line's top, the line then shortened; any other below the line, at the next one's top.
     */
    floats?: { at: number; w: number; fitsAt?: (top: number) => boolean; place: (top: number) => void }[];
  } = {},
): TextLayout {
  // Beside floats, with inline boxes that may reach past the strut: each line's band must hold the
  // line as tall as it turns out (LayoutNG lays the line out in a layout opportunity, then moves to
  // the next one if the line box is taller than it). A line found taller than the band it was
  // placed in is laid out again in the band for its height (`tall`), and so on.
  if (opts.band && opts.strut && !opts.floats?.length) {
    const tall: number[] = [];
    for (let guard = 0; guard < 200; guard++) {
      const r = layoutLines(m, text, sizePx, weight, maxWidth0, opts, tall);
      if (!("retry" in r)) return r;
      tall[r.retry] = r.h;
    }
  }
  const r = layoutLines(m, text, sizePx, weight, maxWidth0, opts, []);
  if ("retry" in r) throw new Error("unreachable");
  return r;
}

function layoutLines(
  m: FontMetrics,
  text: string,
  sizePx: number,
  weight: number,
  maxWidth0: number,
  opts: Parameters<typeof layoutText>[5] & {},
  tall: number[],
): TextLayout | { retry: number; h: number } {
  /** The room for the line being filled (beside floats: that line's band). */
  let maxWidth = maxWidth0;
  // letter-spacing is added after every character, including the last one on a line (or, with
  // spacesOnly, after every U+0020 and U+00A0 only).
  const ls = opts.letterSpacing ?? 0;
  const spans = opts.spans ?? [];
  /** The weight of the character at `at` (its innermost span with a weight, or the text's). */
  const base = { m, size: sizePx, weight, key: "" };
  /** The font of the character at `at`: its innermost span's weight, font and size, each where set, else the text's. */
  const fontAt = (at: number | undefined) => {
    if (at === undefined || !spans.length) return base;
    let wt = weight;
    let font: string | undefined;
    let size = sizePx;
    let italic: boolean | undefined;
    for (const sp of spans) {
      if (!(sp.from <= at && at < sp.to)) continue;
      if (sp.weight !== undefined) wt = sp.weight;
      if (sp.font !== undefined) font = sp.font;
      if (sp.size !== undefined) size = sp.size;
      if (sp.italic !== undefined) italic = sp.italic;
    }
    if (wt === weight && font === undefined && size === sizePx && (italic === undefined || italic === m.italic)) return base;
    // Text in another font, or in the italic (or upright) face of this one: that table.
    const it = italic ?? m.italic;
    const other = font !== undefined || it !== m.italic ? metricsFor(font ?? JSON.stringify(m.family), it) : undefined;
    return { m: other || m, size, weight: wt, key: `${font ?? ""}|${size}|${wt}|${it ? "i" : ""}` };
  };
  // Letter-spaced text is shaped without contextual alternates. Text in another weight, font or
  // size is another font: measured on its own, with no kerning across the edge.
  const measure = (s: string, at?: number) => {
    const f = fontAt(at);
    return f.m.measure(s.includes(OBJ) ? s.replaceAll(OBJ, "") : s, f.size, f.weight, ls !== 0) ?? 0;
  };
  /**
   * Whether kerning applies between the characters before and at `at`: both in one font, with no
   * margin, border or padding of an inline box between them (Chromium shapes them apart then).
   */
  const kerns = (at: number) => fontAt(at - 1).key === fontAt(at).key && !spans.some((sp) => (sp.open && sp.from === at) || (sp.close && sp.to === at));
  /** Margin, border and padding of inline boxes that open in [a, b) or close in (a, b]. */
  const edgesIn = (a: number, b: number) => {
    let px = 0;
    for (const sp of spans) {
      // An empty inline box (generated content "" with padding) goes with the text after it, or at the very end with the text before.
      if (sp.from === sp.to) {
        if ((sp.from >= a && sp.from < b) || (sp.from === b && b === all.length && a < b)) px += (sp.open ?? 0) + (sp.close ?? 0);
        continue;
      }
      if (sp.open && sp.from >= a && sp.from < b) px += sp.open;
      if (sp.close && sp.to > a && sp.to <= b) px += sp.close;
    }
    return px;
  };
  const spaceWs = new Map<string, number>();
  const spaceWAt = (at?: number) => {
    const k = fontAt(at).key;
    let v = spaceWs.get(k);
    if (v === undefined) spaceWs.set(k, (v = measure(" ", at)));
    return v;
  };
  const w = (s: string, hangKern = opts.hangKern !== false, at?: number) => {
    const t = trimSpaces(s);
    const body = t.replaceAll(SHY, "");
    // A line broken at a soft hyphen ends in a "-" that Chromium shapes on its own: no kerning
    // with the letter before it, and no letter-spacing.
    // A space hanging at the end of a line doesn't count, but in a plain block the kerning between
    // it and the character before does (Inter kerns ", " and ". "): Chromium keeps the line's
    // shaping. In a block that paints a background, border or shadow, or whose text is
    // underlined, it measures the line without that kerning (hangKern: false). Its min-content
    // width keeps the kerning either way.
    const shaped = t.endsWith(SHY)
      ? measure(body, at) + measure("-", at)
      : hangKern && s.endsWith(" ") && body
        ? measure(body + " ", at) - spaceWAt(at)
        : measure(body, at);
    const spaced = opts.spacesOnly ? [...body].filter((c) => c === " " || c === "\u00a0").length : [...body].length;
    return shaped + (ls ? spaced * ls : 0);
  };
  /**
   * A line box [a, b) (characters) of this width in a room this wide: the strut and every inline
   * box with content on the line (an empty one where it stands), each placed by its vertical-align
   * around the baseline. Its height, and its baseline from its top.
   */
  const lineBox = (a: number, b: number, lwidth: number, first: boolean, room: number): { h: number; base: number } => {
    let above = opts.strut!.above;
    let below = opts.strut!.below;
    const pending: typeof spans = [];
    const onLine: typeof spans = [];
    for (const sp of spans) {
      // A box whose own leading whitespace collapsed opens at the end of this line when the line is
      // full there: the kept space before it doesn't fit, so LayoutNG takes the trailing whitespace
      // (that collapsed space, and the box's start) onto this line.
      const leads = sp.lead && sp.from === b && lwidth + measure(" ", sp.from - 1) + ls > room + 1e-6;
      // Which line such a box opens on decides a line's height when the box reaches past the strut,
      // and that isn't pinned down (probed: one in another font opens on the full line, one in
      // another size or vertical-align sometimes on the next).
      if (leads && (sp.above !== undefined || sp.below !== undefined || sp.align || sp.byExtent)) approximate ??= "an inline box taller than the line opens where a full line breaks";
      // An empty box where a line breaks stays with what is before it: it ends that line (probed:
      // "dawn <a></a>quickly", the box on the line "dawn" ends whether or not its space fits).
      const on = sp.from === sp.to ? (sp.from > a || first) && sp.from <= b : (leads ? sp.from - 1 : sp.from) < b && sp.to > a;
      if (!on) continue;
      onLine.push(sp);
      if (sp.byExtent || sp.rel) continue;
      if (sp.align) pending.push(sp);
      else {
        if (sp.above !== undefined) above = Math.max(above, sp.above);
        if (sp.below !== undefined) below = Math.max(below, sp.below);
      }
    }
    // A box placed by its extent (middle, text-top, text-bottom), split across lines: on each line
    // by what of it is there (its strut and the boxes in it on this line, from its baseline), its
    // shift (as Chromium computes it, in layout units) moving it and them.
    for (const x of onLine) {
      const e = x.byExtent;
      if (!e) continue;
      let sa = e.sa;
      let sd = e.sd;
      const inner = onLine.filter((c) => c.rel && c.from >= x.from && c.to <= x.to && c !== x);
      for (const c of inner) {
        if (c.above !== undefined) sa = Math.max(sa, c.above);
        if (c.below !== undefined) sd = Math.max(sd, c.below);
      }
      const U = (v: number) => Math.round(v * 64);
      const shift = e.mode === "middle" ? (Math.trunc((U(sa) - U(sd)) / 2) - U(e.xh2)) / 64 : e.mode === "text-top" ? sa - e.ascent : e.descent - sd;
      const down = e.base + shift;
      above = Math.max(above, e.sa - down);
      below = Math.max(below, e.sd + down);
      for (const c of inner) {
        if (c.above !== undefined) above = Math.max(above, c.above - down);
        if (c.below !== undefined) below = Math.max(below, c.below + down);
      }
    }
    // vertical-align: top and bottom, in order, once the rest of the line is placed (LayoutNG's
    // pending descendants): a taller box grows the line box below (top) or above (bottom).
    for (const sp of pending) {
      const h = (sp.above ?? 0) + (sp.below ?? 0);
      if (sp.align === "top") below = Math.max(below, h - above);
      else above = Math.max(above, h - below);
    }
    return { h: above + below, base: above };
  };
  const mode = opts.breaks ?? "normal";
  /**
   * Pieces of the text for its min-content width. Broken inside words (break-all, line-break:
   * anywhere), a ligature glyph ("fi" in Roboto) is never broken there: its characters stay in one
   * piece (probed). A line, though, may end inside one (reshaped, see fitsMid).
   */
  const piecesOf = (t: string) => {
    const out = pieces(t, mode);
    if (mode === "normal" || ls) return out;
    const merged: string[] = [];
    let at = 0;
    const cs = [...t];
    for (const q of out) {
      const prev = merged.at(-1);
      // A break at `at`, between cs[at - 1] and cs[at]: inside a ligature that spans it?
      const inside = prev !== undefined && cs[at - 1] !== " " && [cs.slice(at - 1, at + 1), cs.slice(at - 2, at + 1), cs.slice(at - 1, at + 2)].some((win) => {
        const lig = m.ligatureIn(win.join(""));
        return lig !== undefined && [...lig].length === win.length;
      });
      if (inside) merged[merged.length - 1] = prev + q;
      else merged.push(q);
      at += [...q].length;
    }
    return merged;
  };
  const ps = pieces(text, mode);
  const lines: Line[] = [];
  const all = [...text];
  /** Characters of the text already placed on earlier lines. */
  let consumed = 0;
  const edges = opts.items ?? [];
  /** Where the character at `at` starts in its item (the text up to the next inline element edge, shaped whole). */
  const startOf = (at: number) => {
    const from = Math.max(0, ...edges.filter((b) => b <= at));
    if (at === from) return 0;
    const before = all.slice(from, at).join("").replaceAll(SHY, "");
    const next = edges.includes(at) ? "" : (all[at] ?? "").replaceAll(SHY, "");
    return measure(before + next, from) - measure(next, from);
  };
  /** The letter-spacing a line or piece adds (what w() adds to the shaped width). */
  const spacing = (s: string) => {
    if (!ls) return 0;
    const body = trimSpaces(s).replaceAll(SHY, "");
    return (opts.spacesOnly ? [...body].filter((c) => c === " " || c === "\u00a0").length : [...body].length) * ls;
  };
  /** The full width of text inside a line (spaces included). */
  const full = (s: string, at?: number) => {
    const body = s.replaceAll(SHY, "");
    const spaced = opts.spacesOnly ? [...body].filter((c) => c === " " || c === "\u00a0").length : [...body].length;
    return measure(body, at) + (ls ? spaced * ls : 0);
  };
  const floor64 = (v: number) => Math.floor(v * 64 + TEXT_EPS) / 64;
  const ceil64 = (v: number) => Math.ceil(v * 64 - TEXT_EPS) / 64;
  let approximate: string | undefined;
  // Broken inside words: "ffi" and "ffl" may be one ligature glyph of three characters, whose
  // breaks the font table (which knows "fi" and "fl") can't tell.
  if (mode !== "normal" && !ls && /ff[il]/.test(text) && (m.ligatureIn("fi") || m.ligatureIn("fl"))) approximate = `a word with a ligature ("${text.match(/ff[il]/)![0]}") breaks between characters`;
  // A line fits when its width is at most the available width plus one layout unit (1/64 px):
  // "a b" at 55.515px fits in 55.5px. Text split by inline elements is measured item by item: the items
  // before the last on the line count their widths rounded up. A line that starts after a break
  // inside a word (after a hyphen or dash) sometimes counts its width rounded up instead: when
  // that would decide, the break is reported as approximate.
  /** The float at the start of the text, while the first line is still open. */
  let lead = opts.lead ?? 0;
  /** A line's width, measured item by item (see fits), and the width of its last item. */
  const lineWidth = (s: string) => {
    const cs = [...s];
    const cuts = edges.filter((b) => b > consumed && b < consumed + cs.length).map((b) => b - consumed);
    let used = lead + edgesIn(consumed, consumed + cs.length);
    let from = 0;
    for (const cut of cuts) {
      // Kerning still applies across the element's edge (counted with the item before it), when
      // both sides are shaped in one font.
      const next = kerns(consumed + cut) ? (cs[cut] ?? "").replaceAll(SHY, "") : "";
      used += ceil64(full(cs.slice(from, cut).join("") + next, consumed + from) - full(next, consumed + from));
      from = cut;
    }
    const last = cs.slice(from).join("");
    // A line that ends where an inline element starts or ends keeps its hanging space's kerning
    // even in a painted block: its item needs no reshaping there.
    const lw = edges.includes(consumed + cs.length) ? w(last, true, consumed + from) : w(last, undefined, consumed + from);
    return { used, lw, last, from };
  };
  /**
   * break-all, line-break: anywhere: a line that ends between two characters of a word fits as
   * Chromium's shaping line breaker decides (as for a word broken by overflow-wrap: anywhere, see
   * start): measured where it sits in the text's shaping (kerned to the character after it)
   * against the line's width in layout units plus one; where the font kerns across the break, the
   * part from the last point it doesn't kern across is reshaped and must fit too.
   */
  const shaped = new Map<number, number>();
  const xIn = (i: number) => {
    let x = shaped.get(i);
    if (x === undefined) shaped.set(i, (x = i <= 0 ? 0 : measure(all.slice(0, i + 1).join(""), 0) - measure(all[i] ?? "", 0)));
    return x;
  };
  const safeIn = (i: number) => i <= 0 || i >= all.length || all[i - 1] === " " || all[i] === " " || Math.abs(measure(all[i - 1] + all[i], 0) - measure(all[i - 1], 0) - measure(all[i], 0)) < TEXT_EPS;
  const midWord = (s: string) => {
    if (mode === "normal") return false;
    const e = consumed + [...s].length;
    return e < all.length && all[e] !== " " && all[e - 1] !== " " && all[e - 1] !== SHY;
  };
  const fitsMid = (s: string) => {
    const a = consumed;
    const e = a + [...s].length;
    const lu = Math.floor(maxWidth * 64 + TEXT_EPS) / 64;
    if (!(xIn(e) - xIn(a) <= lu + 1 / 64 + TEXT_EPS / 64)) return false;
    if (safeIn(e)) return true;
    let q = e - 1;
    while (q > a && !safeIn(q)) q--;
    if (q === a && !safeIn(a)) {
      if (!(measure(all.slice(a, e).join(""), 0) <= lu + 1 / 64 + TEXT_EPS / 64)) approximate ??= "a line ends inside a word the font kerns at both ends of the line";
      return true;
    }
    const snap = (x: number) => Math.floor(x * 64 + TEXT_EPS) / 64;
    return snap(xIn(q)) - snap(xIn(a)) + ceil64(measure(all.slice(q, e).join(""), 0)) <= lu + TEXT_EPS / 64;
  };
  const fits = (s: string) => {
    if (midWord(s)) {
      if (!spans.length && !lead && !ls && !edges.length) return fitsMid(s);
      approximate ??= "a line ends inside a word (word-break: break-all or line-break: anywhere) in text with inline boxes or letter-spacing of its own";
    }
    const { used, lw, last, from } = lineWidth(s);
    // A line ending in a soft hyphen's "-" gets no slack (and how much isn't pinned down: flagged).
    const hyphenated = trimSpaces(last).endsWith(SHY);
    const ok = used + lw <= maxWidth + (hyphenated ? 0 : 1 / 64) + TEXT_EPS / 64;
    if (hyphenated && !ok && used + lw <= maxWidth + 1 / 64 + TEXT_EPS / 64)
      approximate ??= "a line ending in a soft hyphen fits within a layout unit";
    const at = consumed + from;
    if (ok && at > 0 && !edges.includes(at) && all[at - 1] !== " " && used + lw > maxWidth + 1e-6)
      approximate ??= "a line after a break inside a word fits within a layout unit";
    return ok;
  };
  let line = "";
  /** Beside floats: the band of the line being filled, and where the next line may start. */
  let place: { x: number; room: number; top: number } | undefined;
  let nextTop = 0;
  /** The height the band of the line being filled was found for. */
  let bandH = 0;
  /** Find the band of a new line that starts with piece p (beside floats). */
  const openLine = (p: string) => {
    if (!opts.band || place) return;
    bandH = Math.max(opts.lineH ?? 0, tall[lines.length] ?? 0);
    const at = opts.band(nextTop, bandH, (room) => {
      maxWidth = room;
      return fits(p);
    });
    maxWidth = at.r - at.l;
    place = { x: at.l, room: maxWidth, top: at.top };
  };
  /** Floats met on a line they didn't fit beside: placed below it. */
  let deferred: { place: (top: number) => void }[] = [];
  /** A line that turned out taller than its band: laid out again (see layoutText). */
  let retry: { retry: number; h: number } | undefined;
  const push = (l: Line, end: number) => {
    if (opts.band) {
      openLine("");
      Object.assign(l, place);
      let h = opts.lineH ?? 0;
      if (opts.strut && !floats.length) {
        // Its line box, as tall as what is on it.
        const box = lineBox(l.at ?? 0, end, l.width, lines.length === 0, place!.room);
        Object.assign(l, box);
        h = box.h;
        if (h > bandH + 1e-7 && !retry) retry = { retry: lines.length, h };
      }
      nextTop = place!.top + h;
      place = undefined;
    }
    lines.push(l);
    for (const f of deferred) f.place(nextTop);
    deferred = [];
  };
  const floats = opts.floats ?? [];
  let fq = 0;
  if (floats.length && !opts.band) approximate ??= "floats among text that doesn't wrap";
  if (floats.length && (lead || opts.strut)) approximate ??= "floats among text with a float at its start or inline boxes past its strut";
  /** Where each piece starts (a float inside a word is met mid-piece). */
  const pieceStarts = new Set<number>();
  for (let at = 0, k = 0; k < ps.length; at += [...ps[k]].length, k++) pieceStarts.add(at);
  pieceStarts.add(all.length);
  const meetFloat = (f: { at: number; w: number; fitsAt?: (top: number) => boolean; place: (top: number) => void }) => {
    if (!pieceStarts.has(f.at)) approximate ??= "a float inside a word";
    if (!line && !deferred.length) return f.place(nextTop);
    // What is on the line so far (a space at its end hangs: it doesn't count).
    const { used, lw } = lineWidth(line);
    const so = used + lw;
    if (line && !deferred.length && place && so + f.w <= maxWidth + 1 / 64 + TEXT_EPS / 64 && (!f.fitsAt || f.fitsAt(place.top))) {
      f.place(place.top);
      const at = opts.band!(place.top, opts.lineH ?? 0, () => true);
      maxWidth = at.r - at.l;
      place = { x: at.l, room: maxWidth, top: at.top };
    } else deferred.push(f);
  };
  if (opts.band && lead) approximate ??= "a float at the start of the text beside other floats";
  /**
   * Start a new line with piece p. With overflow-wrap: anywhere, a piece too wide for a line of
   * its own is broken between characters. Returns the open last fragment when it did: Chromium
   * then looks for break opportunities again from that fragment on, with nothing before it (so
   * "mid-2024" breaks as "m", "id", "-2"...: a "-" that starts a line doesn't break before a digit).
   */
  const start = (p: string, mid: boolean): string | undefined => {
    openLine(p);
    if (!opts.wrapAnywhere || fits(p)) return void (line = p);
    if (opts.band) approximate ??= "a word breaks between characters beside a float";
    // Grapheme clusters, with a soft hyphen kept with the cluster after it (Chromium never ends a
    // fragment on one).
    if (p.includes(SHY)) approximate ??= "a word with a soft hyphen breaks between characters";
    if (spans.length || lead) approximate ??= "a word breaks between characters in text with inline boxes of their own";
    const chars: string[] = [];
    let pending = "";
    for (const { segment: ch } of graphemes.segment(trimSpaces(p))) {
      if (ch === SHY) pending += ch;
      else {
        chars.push(pending + ch);
        pending = "";
      }
    }
    if (pending) chars.push(pending);
    let broke = false;
    /**
     * A fragment's width: on its own (`kerned` false), or as it sits in the word's shaping, with
     * the kerning to the cluster after it (the word's last fragment: to a space after it, as a line
     * end does).
     */
    const fragW = (frag: string, k: number, kerned = mid || broke) => {
      const next = chars[k]?.replaceAll(SHY, "") ?? (p.endsWith(" ") ? " " : undefined);
      return next && kerned ? w(frag + next) - w(next) : w(frag);
    };
    // A fragment fits as Chromium's shaping line breaker decides (pinned with a random tester:
    // 15,000 decisions on words in Inter, Roboto and Lato at 12-28px and four weights). It first
    // measures the fragment where it sits in the text's shaping (kerned to what follows) against
    // the line's width in layout units plus one. Where the break isn't safe (the font kerns across
    // it), it reshapes the fragment from the last safe point in it (its start, where that is safe)
    // to the break: the text before that point at its snapped position and the reshaped part's
    // width rounded up must fit in the line's width. With no safe point in it (the fragment starts
    // where the font kerns too), the shaping of its start already reached past the break: nothing
    // is reshaped. A safe point is one the font doesn't kern across.
    const lu = Math.floor(maxWidth * 64 + TEXT_EPS) / 64;
    const room = lu + 1 / 64 + TEXT_EPS / 64;
    const raw = (s: string) => measure(s, 0);
    // (A word's last fragment breaks after the space that follows it, where the line ends: safe.)
    const safeAt = (i: number) => i <= 0 || i >= all.length || all[i - 1] === " " || all[i] === " " || Math.abs(raw(all[i - 1] + all[i]) - raw(all[i - 1]) - raw(all[i])) < TEXT_EPS;
    const xs = new Map<number, number>();
    /** Where character i starts in the text's shaping. */
    const xAt = (i: number) => {
      let x = xs.get(i);
      if (x === undefined) xs.set(i, (x = i <= 0 ? 0 : raw(all.slice(0, i + 1).join("")) - raw(all[i])));
      return x;
    };
    const fitsFrag = (frag: string, k: number) => {
      if (!(fragW(frag, k, true) <= room)) return false;
      const s = consumed;
      const e = s + [...frag].length;
      // Letter-spaced text: on its own too (how its positions snap isn't pinned down).
      if (ls) return fragW(frag, k, false) <= room;
      if (e >= all.length || safeAt(e)) return true;
      let p = e - 1;
      while (p > s && !safeAt(p)) p--;
      if (p === s && !safeAt(s)) {
        // Kerned at both ends and everywhere inside: Chromium fits it by its width in the word's
        // shaping, or on its own, by something not pinned down; where those disagree it's flagged.
        if (!(raw(all.slice(s, e).join("")) <= room)) approximate ??= "a word breaks between characters the font kerns at both ends of a fragment";
        return true;
      }
      const snap = (x: number) => Math.floor(x * 64 + TEXT_EPS) / 64;
      return snap(xAt(p)) - snap(xAt(s)) + ceil64(raw(all.slice(p, e).join(""))) <= lu + TEXT_EPS / 64;
    };
    let cur = "";
    chars.forEach((ch, k) => {
      if (cur && !fitsFrag(cur + ch, k + 1)) {
        push({ text: cur, width: fragW(cur, k), at: consumed }, consumed + [...cur].length);
        consumed += [...cur].length;
        broke = true;
        cur = ch;
      } else cur += ch;
    });
    // Chromium never breaks inside a ligature glyph ("ffl" in Roboto): where the word breaks then
    // isn't known exactly. (Letter-spaced text has no ligatures.)
    const lig = broke && !ls ? m.ligatureIn(trimSpaces(p).replaceAll(SHY, "")) : undefined;
    if (lig) approximate ??= `a word with a ligature ("${lig}") breaks between characters`;
    if (!broke) return void (line = p);
    line = "";
    return cur + p.slice(trimSpaces(p).length);
  };
  /** A line's width as reported: measured item by item where inline boxes have edges or weights of their own. */
  const reported = (s: string) => {
    if (!spans.length && !lead) return w(s);
    const { used, lw } = lineWidth(s);
    return used + lw;
  };
  let queue = ps;
  let mid = false;
  for (let i = 0; i < queue.length; i++) {
    let p = queue[i];
    // Floats that occur before this piece.
    const s = consumed + [...line].length;
    while (fq < floats.length && floats[fq].at <= s) meetFloat(floats[fq++]);
    if (!line) openLine(p);
    // A piece ending in a soft hyphen that can't fit a line of its own is broken between
    // characters together with the rest of its word.
    while (opts.wrapAnywhere && p.endsWith(SHY) && i + 1 < queue.length && !fits(p)) p += queue[++i];
    // A first piece that doesn't fit beside the float at the start goes below it, on a line of its
    // own (the float is as tall as one line).
    if (!line && lead && !fits(p)) {
      push({ text: "", width: lead, at: consumed }, consumed);
      lead = 0;
    }
    let open: string | undefined;
    if (!line) open = start(p, mid);
    else if (fits(line + p)) line += p;
    else {
      push({ text: trimSpaces(line), width: reported(line), at: consumed }, consumed + [...line].length);
      consumed += [...line].length;
      lead = 0;
      open = start(p, mid);
    }
    mid = open !== undefined;
    if (open !== undefined) {
      queue = pieces(open + queue.slice(i + 1).join(""), mode);
      i = -1;
    }
  }
  while (fq < floats.length) meetFloat(floats[fq++]);
  if (line || !lines.length) push({ text: trimSpaces(line), width: reported(line), at: consumed }, consumed + [...line].length);
  if (retry) return retry;
  for (const f of deferred) f.place(nextTop);
  deferred = [];
  // Each line box: the strut and every inline box with content on the line (an empty one where it
  // stands), each placed by its vertical-align around the baseline.
  if (opts.strut && spans.some((sp) => sp.above !== undefined || sp.below !== undefined || sp.byExtent))
    lines.forEach((l, i) => Object.assign(l, lineBox(l.at ?? 0, lines[i + 1]?.at ?? all.length, l.width, i === 0, l.room ?? maxWidth)));
  let widestPiece = "";
  let minContent = 0;
  const piecesAt: { p: string; at: number }[] = [];
  const minPieces = mode === "normal" ? ps : piecesOf(text);
  for (let at = 0, k = 0; k < minPieces.length; at += [...minPieces[k]].length, k++) piecesAt.push({ p: minPieces[k], at });
  // With anywhere, any character is a soft wrap opportunity for min-content. Each character
  // counts with its kerning to the next one, a space included (Inter's thin "WW" kerns apart,
  // "… " together).
  const chars = [...text];
  const units = opts.wrapAnywhere && !opts.breakWord
    ? chars.flatMap((c, i) => {
        if (c === " " || c === SHY) return [];
        const next = chars[i + 1];
        const kern = next && next !== SHY ? measure(c + next) - measure(c) - measure(next) : 0;
        return [{ text: c, width: w(c) + kern }];
      })
    : mode !== "normal" && !spans.length && !edges.length
      ? piecesAt.map(({ p, at }) => {
          // Broken inside words (break-all, line-break: anywhere): as overflow-wrap: anywhere
          // counts a character, each piece with its kerning to the character after it.
          const body = trimSpaces(p).replaceAll(SHY, "");
          const next = all[at + [...trimSpaces(p)].length];
          // Its ends where they sit in the text's shaping, each rounded up to a layout unit (its end
          // is where the character after it starts: kerned to it).
          const n = [...body].length;
          const x1 = next && next !== SHY ? xIn(at + n) : xIn(at) + measure(body, at);
          return { text: body, width: ceil64(x1) - ceil64(xIn(at)) + spacing(body) };
        })
      : piecesAt.map(({ p, at }) => {
        // A piece is as wide as the distance between its ends in its item, each rounded up to a
        // layout unit (min-content is in layout units, like the line positions).
        // Positions include the letter-spacing of the characters before.
        const from = Math.max(0, ...edges.filter((b) => b <= at));
        const x0 = startOf(at) + spacing(all.slice(from, at).join("") + "x") - spacing("x");
        const len = [...p].length;
        const extra = edgesIn(at, at + len);
        // A piece in text of several weights: each part measured in its own font.
        const cs = [...p];
        const changes = cs.map((_, k) => k).filter((k) => k > 0 && !kerns(at + k));
        if (changes.length) {
          let width = 0;
          let a = 0;
          for (const c of [...changes, len]) {
            const seg = cs.slice(a, c).join("");
            width += c === len ? w(seg, true, at + a) : ceil64(full(seg, at + a));
            a = c;
          }
          return { text: trimSpaces(p), width: ceil64(width + extra) };
        }
        return { text: trimSpaces(p), width: ceil64(x0 + w(p, true, at)) - ceil64(x0) + extra };
      });
  if (opts.lead && opts.lead > minContent) {
    minContent = opts.lead;
    widestPiece = "";
  }
  for (const u of units) {
    if (u.width > minContent) {
      minContent = u.width;
      widestPiece = u.text;
    }
  }
  // Max-content: like a line, each inline item before the last rounded up to a layout unit (with
  // its kerning to the next character, which applies across the element's edge).
  const cuts = [0, ...edges, all.length];
  let maxContent = (opts.lead ?? 0) + edgesIn(0, all.length);
  for (let k = 0; k + 1 < cuts.length; k++) {
    const seg = all.slice(cuts[k], cuts[k + 1]).join("");
    const next = kerns(cuts[k + 1]) ? (all[cuts[k + 1]] ?? "").replaceAll(SHY, "") : "";
    maxContent += k + 2 < cuts.length ? ceil64(full(seg + next, cuts[k]) - full(next, cuts[k])) : w(seg, undefined, cuts[k]);
  }
  return { lines, maxContent, minContent, widestPiece, ...(approximate && { approximate }) };
}
