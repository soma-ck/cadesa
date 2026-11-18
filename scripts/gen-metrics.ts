/**
 * Generate fonts/inter.metrics.json: glyph advances and pair kerning for the bundled Inter
 * variable font, measured once in Chromium at dev time. The runtime engine reads only this
 * JSON, so measuring text never needs a browser or a font parser.
 *
 *   npx tsx scripts/gen-metrics.ts
 *
 * Units are 1/10000 em. Weights are sampled every 100 and interpolated linearly.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const FONT = "fonts/InterVariable-latin.woff2";
const OUT = "fonts/inter.metrics.json";
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const SIZE = 1000; // px; measured widths are divided by this to get em
const UNITS = 10000;

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i));
const extra = ["‘", "’", "“", "”", "–", "—", "…", "•", "€", "™"];
/** Every character the engine can measure. */
const CHARS = [...range(0x20, 0x7e), ...range(0xa0, 0xff), ...extra].join("");
/** Characters with their own kerning pairs. Accented letters reuse their base letter's pairs. */
const KERN_CHARS = [...range(0x20, 0x7e), ...extra].join("");

const executablePath =
  process.env.CASCADIO_CHROME ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find(existsSync);
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
const font = readFileSync(FONT).toString("base64");
await page.setContent(
  `<style>@font-face{font-family:"Inter";font-weight:100 900;src:url(data:font/woff2;base64,${font}) format("woff2")}</style>`,
);

// Passed as a string: tsx would otherwise inject helpers (e.g. __name) that don't exist in the page.
const MEASURE = `(async ({ CHARS, KERN_CHARS, WEIGHTS, SIZE, UNITS }) => {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fontKerning = "normal";
  const advances = {}, kerning = {};
  for (const w of WEIGHTS) {
    await document.fonts.load(w + " " + SIZE + "px Inter");
    ctx.font = w + " " + SIZE + "px Inter";
    const width = (s) => ctx.measureText(s).width;
    advances[w] = [...CHARS].map((c) => Math.round((width(c) / SIZE) * UNITS));
    const kc = [...KERN_CHARS], single = new Map(kc.map((c) => [c, width(c)])), k = {};
    for (const a of kc) for (const b of kc) {
      const d = Math.round(((width(a + b) - single.get(a) - single.get(b)) / SIZE) * UNITS);
      if (d !== 0) k[a + b] = d;
    }
    kerning[w] = k;
  }
  return { advances, kerning, loaded: document.fonts.check("400 16px Inter") };
})(${JSON.stringify({ CHARS, KERN_CHARS, WEIGHTS, SIZE, UNITS })})`;
const result = (await page.evaluate(MEASURE)) as {
  advances: Record<string, number[]>;
  kerning: Record<string, Record<string, number>>;
  loaded: boolean;
};
await browser.close();
if (!result.loaded) throw new Error("Inter did not load; metrics would describe a fallback font");

const json = {
  family: "Inter",
  source: `${FONT} (Inter 4, SIL OFL 1.1, latin subset, wght axis)`,
  generatedWith: `Chromium ${browser.version()} canvas measureText, font-kerning: normal`,
  units: UNITS,
  weights: WEIGHTS,
  chars: CHARS,
  advances: result.advances,
  kerning: result.kerning,
};
writeFileSync(OUT, JSON.stringify(json) + "\n");
const pairs = Object.values(result.kerning).reduce((n, k) => n + Object.keys(k).length, 0);
console.log(`wrote ${OUT}: ${CHARS.length} glyphs × ${WEIGHTS.length} weights, ${pairs} kerning pairs, ${(JSON.stringify(json).length / 1024).toFixed(0)} KB`);
