/**
 * Generate a Cadesa metrics table for a font: glyph advances and pair kerning, measured once in
 * Chromium, driven through playwright-core (a dependency) on an installed Chrome or Chromium.
 *
 * Variable fonts are sampled every 100 weight units and interpolated. Static faces are stored at
 * their own weight; running the command again for another face of the same family merges it in.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { fontFileInfo } from "./fontfile.js";

export interface MetricsFile {
  family: string;
  source: string;
  generatedWith: string;
  units: number;
  /** variable: interpolate between sampled weights. static: pick a face by CSS weight matching. */
  kind: "variable" | "static";
  weights: number[];
  chars: string;
  advances: Record<string, number[]>;
  kerning: Record<string, Record<string, number>>;
  /**
   * The pairs whose kerning differs when letter-spacing is on, per weight. Chromium turns off
   * contextual alternates in letter-spaced text, and Inter's case-sensitive forms (brackets and
   * dashes next to capitals) kern differently without them.
   */
  kerningSpaced?: Record<string, Record<string, number>>;
  /**
   * The characters whose pairs were measured. Older files measured ASCII only, and looked up an
   * accented letter's kerning through its base letter.
   */
  kernChars?: string;
  /**
   * Variable fonts: the advance of every character at every integer weight from `from` to `to`.
   * Browsers round each interpolated advance to a whole font unit, so interpolating between the
   * sampled weights is off by up to half a unit per glyph; this table is exact. Each entry of
   * `deltas` is one character's advance changes from one weight to the next, comma-separated
   * (`base` holds the advances at `from`).
   */
  fine?: {
    from: number;
    to: number;
    base: number[];
    deltas: string[];
    /**
     * The `contextual` runs, with their values at every integer weight (same encoding), and the
     * pairs that letter-spacing changes (ligatures), with their kerning at every integer weight.
     */
    runs?: string[];
    runBase?: number[];
    runDeltas?: string[];
  };
  /**
   * The font's units per em, or a divisor of it in which every advance and kerning value is a
   * whole number (the arithmetic is the same). Older files leave it out; the engine then tries the
   * usual sizes.
   */
  upm?: number;
  /** The font files measured (one per static face), with a hash: the table is exact for these bytes only. */
  files?: MetricsFace[];
  /**
   * Set when the font was measured as installed on this machine (a system font): another machine
   * may have a different font, or a different version, under the same name.
   */
  machineSpecific?: string;
  /** Characters of the measured set the font has no glyph for (a browser draws them from a fallback font). */
  missing?: string;
  /**
   * Per weight: what runs of three or more characters add to the sum of their advances and pair
   * kerning, where the font shapes them differently (ligatures like "ffi", contextual forms). Each
   * run's value excludes what its shorter runs already add. Not used in letter-spaced text, which
   * Chromium shapes without ligatures and contextual alternates.
   */
  contextual?: Record<string, Record<string, number>>;
  /**
   * Set when the font shapes more runs in context than the measurement looked at (a handwriting
   * font's contextual alternates): `contextual` is left empty, and text in the font is measured
   * as approximate.
   */
  contextualIncomplete?: boolean;
  /**
   * Vertical metrics as Chromium uses them (its font's ascent, descent, line gap and x-height),
   * measured at a font size of `size` px (the units per em, so they are whole font units), per
   * face weight (a variable font: at 400). Chromium rounds the ascent, descent and line gap to
   * whole px at each size; they place the baseline in a line box and size line-height: normal.
   * Tables from before they were measured leave them out.
   */
  vertical?: { size: number; byWeight: Record<string, VerticalMetrics> };
}

export interface VerticalMetrics {
  ascent: number;
  descent: number;
  lineGap: number;
  xHeight: number;
  /**
   * What a text field's width is made of: the font's average character width (OS/2
   * xAvgCharWidth, or the "0" glyph's advance) and its maximum character width (the font's bounding
   * box), as Chromium reads them, measured from <input size=1> and <input size=2> at the same size.
   * Tables from before they were measured leave them out.
   */
  avgChar?: number;
  maxChar?: number;
}

/**
 * Measure a font's vertical metrics in a Chromium page where it is loaded as `family` (a CSS
 * font-family value), at `size` px: canvas reports its ascent and descent, a line of line-height:
 * normal its line gap, and an ex its x-height.
 */
export async function measureVertical(page: import("playwright-core").Page, family: string, weight: number, size: number): Promise<VerticalMetrics> {
  return (await page.evaluate(`(async ({ FAMILY, W, S }) => {
    const font = W + " " + S + "px " + FAMILY;
    await document.fonts.load(font);
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = font;
    const m = ctx.measureText("x");
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;left:0;top:0;white-space:nowrap;line-height:normal;font:" + font + ";line-height:normal";
    box.innerHTML = 'x<span style="display:inline-block;width:1ex;height:0"></span>';
    document.body.appendChild(box);
    const out = { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent, lineGap: box.getBoundingClientRect().height - m.fontBoundingBoxAscent - m.fontBoundingBoxDescent, xHeight: box.lastChild.getBoundingClientRect().width };
    box.remove();
    // A text field's content width is ceil(average × size) + maximum - average, each rounded to px
    // (LayoutTextControlSingleLine): at a size of the units per em, both are whole font units.
    const field = (n) => {
      const i = document.createElement("input");
      i.size = n;
      i.style.cssText = "position:absolute;left:0;top:0;padding:0;border:0;box-sizing:content-box;font:" + font;
      document.body.appendChild(i);
      const w = i.getBoundingClientRect().width;
      i.remove();
      return w;
    };
    const one = field(1), two = field(2);
    out.avgChar = two - one;
    out.maxChar = one;
    return out;
  })(${JSON.stringify({ FAMILY: family, W: weight, S: size })})`)) as VerticalMetrics;
}

export interface MetricsFace {
  /** The file's name (or the installed family name, for a system font). */
  file: string;
  /** Where the file was downloaded from, for a web font. */
  url?: string;
  sha256?: string;
  /** The weights measured: one face ("700"), a variable font's range ("100 900"), or installed faces. */
  weight: string;
}

const UNITS = 1_000_000;
const SIZE = 1000;
/**
 * How many runs of one length the contextual-forms search measures per weight, at most (a Set
 * holds 2^24). Fonts with a few contextual forms stay well below it. A handwriting font with
 * contextual alternates on almost every pair (Caveat) would need billions, and so does Inter 4 from
 * Google Fonts (21,816 runs of three characters differ at weight 100, 46,200 of four, 85,299 of
 * five, past 34 million candidates of six): their tables say they are incomplete.
 */
const RUN_BUDGET = 4_000_000;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i));
const EXTRA = ["\u2018", "\u2019", "\u201C", "\u201D", "\u2013", "\u2014", "\u2026", "\u2022", "\u20AC", "\u2122", "\u202F", "\u2009", "\u2007"];
export const CHARS = [...range(0x20, 0x7e), ...range(0xa0, 0xff), ...EXTRA].join("");

const FORMATS: Record<string, string> = { ".woff2": "woff2", ".woff": "woff", ".ttf": "truetype", ".otf": "opentype" };

export function findChrome(): string | undefined {
  return (
    process.env.CADESA_CHROME ??
    [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/snap/bin/chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync)
  );
}

export const metricsFileName = (family: string) =>
  `${family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.metrics.json`;

/** Read a metrics file, plain or gzipped (`.metrics.json.gz`). */
export function readMetrics(file: string): MetricsFile {
  const raw = readFileSync(file);
  return JSON.parse((file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")) as MetricsFile;
}

export const NEEDS_PLAYWRIGHT =
  "this needs a Chrome, Chromium or Edge: install one, or point $CADESA_CHROME at its executable " +
  "(or run `npx playwright install chromium` once)";

export type Browser = import("playwright-core").Browser;

/**
 * Launch Chromium through playwright-core (a dependency, so it works under npx): the installed
 * Chrome or Chromium ($CADESA_CHROME first), or else a browser `npx playwright install` downloaded.
 */
export async function launchChromium(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  try {
    return await chromium.launch({ executablePath: findChrome() });
  } catch (e) {
    throw new Error(`could not start Chromium (${(e as Error).message.split("\n")[0]}); ${NEEDS_PLAYWRIGHT}`);
  }
}

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const FALLBACK_FONT = fileURLToPath(new URL("../fonts/InterVariable-latin.woff2", import.meta.url));

export async function generateMetrics(opts: {
  /** The font file. Leave out with `system`. */
  font?: string;
  family: string;
  /** Static face weight. Omit for a variable font (sampled 100–900). */
  weight?: number;
  /**
   * Measure the font installed on this machine under `family` instead of a file, as static faces
   * at these weights. The result is machine-specific.
   */
  system?: {
    weights: number[];
    /** The whole font-family list to resolve on this machine (default: `family` alone). */
    stack?: string;
  };
  /** Where the file was downloaded from (recorded in the metrics file). */
  url?: string;
  /** A browser to reuse (several faces in one run). */
  browser?: Browser;
  /** Characters to measure beyond the standard set (icon codepoints in the Private Use Area, other scripts). */
  extra?: string;
}): Promise<MetricsFile> {
  if (!opts.font && !opts.system) throw new Error("generateMetrics needs a font file or system");
  const format = opts.font ? FORMATS[extname(opts.font).toLowerCase()] : undefined;
  if (opts.font && !format) throw new Error(`unsupported font file ${opts.font}; use .woff2, .woff, .ttf or .otf`);
  const weights = opts.system
    ? [...new Set(opts.system.weights)].sort((a, b) => a - b)
    : opts.weight
      ? [opts.weight]
      : [100, 200, 300, 400, 500, 600, 700, 800, 900];
  const browser = opts.browser ?? (await launchChromium());
  try {
    const page = await browser.newPage();
    const bytes = opts.font ? readFileSync(opts.font) : undefined;
    const descriptor = opts.weight ? `${opts.weight}` : "100 900";
    // A second font (the bundled Inter) tells which characters the font has no glyph for: their
    // width changes with the fallback font.
    const fb = readFileSync(FALLBACK_FONT).toString("base64");
    const family = opts.system ? (opts.system.stack ?? JSON.stringify(opts.family)) : "__cadesa";
    await page.setContent(
      "<style>" +
        (bytes ? `@font-face{font-family:"__cadesa";font-weight:${descriptor};src:url(data:font/${format};base64,${bytes.toString("base64")}) format("${format}")}` : "") +
        `@font-face{font-family:"__cadesa_fb";font-weight:100 900;src:url(data:font/woff2;base64,${fb}) format("woff2")}</style>`,
    );
    // Passed as a string so bundlers/transpilers can't inject helpers that don't exist in the page.
    const result = (await page.evaluate(`(async ({ ALL, STD, WEIGHTS, SIZE, UNITS, RUN_BUDGET, FAMILY, FAMS }) => {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.fontKerning = "normal";
      const W0 = WEIGHTS[0];
      await document.fonts.load(W0 + " " + SIZE + "px " + FAMILY);
      await document.fonts.load("400 " + SIZE + "px __cadesa_fb");
      const widthIn = (font, s) => ((ctx.font = font), ctx.measureText(s).width);
      const f0 = W0 + " " + SIZE + "px " + FAMILY;
      const missing = [...ALL].filter((c) => widthIn(f0 + ", monospace", c) !== widthIn(f0 + ", __cadesa_fb", c));
      const CHARS = [...ALL].filter((c) => !missing.includes(c)).join("");
      // Characters measured beyond the standard set (icon codepoints) get widths, not kerning pairs.
      const KERN_CHARS = [...CHARS].filter((c) => STD.includes(c)).join("");
      // An optical-size axis: widths that don't scale with the font size can't come from one table.
      const sample = "Hamburgefonstiv HAMBURGEFONSTIV 0123456789";
      const big = widthIn(f0, sample);
      const small = widthIn(W0 + " 12px " + FAMILY, sample) * (SIZE / 12);
      const scales = Math.abs(big - small) / big < 2e-4;
      const advances = {}, kerning = {}, kerningSpaced = {}, contextual = {};
      let incomplete = false;
      for (const w of WEIGHTS) {
        await document.fonts.load(w + " " + SIZE + "px " + FAMILY);
        ctx.font = w + " " + SIZE + "px " + FAMILY;
        const width = (s) => ctx.measureText(s).width;
        advances[w] = [...CHARS].map((c) => Math.round((width(c) / SIZE) * UNITS));
        const kc = [...KERN_CHARS], single = new Map(kc.map((c) => [c, width(c)])), k = {};
        for (const a of kc) for (const b of kc) {
          const d = Math.round(((width(a + b) - single.get(a) - single.get(b)) / SIZE) * UNITS);
          if (d !== 0) k[a + b] = d;
        }
        kerning[w] = k;
        // Again with letter-spacing (which turns contextual alternates off); keep what differs.
        ctx.letterSpacing = "10px";
        const spaced = (s) => ctx.measureText(s).width - 10 * s.length;
        const singleS = new Map(kc.map((c) => [c, spaced(c)])), ks = {};
        // U+202F is left out: text with one and no letters isn't letter-spaced at all (measured
        // separately by the engine).
        for (const a of kc) for (const b of kc) {
          if (a === "\\u202f" || b === "\\u202f") continue;
          const d = Math.round(((spaced(a + b) - singleS.get(a) - singleS.get(b)) / SIZE) * UNITS);
          if (d !== (k[a + b] ?? 0)) ks[a + b] = d;
        }
        ctx.letterSpacing = "0px";
        kerningSpaced[w] = ks;
        // Runs of three or more characters that shape differently from their pairs (ligatures such
        // as "ffi", contextual forms): start from the pairs that letter-spacing changes (it turns
        // ligatures and contextual alternates off), and extend every run that differs by a character
        // on either side until none does.
        const units = (s) => Math.round((width(s) / SIZE) * UNITS);
        const advU = new Map(kc.map((c) => [c, Math.round((single.get(c) / SIZE) * UNITS)]));
        const cx = {};
        const model = (s) => {
          const cs = [...s];
          let u = 0;
          for (let i = 0; i < cs.length; i++) u += advU.get(cs[i]) + (i ? k[cs[i - 1] + cs[i]] ?? 0 : 0);
          for (let n = 3; n < cs.length; n++) for (let i = 0; i + n <= cs.length; i++) u += cx[cs.slice(i, i + n).join("")] ?? 0;
          return u;
        };
        // The search is bounded: a font that shapes almost every run in context (a handwriting
        // font's contextual alternates) would otherwise grow it past what a Set can hold. Past the
        // budget the table says it is incomplete, keeps no runs, and text in it is measured as
        // approximate.
        let budget = RUN_BUDGET;
        let over = false;
        const grow = (into, s) => {
          for (const c of kc) {
            if (budget <= 0) return void (over = true);
            if (!into.has(s + c)) (into.add(s + c), budget--);
            if (!into.has(c + s)) (into.add(c + s), budget--);
          }
        };
        let frontier = new Set();
        if (!incomplete) for (const p of Object.keys(ks)) grow(frontier, p);
        for (let n = 3; n <= 6 && frontier.size && !over; n++) {
          const next = new Set();
          budget = RUN_BUDGET;
          for (const s of frontier) {
            const d = units(s) - model(s);
            // Ten millionths of an em: well above rounding, well below any real difference.
            if (Math.abs(d) > 10) {
              cx[s] = d;
              if (n < 6) grow(next, s);
            }
          }
          frontier = next;
        }
        if (over) incomplete = true;
        contextual[w] = cx;
      }
      // An incomplete search measures nothing exactly: keep no runs (they would only make the table large).
      if (incomplete) for (const w of WEIGHTS) contextual[w] = {};
      let fine;
      if (WEIGHTS.length > 1 && FAMILY === "__cadesa") {
        const from = WEIGHTS[0], to = WEIGHTS[WEIGHTS.length - 1];
        const rows = [];
        for (let w = from; w <= to; w++) {
          await document.fonts.load(w + " " + SIZE + "px " + FAMILY);
          ctx.font = w + " " + SIZE + "px " + FAMILY;
          rows.push([...CHARS].map((c) => Math.round((ctx.measureText(c).width / SIZE) * UNITS)));
        }
        fine = {
          from, to, base: rows[0],
          deltas: [...CHARS].map((_, i) => rows.slice(1).map((r, k) => r[i] - rows[k][i]).join(",")),
        };
        // The runs' values at every integer weight too: a ligature's advance is whole font units at
        // each weight, not interpolated between the sampled ones.
        // Pairs that letter-spacing changes are ligatures too: their kerning is listed as a run.
        const runs = [...new Set([...Object.values(kerningSpaced), ...Object.values(contextual)].flatMap((c) => Object.keys(c)))]
          .filter((s) => !s.includes("\\u202f"))
          .sort((a, b) => [...a].length - [...b].length);
        if (runs.length) {
          const ci = new Map([...CHARS].map((c, i) => [c, i]));
          const rowsC = [];
          for (let w = from; w <= to; w++) {
            ctx.font = w + " " + SIZE + "px " + FAMILY;
            const hi = WEIGHTS.findIndex((x) => x >= w);
            const wa = WEIGHTS[Math.max(0, hi - 1)], wb = WEIGHTS[hi], t = wb === wa ? 0 : (w - wa) / (wb - wa);
            const adv = rows[w - from], cx = {};
            const kern = (p) => cx[p] ?? (kerning[wa][p] ?? 0) + ((kerning[wb][p] ?? 0) - (kerning[wa][p] ?? 0)) * t;
            for (const s of runs) {
              const cs = [...s];
              let u = 0;
              if (cs.length === 2) {
                cx[s] = Math.round((ctx.measureText(s).width / SIZE) * UNITS - adv[ci.get(cs[0])] - adv[ci.get(cs[1])]);
                continue;
              }
              for (let i = 0; i < cs.length; i++) u += adv[ci.get(cs[i])] + (i ? kern(cs[i - 1] + cs[i]) : 0);
              for (let n = 3; n < cs.length; n++) for (let i = 0; i + n <= cs.length; i++) u += cx[cs.slice(i, i + n).join("")] ?? 0;
              cx[s] = Math.round((ctx.measureText(s).width / SIZE) * UNITS - u);
            }
            rowsC.push(runs.map((s) => cx[s]));
          }
          fine.runs = runs;
          fine.runBase = rowsC[0];
          fine.runDeltas = runs.map((_, i) => rowsC.slice(1).map((r, k) => r[i] - rowsC[k][i]).join(","));
        }
      }
      // An installed font: the first family of the stack this machine has (a generic family always resolves).
      let resolved;
      for (const f of FAMS) {
        const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|math)$/i.test(f);
        const s = W0 + " " + SIZE + "px " + f;
        if (generic || widthIn(s + ", monospace", "Hamburgefonstiv") === widthIn(s + ", __cadesa_fb", "Hamburgefonstiv")) {
          resolved = f.replace(/^["']|["']$/g, "");
          break;
        }
      }
      const loaded = FAMILY === "__cadesa" ? document.fonts.check(W0 + " 16px __cadesa") : resolved !== undefined;
      return { chars: CHARS, missing: missing.join(""), scales, advances, kerning, kerningSpaced, contextual, incomplete, fine, loaded, resolved };
    })(${JSON.stringify({ ALL: [...new Set([...CHARS, ...[...(opts.extra ?? "")].slice(0, 512)])].join(""), STD: CHARS, WEIGHTS: weights, SIZE, UNITS, RUN_BUDGET, FAMILY: family, FAMS: family.split(",").map((f) => f.trim()) })})`)) as {
      resolved?: string;
      chars: string;
      missing: string;
      scales: boolean;
      advances: Record<string, number[]>;
      kerning: Record<string, Record<string, number>>;
      kerningSpaced: Record<string, Record<string, number>>;
      contextual: Record<string, Record<string, number>>;
      incomplete: boolean;
      fine?: MetricsFile["fine"];
      loaded: boolean;
    };
    // Vertical metrics at the units per em, where they are whole font units.
    const vSize = (bytes && fontFileInfo(bytes)?.unitsPerEm) || 2048;
    const vWeights = opts.system ? weights : [opts.weight ?? 400];
    const vertical: NonNullable<MetricsFile["vertical"]> = { size: vSize, byWeight: {} };
    if (result.loaded) for (const w of vWeights) vertical.byWeight[w] = await measureVertical(page, family, w, vSize);
    await page.close();
    if (!result.loaded)
      throw new Error(
        opts.system
          ? `${opts.system.stack ? `none of "${opts.system.stack}"` : `no font named "${opts.family}"`} is installed on this machine`
          : `${opts.font} did not load in Chromium`,
      );
    if (!result.scales)
      throw new Error(
        `${opts.font ?? `the installed font "${opts.family}"`} changes its glyph widths with the font size (an optical-size axis); Cadesa can't measure it from one table`,
      );
    const m: MetricsFile = {
      family: opts.family,
      source: opts.font ? basename(opts.font) : `installed font "${opts.family}"`,
      generatedWith: `Chromium ${browser.version()} canvas measureText, font-kerning: normal`,
      units: UNITS,
      kind: opts.weight || opts.system ? "static" : "variable",
      weights,
      chars: result.chars,
      advances: result.advances,
      kerning: result.kerning,
      kerningSpaced: result.kerningSpaced,
      kernChars: result.chars,
      ...(result.fine && { fine: result.fine }),
      ...(Object.values(result.contextual).some((c) => Object.keys(c).length) && { contextual: result.contextual }),
      ...(result.incomplete && { contextualIncomplete: true }),
      vertical,
    };
    const upm = (bytes && fontFileInfo(bytes)?.unitsPerEm) || unitsPerEm(m);
    if (upm) m.upm = upm;
    m.files = [
      {
        file: opts.font ? basename(opts.font) : opts.family,
        ...(opts.url && { url: opts.url }),
        ...(bytes && { sha256: sha256(bytes) }),
        weight: opts.system ? weights.join(" ") : descriptor,
      },
    ];
    if (result.missing) m.missing = result.missing;
    if (opts.system) {
      const as = result.resolved && result.resolved.toLowerCase() !== opts.family.toLowerCase() ? `"${result.resolved}" (the first of "${opts.system.stack}" installed)` : `"${opts.family}"`;
      m.source = `installed font ${as}`;
      m.files![0].file = result.resolved ?? opts.family;
      m.machineSpecific = `machine-specific: measured from ${as} as installed on one ${process.platform} machine; another machine may have a different font, or version, there`;
    }
    return m;
  } finally {
    if (!opts.browser) await browser.close();
  }
}

/**
 * The smallest units per em (the usual sizes first, then any) in which every advance and kerning
 * value is whole: widths can then be computed exactly as the browser does.
 */
export function unitsPerEm(m: MetricsFile): number | undefined {
  const values = [...Object.values(m.advances).flat(), ...Object.values(m.kerning).flatMap((k) => Object.values(k))];
  if (m.fine) values.push(...m.fine.base);
  const whole = (u: number) => values.every((a) => Math.abs((a / m.units) * u - Math.round((a / m.units) * u)) < 0.003);
  return [2048, 1000, 1024, 4096, 2000, 512, 256].find(whole) ?? Array.from({ length: 4096 - 16 }, (_, i) => i + 16).find(whole);
}

/** Keep only the characters in `keep`: every per-character array is re-indexed. */
function restrictChars(m: MetricsFile, keep: Set<string>): MetricsFile {
  const idx = [...m.chars].map((c, i) => (keep.has(c) ? i : -1)).filter((i) => i >= 0);
  const chars = idx.map((i) => [...m.chars][i]).join("");
  const pairs = (t: Record<string, Record<string, number>> | undefined) =>
    t && Object.fromEntries(Object.entries(t).map(([w, k]) => [w, Object.fromEntries(Object.entries(k).filter(([p]) => [...p].every((c) => keep.has(c))))]));
  return {
    ...m,
    chars,
    kernChars: chars,
    advances: Object.fromEntries(Object.entries(m.advances).map(([w, a]) => [w, idx.map((i) => a[i])])),
    kerning: pairs(m.kerning)!,
    ...(m.kerningSpaced && { kerningSpaced: pairs(m.kerningSpaced) }),
    ...(m.contextual && { contextual: pairs(m.contextual) }),
  };
}

/** The faces whose vertical metrics include a text field's character widths (tables from before them don't). */
function completeFaces(byWeight: Record<string, VerticalMetrics>): Record<string, VerticalMetrics> {
  return Object.fromEntries(Object.entries(byWeight).filter(([, f]) => f.avgChar !== undefined && f.maxChar !== undefined));
}

/**
 * Write metrics into `dir`, merging a static face into an existing static file for the family
 * (a face measured again replaces the old one). With `gzip`, writes `.metrics.json.gz`.
 */
export function writeMetrics(m: MetricsFile, dir: string, opts: { gzip?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  const plain = join(dir, metricsFileName(m.family));
  const file = opts.gzip ? `${plain}.gz` : plain;
  const existing = [plain, `${plain}.gz`].find(existsSync);
  let out = m;
  if (m.kind === "static" && existing) {
    let prev = readMetrics(existing);
    if (prev.kind === "static" && !!prev.machineSpecific === !!m.machineSpecific) {
      // Faces of one family can cover different characters: keep those every face has.
      let cur = m;
      if (prev.chars !== m.chars) {
        const both = new Set([...prev.chars].filter((c) => m.chars.includes(c)));
        prev = restrictChars(prev, both);
        cur = restrictChars(m, both);
      }
      const weights = [...new Set([...prev.weights, ...cur.weights])].sort((a, b) => a - b);
      const files = [...(prev.files ?? []).filter((f) => !cur.files?.some((g) => g.weight === f.weight)), ...(cur.files ?? [])];
      const missing = [...new Set([...(prev.missing ?? ""), ...(cur.missing ?? "")])].join("");
      out = {
        ...cur,
        source: [...new Set([...prev.source.split(", "), cur.source])].join(", "),
        weights,
        advances: { ...prev.advances, ...cur.advances },
        kerning: { ...prev.kerning, ...cur.kerning },
        ...((prev.kerningSpaced || cur.kerningSpaced) && { kerningSpaced: { ...prev.kerningSpaced, ...cur.kerningSpaced } }),
        ...((prev.contextual || cur.contextual) && { contextual: { ...prev.contextual, ...cur.contextual } }),
        // Each face's vertical metrics (at one size). A face measured by an older Cadesa, without
        // them or without character widths, keeps none: the table then says which faces to measure again.
        ...(cur.vertical
          ? { vertical: { size: cur.vertical.size, byWeight: { ...(prev.vertical?.size === cur.vertical.size ? completeFaces(prev.vertical.byWeight) : {}), ...cur.vertical.byWeight } } }
          : { vertical: undefined }),
        ...(files.length && { files }),
        ...(missing && { missing }),
        ...((prev.contextualIncomplete || cur.contextualIncomplete) && { contextualIncomplete: true }),
      };
      delete out.upm;
      const upm = prev.upm && prev.upm === cur.upm ? cur.upm : unitsPerEm(out);
      if (upm) out.upm = upm;
    }
  }
  if (existing && existing !== file) rmSync(existing);
  const json = JSON.stringify(out) + "\n";
  writeFileSync(file, opts.gzip ? gzipSync(json, { level: 9 }) : json);
  return file;
}
