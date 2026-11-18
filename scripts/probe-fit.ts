/**
 * The narrowest container (in 1/64 px) that fits a text on one line in Chromium, against the
 * engine's line width, for debugging line-fit decisions.
 *
 *   tsx scripts/probe-fit.ts --size 40 --weight 100 --ls 0.009 "déjà self­contained"
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { layoutText, metricsFor } from "../src/engine/text.js";
import { findChrome } from "../src/metrics.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { size: { type: "string", default: "40" }, weight: { type: "string", default: "400" }, ls: { type: "string", default: "0" } },
});
const size = Number(values.size);
const weight = Number(values.weight);
const ls = Number(values.ls);
const m = metricsFor("Inter")!;
const font = readFileSync("fonts/InterVariable-latin.woff2").toString("base64");
const browser = await chromium.launch({ executablePath: findChrome() });
const page = await browser.newPage();
await page.setContent(
  `<style>@font-face{font-family:Inter;font-weight:100 900;src:url(data:font/woff2;base64,${font}) format("woff2")} div{font-family:Inter;line-height:1;hyphens:manual;font-kerning:normal}</style><div id=d></div>`,
);
await page.evaluate(`document.fonts.load('${weight} ${size}px Inter')`);
for (const text of positionals) {
  const fit = (await page.evaluate(`(() => {
    const d = document.getElementById('d');
    d.style.cssText = 'font-size:${size}px;font-weight:${weight};letter-spacing:${ls}em';
    d.textContent = ${JSON.stringify(text)};
    let lo = 0, hi = 64 * 2000;
    while (lo < hi) { const mid = (lo + hi) >> 1; d.style.width = (mid / 64) + 'px'; if (d.getBoundingClientRect().height <= ${size} * 1.01) hi = mid; else lo = mid + 1; }
    return lo / 64;
  })()`)) as number;
  const one = layoutText(m, text, size, weight, Infinity, { letterSpacing: ls * size });
  console.log(`${JSON.stringify(text)}: chromium fits from ${fit}px; engine line width ${one.lines[0].width.toFixed(4)} (Δ ${(one.lines[0].width - fit).toFixed(4)})`);
}
await browser.close();
