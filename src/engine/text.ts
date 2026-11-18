/**
 * Text measurement and line breaking for the reference engine.
 *
 * Widths come from a precomputed metrics table (glyph advances + pair kerning, sampled per
 * weight and interpolated). Line breaking is greedy, like CSS `white-space: normal` with
 * `overflow-wrap: normal`: break opportunities after spaces, after hyphens between letters,
 * and around dashes. Scope: Latin text in the measured character set.
 */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { metricsFileName, type MetricsFile } from "../metrics.js";

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
  const kernBase = (c: string) => (c.length === 1 && c.charCodeAt(0) > 0xff ? c : c.normalize("NFD")[0]);

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
