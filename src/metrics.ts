/**
 * Generate a Cascadio metrics table for a font: glyph advances and pair kerning, measured once in
 * Chromium. Requires Playwright (an optional peer dependency) and a Chrome/Chromium.
 *
 * Variable fonts are sampled every 100 weight units and interpolated. Static faces are stored at
 * their own weight; running the command again for another face of the same family merges it in.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

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
}

const UNITS = 10000;
const SIZE = 1000;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i));
const EXTRA = ["\u2018", "\u2019", "\u201C", "\u201D", "\u2013", "\u2014", "\u2026", "\u2022", "\u20AC", "\u2122"];
export const CHARS = [...range(0x20, 0x7e), ...range(0xa0, 0xff), ...EXTRA].join("");
const KERN_CHARS = [...range(0x20, 0x7e), ...EXTRA].join("");

const FORMATS: Record<string, string> = { ".woff2": "woff2", ".woff": "woff", ".ttf": "truetype", ".otf": "opentype" };

export function findChrome(): string | undefined {
  return (
    process.env.CASCADIO_CHROME ??
    [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ].find(existsSync)
  );
}

export const metricsFileName = (family: string) =>
  `${family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.metrics.json`;

export async function generateMetrics(opts: {
  font: string;
  family: string;
  /** Static face weight. Omit for a variable font (sampled 100–900). */
  weight?: number;
}): Promise<MetricsFile> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("cascadio metrics needs Playwright: npm i -D playwright (and a Chrome/Chromium, or npx playwright install chromium)");
  }
  const format = FORMATS[extname(opts.font).toLowerCase()];
  if (!format) throw new Error(`unsupported font file ${opts.font}; use .woff2, .woff, .ttf or .otf`);
  const weights = opts.weight ? [opts.weight] : [100, 200, 300, 400, 500, 600, 700, 800, 900];
  const executablePath = findChrome();
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage();
    const data = readFileSync(opts.font).toString("base64");
    const range = opts.weight ? `${opts.weight}` : "100 900";
    await page.setContent(
      `<style>@font-face{font-family:"__cascadio";font-weight:${range};src:url(data:font/${format};base64,${data}) format("${format}")}</style>`,
    );
    // Passed as a string so bundlers/transpilers can't inject helpers that don't exist in the page.
    const result = (await page.evaluate(`(async ({ CHARS, KERN_CHARS, WEIGHTS, SIZE, UNITS }) => {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.fontKerning = "normal";
      const advances = {}, kerning = {};
      for (const w of WEIGHTS) {
        await document.fonts.load(w + " " + SIZE + "px __cascadio");
        ctx.font = w + " " + SIZE + "px __cascadio";
        const width = (s) => ctx.measureText(s).width;
        advances[w] = [...CHARS].map((c) => Math.round((width(c) / SIZE) * UNITS));
        const kc = [...KERN_CHARS], single = new Map(kc.map((c) => [c, width(c)])), k = {};
        for (const a of kc) for (const b of kc) {
          const d = Math.round(((width(a + b) - single.get(a) - single.get(b)) / SIZE) * UNITS);
          if (d !== 0) k[a + b] = d;
        }
        kerning[w] = k;
      }
      return { advances, kerning, loaded: document.fonts.check(WEIGHTS[0] + " 16px __cascadio") };
    })(${JSON.stringify({ CHARS, KERN_CHARS, WEIGHTS: weights, SIZE, UNITS })})`)) as {
      advances: Record<string, number[]>;
      kerning: Record<string, Record<string, number>>;
      loaded: boolean;
    };
    if (!result.loaded) throw new Error(`${opts.font} did not load in Chromium`);
    return {
      family: opts.family,
      source: basename(opts.font),
      generatedWith: `Chromium ${browser.version()} canvas measureText, font-kerning: normal`,
      units: UNITS,
      kind: opts.weight ? "static" : "variable",
      weights,
      chars: CHARS,
      advances: result.advances,
      kerning: result.kerning,
    };
  } finally {
    await browser.close();
  }
}

/** Write metrics into `dir`, merging a static face into an existing static file for the family. */
export function writeMetrics(m: MetricsFile, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, metricsFileName(m.family));
  let out = m;
  if (m.kind === "static" && existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, "utf8")) as MetricsFile;
    if (prev.kind === "static" && prev.chars === m.chars) {
      const weights = [...new Set([...prev.weights, ...m.weights])].sort((a, b) => a - b);
      out = {
        ...m,
        source: [...new Set([...prev.source.split(", "), m.source])].join(", "),
        weights,
        advances: { ...prev.advances, ...m.advances },
        kerning: { ...prev.kerning, ...m.kerning },
      };
    }
  }
  writeFileSync(file, JSON.stringify(out) + "\n");
  return file;
}
