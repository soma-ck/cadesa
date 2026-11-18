/**
 * Text widths: the engine's measurement against a Chromium <span>, for debugging metrics.
 *
 *   tsx scripts/probe-widths.ts --size 42 --weight 700 "wait…" "Ærø"
 *   tsx scripts/probe-widths.ts --random 3000      (random words, sizes, weights; prints the worst)
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { metricsFor } from "../src/engine/text.js";
import { CHARS, findChrome } from "../src/metrics.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { size: { type: "string", default: "40" }, weight: { type: "string", default: "400" }, random: { type: "string" }, seed: { type: "string", default: "1" } },
});
const m = metricsFor("Inter")!;
const font = readFileSync("fonts/InterVariable-latin.woff2").toString("base64");
const browser = await chromium.launch({ executablePath: findChrome() });
const page = await browser.newPage();
await page.setContent(
  `<style>@font-face{font-family:Inter;font-weight:100 900;src:url(data:font/woff2;base64,${font}) format("woff2")} span{font-family:Inter;white-space:pre;font-kerning:normal}</style><span id=s></span>`,
);
await page.evaluate("document.fonts.load('400 20px Inter')");

type Q = { text: string; size: number; weight: number };
async function widths(qs: Q[]): Promise<number[]> {
  return (await page.evaluate(`(async (qs) => {
    const s = document.getElementById('s');
    const out = [];
    for (const q of qs) {
      s.style.fontSize = q.size + 'px'; s.style.fontWeight = q.weight; s.textContent = q.text;
      out.push(s.getBoundingClientRect().width);
    }
    return out;
  })(${JSON.stringify(qs)})`)) as number[];
}

let qs: Q[];
if (values.random) {
  let a = Number(values.seed) >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const chars = [...CHARS].filter((c) => c !== " " && c !== "­");
  qs = Array.from({ length: Number(values.random) }, () => ({
    text: Array.from({ length: 2 + Math.floor(rand() * 6) }, () => chars[Math.floor(rand() * chars.length)]).join(""),
    size: 40,
    weight: 100 + Math.floor(rand() * 801),
  }));
} else qs = positionals.map((text) => ({ text, size: Number(values.size), weight: Number(values.weight) }));

const got = await widths(qs);
const rows = qs.map((q, i) => ({ ...q, engine: m.measure(q.text, q.size, q.weight)!, chromium: got[i] })).map((r) => ({ ...r, delta: r.engine - r.chromium }));
rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
for (const r of rows.slice(0, values.random ? 40 : rows.length))
  console.log(`${JSON.stringify(r.text).padEnd(14)} ${r.size}px w${r.weight}  engine ${r.engine.toFixed(3)}  chromium ${r.chromium.toFixed(3)}  Δ ${r.delta.toFixed(3)}`);
if (values.random) console.log(`${rows.filter((r) => Math.abs(r.delta) > 0.05).length}/${rows.length} differ by more than 0.05px at 40px`);
await browser.close();
