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
  measure(text: string, sizePx: number, weight: number): number | undefined;
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
    measure(text, sizePx, weight) {
      const [wa, wb, t] = bracket(weight);
      const exact = fineRow(weight);
      const advA = exact ?? m.advances[wa];
      const advB = exact ?? m.advances[wb];
      const kernA = m.kerning[wa];
      const kernB = m.kerning[wb];
      let units = 0;
      let prev: string | undefined;
      for (const c of text) {
        const i = index.get(c);
        if (i === undefined) return undefined;
        units += advA[i] + (advB[i] - advA[i]) * t;
        if (prev !== undefined) {
          const pair = kernBase(prev) + kernBase(c);
          const ka = kernA[pair] ?? 0;
          const kb = kernB[pair] ?? 0;
          units += ka + (kb - ka) * t;
        }
        prev = c;
      }
      // Glyphs are scaled at the font size truncated to 1/64 px (38.64px draws at 38.625px).
      return (units / m.units) * (Math.floor(sizePx * 64 + 1e-6) / 64);
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
}

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
  const measure = (s: string) => m.measure(s, sizePx, weight) ?? 0;
  const spaceW = measure(" ");
  const w = (s: string) => {
    const t = trimSpaces(s);
    const body = t.replaceAll(SHY, "");
    // A line broken at a soft hyphen ends in a "-" that Chromium shapes on its own: no kerning
    // with the letter before it, and no letter-spacing.
    // A space hanging at the end of a line doesn't count, but in a plain block the kerning between
    // it and the character before does (Inter kerns ", " and ". "): Chromium keeps the line's
    // shaping. In a block that paints a background, border or shadow, or whose text is
    // underlined, it measures the line without that kerning (hangKern: false).
    const shaped = t.endsWith(SHY)
      ? measure(body) + measure("-")
      : opts.hangKern !== false && s.endsWith(" ") && body
        ? measure(body + " ") - spaceW
        : measure(body);
    const spaced = opts.spacesOnly ? [...body].filter((c) => c === " ").length : [...body].length;
    return shaped + (ls ? spaced * ls : 0);
  };
  const ps = pieces(text);
  const lines: Line[] = [];
  // Chromium truncates the line's width to a layout unit (1/64 px) before comparing: "a b" at
  // 55.508px fits in 55.5px.
  const fits = (s: string) => Math.floor(w(s) * 64 + 1e-6) / 64 <= maxWidth + 1e-6;
  let line = "";
  /** Start a new line with piece p. With overflow-wrap: anywhere, a piece too wide for a line of
   * its own is broken between characters; the last fragment stays open for the next pieces. */
  const start = (p: string) => {
    if (!opts.wrapAnywhere || fits(p)) return void (line = p);
    const trailing = p.slice(trimSpaces(p).length);
    let cur = "";
    for (const ch of trimSpaces(p)) {
      if (cur && !fits(cur + ch)) {
        lines.push({ text: cur, width: w(cur) });
        cur = ch;
      } else cur += ch;
    }
    line = cur + trailing;
  };
  for (const p of ps) {
    if (!line) start(p);
    else if (fits(line + p)) line += p;
    else {
      lines.push({ text: trimSpaces(line), width: w(line) });
      start(p);
    }
  }
  if (line || !lines.length) lines.push({ text: trimSpaces(line), width: w(line) });
  let widestPiece = "";
  let minContent = 0;
  // With anywhere, any character is a soft wrap opportunity for min-content.
  const units = opts.wrapAnywhere ? [...text].filter((c) => c !== " ") : ps;
  for (const p of units) {
    const pw = w(p);
    if (pw > minContent) {
      minContent = pw;
      widestPiece = trimSpaces(p);
    }
  }
  return { lines, maxContent: w(text), minContent, widestPiece };
}
