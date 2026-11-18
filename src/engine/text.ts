/**
 * Text measurement and line breaking for the reference engine.
 *
 * Widths come from a precomputed metrics table (glyph advances + pair kerning, sampled per
 * weight and interpolated). Line breaking is greedy, like CSS `white-space: normal` with
 * `overflow-wrap: normal`: break opportunities after spaces, and between other characters where
 * Chromium's line breaker puts them (hyphens, dashes, soft hyphens, some punctuation), from a
 * table measured once in Chromium (breaks.generated.ts). Scope: Latin text in the measured set.
 */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { metricsFileName, type MetricsFile } from "../metrics.js";
import { BREAK_CHARS, BREAKS } from "./breaks.generated.js";

export interface FontMetrics {
  family: string;
  file: string;
  /** Width in px, or undefined if the text has a character outside the measured set. */
  /** With `spaced`, as letter-spaced text (no contextual alternates); letter-spacing itself isn't added. */
  measure(text: string, sizePx: number, weight: number, spaced?: boolean): number | undefined;
  unsupported(text: string): string[];
  /** Why this weight can't be measured exactly (e.g. a synthesized bold), if so. */
  weightIssue(weight: number): string | undefined;
}

const registry = new Map<string, FontMetrics | undefined>();

/** CSS Fonts 4 §5.2 weight matching for a family made of static faces. */
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
  const m = JSON.parse(readFileSync(file, "utf8")) as MetricsFile;
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

  // Letter-spaced kerning: the normal table with the pairs that differ replaced, merged once.
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
    unsupported: (text) => [...new Set([...text].filter((c) => !index.has(c)))],
    weightIssue(weight) {
      if (kind !== "static") return undefined;
      const face = matchWeight(m.weights, weight);
      // Browsers synthesize bold when asking for ≥600 and the closest face is ≤500.
      if (weight >= 600 && face <= 500) return `weight ${weight} would be synthesized from the ${face} face; measure a bold face too`;
      return undefined;
    },
    measure(text, sizePx, weight, spaced) {
      const [wa, wb, t] = bracket(weight);
      const exact = fineRow(weight);
      const advA = exact ?? m.advances[wa];
      const advB = exact ?? m.advances[wb];
      const kernA = kerningAt(wa, !!spaced);
      const kernB = kerningAt(wb, !!spaced);
      let units = 0;
      let kern = 0;
      let prev: string | undefined;
      for (const c of text) {
        const i = index.get(c);
        if (i === undefined) return undefined;
        units += advA[i] + (advB[i] - advA[i]) * t;
        if (prev !== undefined) {
          const pair = kernBase(prev) + kernBase(c);
          const ka = kernA[pair] ?? 0;
          const kb = kernB[pair] ?? 0;
          kern += ka + (kb - ka) * t;
        }
        prev = c;
      }
      // Glyph advances come from the font set up at the quantized glyph size; kerning is applied by
      // the shaper at the size as specified.
      return (units / m.units) * glyphSize(sizePx) + (kern / m.units) * sizePx;
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
    fileURLToPath(new URL("../../fonts/", import.meta.url)),
  ];
}

/** Metrics for the first family in a font-family list, if it has been measured. */
export function metricsFor(fontFamily: string | undefined): FontMetrics | undefined {
  if (!fontFamily) return undefined;
  const first = fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
  const name = metricsFileName(first);
  const file = metricsDirs()
    .map((d) => join(d, name))
    .find(existsSync);
  const key = file ?? `missing:${name}`;
  if (!registry.has(key)) {
    const m = file ? load(file) : undefined;
    registry.set(key, m && m.family.toLowerCase() === first.toLowerCase() ? m : undefined);
  }
  return registry.get(key);
}

export interface Line {
  text: string;
  width: number;
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
 * The precision of measured text widths, in layout units (1/64 px): the metrics store advances to
 * a millionth of an em, so a width this close to a whole layout unit is taken to be on it.
 */
export const TEXT_EPS = 0.002;

const LETTER = /\p{L}/u;

const SHY = "­";

const breakIndex = new Map([...BREAK_CHARS].map((c, i) => [c, i]));
const breakBits = Buffer.from(BREAKS, "base64");
const N = breakIndex.size;

/** Whether Chromium may break between two non-space characters, given the character before `a`. */
function canBreak(before: string | undefined, a: string, b: string): boolean {
  const i = breakIndex.get(a);
  const j = breakIndex.get(b);
  // Outside the measured set the text is flagged anyway; keep to the plain rules.
  if (i === undefined || j === undefined) return (a === "-" || a === "–" || a === "—" || a === SHY) && LETTER.test(b);
  const ascii = before !== undefined && before < "\u0080";
  const ctx =
    before === undefined || before === " " ? 0 : ascii && /[A-Za-z]/.test(before) ? 1 : ascii && /[0-9]/.test(before) ? 2 : LETTER.test(before) ? 3 : 4;
  const bit = (ctx * N + i) * N + j;
  return (breakBits[bit >> 3] & (1 << (bit & 7))) !== 0;
}

/**
 * Split collapsed text into pieces that end at break opportunities (trailing space kept). Breaks
 * come after spaces, and between other characters where Chromium's line breaker allows them
 * (hyphens, dashes, soft hyphens, some punctuation), from a table measured in Chromium.
 */
export function pieces(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  const chars = [...text];
  chars.forEach((c, i) => {
    const next = chars[i + 1];
    cur += c;
    const breakAfter = next !== undefined && (c === " " ? next !== " " : next !== " " && canBreak(chars[i - 1], c, next));
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
  maxWidth: number,
  opts: { letterSpacing?: number; spacesOnly?: boolean; hangKern?: boolean; wrapAnywhere?: boolean } = {},
): TextLayout {
  // letter-spacing is added after every character, including the last one on a line (or, with
  // spacesOnly, after every U+0020 only).
  const ls = opts.letterSpacing ?? 0;
  // Letter-spaced text is shaped without contextual alternates.
  const measure = (s: string) => m.measure(s, sizePx, weight, ls !== 0) ?? 0;
  const spaceW = measure(" ");
  const w = (s: string, hangKern = opts.hangKern !== false) => {
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
      ? measure(body) + measure("-")
      : hangKern && s.endsWith(" ") && body
        ? measure(body + " ") - spaceW
        : measure(body);
    const spaced = opts.spacesOnly ? [...body].filter((c) => c === " ").length : [...body].length;
    return shaped + (ls ? spaced * ls : 0);
  };
  const ps = pieces(text);
  const lines: Line[] = [];
  const all = [...text];
  /** Characters of the text already placed on earlier lines. */
  let consumed = 0;
  /** Where the character at `at` starts in the text shaped as a whole (kerning with it included). */
  const startOf = (at: number) => {
    if (at === 0) return 0;
    const before = all.slice(0, at).join("").replaceAll(SHY, "");
    const next = (all[at] ?? "").replaceAll(SHY, "");
    const spaced = opts.spacesOnly ? [...before].filter((c) => c === " ").length : [...before].length;
    return measure(before + next) - measure(next) + (ls ? spaced * ls : 0);
  };
  // Chromium places a line by the positions of its ends in the text shaped as a whole, each
  // truncated to a layout unit (1/64 px), and compares their difference: "a b" at 55.508px fits in
  // 55.5px on a first line, but a later line can need one unit more.
  const fits = (s: string) => {
    const x0 = startOf(consumed);
    return Math.floor((x0 + w(s)) * 64 + TEXT_EPS) / 64 - Math.floor(x0 * 64 + TEXT_EPS) / 64 <= maxWidth + 1e-6;
  };
  let line = "";
  let approximate: string | undefined;
  /**
   * Start a new line with piece p. With overflow-wrap: anywhere, a piece too wide for a line of
   * its own is broken between characters. Returns the open last fragment when it did: Chromium
   * then looks for break opportunities again from that fragment on, with nothing before it (so
   * "mid-2024" breaks as "m", "id", "-2"...: a "-" that starts a line doesn't break before a digit).
   */
  const start = (p: string, mid: boolean): string | undefined => {
    if (!opts.wrapAnywhere || fits(p)) return void (line = p);
    // Graphemes, with a soft hyphen kept with the character after it (Chromium never ends a
    // fragment on one). A fragment that starts inside the word counts the kerning to the character
    // that follows it (Chromium measures it as shaped with the rest of the word); one that starts
    // the word is measured on its own.
    if (p.includes(SHY)) approximate ??= "a word with a soft hyphen breaks between characters";
    const chars: string[] = [];
    let pending = "";
    for (const ch of trimSpaces(p)) {
      if (ch === SHY) pending += ch;
      else {
        chars.push(pending + ch);
        pending = "";
      }
    }
    if (pending) chars.push(pending);
    let broke = false;
    const fragW = (frag: string, k: number, kerned = mid || broke) => {
      const next = chars[k]?.replaceAll(SHY, "");
      return next && kerned ? w(frag + next) - w(next) : w(frag);
    };
    let cur = "";
    chars.forEach((ch, k) => {
      if (cur) {
        // Both ways of measuring the fragment must agree, with room to spare.
        const a = fragW(cur + ch, k + 1, false);
        const b = fragW(cur + ch, k + 1, true);
        if (a <= maxWidth !== b <= maxWidth || Math.abs(a - maxWidth) < 0.1 || Math.abs(b - maxWidth) < 0.1)
          approximate ??= "a word breaks between characters close to the line's width";
      }
      if (cur && !(fragW(cur + ch, k + 1) <= maxWidth + 1e-6)) {
        lines.push({ text: cur, width: fragW(cur, k) });
        consumed += [...cur].length;
        broke = true;
        cur = ch;
      } else cur += ch;
    });
    if (!broke) return void (line = p);
    line = "";
    return cur + p.slice(trimSpaces(p).length);
  };
  let queue = ps;
  let mid = false;
  for (let i = 0; i < queue.length; i++) {
    let p = queue[i];
    // A piece ending in a soft hyphen that can't fit a line of its own is broken between
    // characters together with the rest of its word.
    while (opts.wrapAnywhere && p.endsWith(SHY) && i + 1 < queue.length && !fits(p)) p += queue[++i];
    let open: string | undefined;
    if (!line) open = start(p, mid);
    else if (fits(line + p)) line += p;
    else {
      lines.push({ text: trimSpaces(line), width: w(line) });
      consumed += [...line].length;
      open = start(p, mid);
    }
    mid = open !== undefined;
    if (open !== undefined) {
      queue = pieces(open + queue.slice(i + 1).join(""));
      i = -1;
    }
  }
  if (line || !lines.length) lines.push({ text: trimSpaces(line), width: w(line) });
  let widestPiece = "";
  let minContent = 0;
  // With anywhere, any character is a soft wrap opportunity for min-content. Each character
  // counts with its kerning to the next one (Inter's thin "WW" kerns apart).
  const chars = [...text];
  const units = opts.wrapAnywhere
    ? chars.flatMap((c, i) => {
        if (c === " " || c === SHY) return [];
        const next = chars[i + 1];
        const kern = next && next !== " " && next !== SHY ? measure(c + next) - measure(c) - measure(next) : 0;
        return [{ text: c, width: w(c) + kern }];
      })
    : ps.map((p) => ({ text: trimSpaces(p), width: w(p, true) }));
  for (const u of units) {
    if (u.width > minContent) {
      minContent = u.width;
      widestPiece = u.text;
    }
  }
  return { lines, maxContent: w(text), minContent, widestPiece, ...(approximate && { approximate }) };
}
