/**
 * Text measurement and line breaking for the reference engine.
 *
 * Widths come from a precomputed metrics table (glyph advances + pair kerning, sampled per
 * weight and interpolated). Line breaking is greedy, like CSS `white-space: normal` with
 * `overflow-wrap: normal`: break opportunities after spaces, after hyphens between letters,
 * and around dashes. Scope: Latin text in the measured character set.
 */
import { readFileSync } from "node:fs";

interface MetricsFile {
  family: string;
  units: number;
  weights: number[];
  chars: string;
  advances: Record<string, number[]>;
  kerning: Record<string, Record<string, number>>;
}

export interface FontMetrics {
  family: string;
  /** Width in px, or undefined if the text has a character outside the measured set. */
  measure(text: string, sizePx: number, weight: number): number | undefined;
  unsupported(text: string): string[];
}

const registry = new Map<string, FontMetrics>();

function load(file: string): FontMetrics {
  const m = JSON.parse(readFileSync(new URL(`../../fonts/${file}`, import.meta.url), "utf8")) as MetricsFile;
  const index = new Map([...m.chars].map((c, i) => [c, i]));
  const kernBase = (c: string) => (c.length === 1 && c.charCodeAt(0) > 0xff ? c : c.normalize("NFD")[0]);

  // Interpolate between the two sampled weights around `weight`.
  const bracket = (weight: number): [number, number, number] => {
    const ws = m.weights;
    if (weight <= ws[0]) return [ws[0], ws[0], 0];
    if (weight >= ws[ws.length - 1]) return [ws[ws.length - 1], ws[ws.length - 1], 0];
    const hi = ws.findIndex((w) => w >= weight);
    const a = ws[hi - 1];
    const b = ws[hi];
    return [a, b, (weight - a) / (b - a)];
  };

  return {
    family: m.family,
    unsupported: (text) => [...new Set([...text].filter((c) => !index.has(c)))],
    measure(text, sizePx, weight) {
      const [wa, wb, t] = bracket(weight);
      const advA = m.advances[wa];
      const advB = m.advances[wb];
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
      return (units / m.units) * sizePx;
    },
  };
}

/** Metrics for the first family in a font-family list, if Cascadio has measured it. */
export function metricsFor(fontFamily: string | undefined): FontMetrics | undefined {
  if (!fontFamily) return undefined;
  const first = fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (first !== "inter") return undefined;
  if (!registry.has(first)) registry.set(first, load("inter.metrics.json"));
  return registry.get(first);
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

/** Split collapsed text into pieces that end at break opportunities (trailing space kept). */
export function pieces(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  const chars = [...text];
  chars.forEach((c, i) => {
    const next = chars[i + 1];
    if (c === "—" && cur && !cur.endsWith(" ")) {
      out.push(cur); // break before an em dash
      cur = "";
    }
    cur += c;
    const breakAfter =
      (c === " " && next !== " ") ||
      (c === "-" && LETTER.test(chars[i - 1] ?? "") && LETTER.test(next ?? "")) ||
      ((c === "–" || c === "—") && next !== undefined && next !== " ");
    if (breakAfter) {
      out.push(cur);
      cur = "";
    }
  });
  if (cur) out.push(cur);
  return out;
}

export function layoutText(
  m: FontMetrics,
  text: string,
  sizePx: number,
  weight: number,
  maxWidth: number,
): TextLayout {
  const w = (s: string) => m.measure(s.trimEnd(), sizePx, weight) ?? 0;
  const ps = pieces(text);
  const lines: Line[] = [];
  let line = "";
  for (const p of ps) {
    if (!line) {
      line = p;
      continue;
    }
    // Chromium compares in 1/64px layout units; allow that much slack.
    if (w(line + p) <= maxWidth + 1 / 64) line += p;
    else {
      lines.push({ text: line.trimEnd(), width: w(line) });
      line = p;
    }
  }
  if (line || !lines.length) lines.push({ text: line.trimEnd(), width: w(line) });
  let widestPiece = "";
  let minContent = 0;
  for (const p of ps) {
    const pw = w(p);
    if (pw > minContent) {
      minContent = pw;
      widestPiece = p.trimEnd();
    }
  }
  return { lines, maxContent: w(text), minContent, widestPiece };
}
