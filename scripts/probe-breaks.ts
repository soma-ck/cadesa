/**
 * Line-break opportunities: the engine's `pieces()` against Chromium at min-content width.
 *
 *   tsx scripts/probe-breaks.ts "mid-2024" "self­contained"   (print Chromium's lines)
 *   tsx scripts/probe-breaks.ts --random 5000 [--seed 1]            (differential: random strings)
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { pieces } from "../src/engine/text.js";
import { CHARS, findChrome } from "../src/metrics.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { random: { type: "string" }, seed: { type: "string", default: "1" } } });

const font = readFileSync("fonts/InterVariable-latin.woff2").toString("base64");
const browser = await chromium.launch({ executablePath: findChrome() });
const page = await browser.newPage();
await page.setContent(
  `<style>@font-face{font-family:Inter;font-weight:100 900;src:url(data:font/woff2;base64,${font}) format("woff2")} div{font:400 20px/1 Inter;width:0;hyphens:manual;white-space:normal;overflow-wrap:normal;word-break:normal}</style><div id=d></div>`,
);
await page.evaluate("document.fonts.load('400 20px Inter')");

/** Chromium's lines for each string at width 0 (every break opportunity taken). */
async function lines(strings: string[]): Promise<string[][]> {
  return (await page.evaluate(`((ss) => ss.map((s) => {
    const d = document.getElementById('d');
    d.textContent = s;
    const t = d.firstChild, r = document.createRange(), out = [];
    const chars = [...s];
    let top = null, cur = '', off = 0;
    for (const c of chars) {
      r.setStart(t, off); r.setEnd(t, off + c.length); off += c.length;
      const rects = [...r.getClientRects()].filter((x) => x.width > 0 || x.height > 0);
      const y = rects.length ? rects[rects.length - 1].top : top;
      if (top !== null && y !== top && cur) { out.push(cur); cur = ''; }
      top = y; cur += c;
    }
    out.push(cur);
    return out;
  }))(${JSON.stringify(strings)})`)) as string[][];
}

const unescape = (raw: string) => JSON.parse(`"${raw.replace(/"/g, '\\"')}"`) as string;

if (values.random) {
  let a = Number(values.seed) >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (s: string) => [...s][Math.floor(rand() * [...s].length)];
  const letters = "abcxyzABCéüßÆø";
  const digits = "0123456789";
  const chars = [...CHARS].filter((c) => c !== " ");
  const n = Number(values.random);
  const strings: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = 2 + Math.floor(rand() * 6);
    let s = "";
    for (let j = 0; j < len; j++) {
      const r = rand();
      s += r < 0.35 ? pick(letters) : r < 0.5 ? pick(digits) : r < 0.6 ? " " : pick(chars.join(""));
    }
    s = s.replace(/ +/g, " ").trim();
    if (s) strings.push(s);
  }
  let bad = 0;
  for (let i = 0; i < strings.length; i += 500) {
    const batch = strings.slice(i, i + 500);
    const got = await lines(batch);
    batch.forEach((s, k) => {
      const mine = pieces(s).map((p) => p.trim()).filter(Boolean);
      const theirs = got[k].map((p) => p.trim()).filter(Boolean);
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
        bad++;
        if (bad <= 60) console.log(`${JSON.stringify(s)}  engine ${mine.map((x) => JSON.stringify(x)).join("|")}  chromium ${theirs.map((x) => JSON.stringify(x)).join("|")}`);
      }
    });
  }
  console.log(`${strings.length - bad}/${strings.length} strings break the same way`);
  process.exitCode = bad ? 1 : 0;
} else {
  const inputs = positionals.map(unescape);
  const got = await lines(inputs);
  inputs.forEach((s, i) => console.log(JSON.stringify(s), "→", got[i].map((l) => JSON.stringify(l)).join(" | "), "   engine:", pieces(s).map((l) => JSON.stringify(l)).join(" | ")));
}
await browser.close();
