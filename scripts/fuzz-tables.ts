/**
 * Differential fuzzer for tables: random HTML tables with random CSS (separated and collapsed
 * borders, border spacing, padding, widths, colspans, rowspans, captions, columns, vertical-align,
 * fixed layout), lifted the way `check --css` lifts a page and laid out by the engine, compared with
 * Chromium box by box. Every box the lift and engine mark exact must match within the tolerance.
 *
 *   npm run fuzz:tables -- --cases 300 --seed 1
 *   npm run fuzz:tables -- --seeds 17,42          (re-run particular cases, printing every box)
 *   npm run fuzz:tables -- --replay               (re-check the saved failing cases as they are)
 *
 * A failing case is written to artifacts/fuzz-tables/<seed>/ (page.html, page.css, report.txt).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { measureBoxes, rectDelta, serveFiles, settle } from "../src/browser.js";
import { walk } from "../src/engine/layout.js";
import { cssPageFile, tailwindImpact } from "../src/commands.js";
import { loadSource } from "../src/load.js";
import { launchChromium } from "../src/metrics.js";
import { modelOf, render } from "../src/project.js";

const { values: args } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    cases: { type: "string", default: "200" },
    seeds: { type: "string" },
    tolerance: { type: "string", default: "0.5" },
    out: { type: "string", default: "artifacts/fuzz-tables" },
    workers: { type: "string", default: "6" },
    /** Re-run the saved failing cases in --out (or those of --seeds) as they are. */
    replay: { type: "boolean", default: false },
  },
});
const TOL = Number(args.tolerance);
const ROOT = process.cwd();

function rng(seed: number) {
  let a = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
  };
}
type Rng = ReturnType<typeof rng>;

const WORDS = "order customer status quantity shipped north yard harbor supply field works ridge tools planned picking on hold total due date carrier freight coastal haulage blue line in transit loading arrives departs 12 May 08:00 SO-1042 1,284 a an of the".split(" ");
const words = (r: Rng, lo: number, hi: number) => Array.from({ length: r.int(lo, hi) }, () => r.pick(WORDS)).join(" ");

/** One random case: a page with one or two tables and their stylesheet. */
function genCase(seed: number): { html: string; css: string; widths: number[] } {
  const r = rng(seed);
  const css: string[] = [
    `@font-face { font-family: "Inter"; font-weight: 100 900; src: url("../../../fonts/InterVariable-latin.woff2") format("woff2"); }`,
    `body { margin: 8px; font-family: Inter; font-size: 16px; line-height: 1.5; color: #222; }`,
  ];
  let n = 0;
  const cls = (decls: string[]) => {
    if (!decls.length) return "";
    const c = `k${++n}`;
    css.push(`.${c} { ${decls.join("; ")} }`);
    return c;
  };
  const px = (lo: number, hi: number) => `${r.int(lo, hi)}px`;
  const border = (lo = 0, hi = 4) => {
    const out: string[] = [];
    for (const s of ["top", "right", "bottom", "left"]) if (r.chance(0.5)) out.push(`border-${s}: ${px(lo, hi)} ${r.pick(["solid", "solid", "dashed"])} #555`);
    return out;
  };
  const textStyle = () => {
    const out: string[] = [];
    if (r.chance(0.3)) out.push(`font-size: ${r.int(12, 20)}px`);
    if (r.chance(0.3)) out.push(`line-height: ${r.pick(["1.2", "1.25", "1.4", "1.6", "20px", "1"])}`);
    if (r.chance(0.2)) out.push(`font-weight: ${r.pick(["400", "600", "700"])}`);
    if (r.chance(0.15)) out.push("white-space: nowrap");
    if (r.chance(0.2)) out.push(`text-align: ${r.pick(["center", "right", "left"])}`);
    return out;
  };
  css.push(".blk { height: 18px; background: #ddd }");
  css.push(".pill { display: inline-block; padding: 2px 6px; font-size: 12px; line-height: 1.5; border-radius: 4px; background: #eee }");
  css.push(".dt { display: table } .dcap { display: table-caption } .dhead { display: table-header-group } .dbody { display: table-row-group } .dfoot { display: table-footer-group } .drow { display: table-row } .dcell { display: table-cell }");
  const tables: string[] = [];
  const count = r.chance(0.3) ? 2 : 1;
  for (let t = 0; t < count; t++) {
    // display: table on <div>s instead of table elements.
    const divs = r.chance(0.2);
    const tag = (name: string) => (divs ? "div" : name);
    const dcls = (name: string, c: string) => (divs ? [{ table: "dt", caption: "dcap", thead: "dhead", tbody: "dbody", tfoot: "dfoot", tr: "drow", td: "dcell", th: "dcell" }[name]!, c].filter(Boolean).join(" ") : c);
    const attrs = (name: string, a: string) => (divs ? "" : a);
    const collapse = r.chance(0.5);
    const fixed = r.chance(0.2);
    const tdecls: string[] = [`border-collapse: ${collapse ? "collapse" : "separate"}`];
    if (r.chance(0.1)) tdecls.push(`min-width: ${px(200, 700)}`);
    if (!collapse && r.chance(0.6)) tdecls.push(`border-spacing: ${r.chance(0.5) ? px(0, 8) : `${px(0, 8)} ${px(0, 8)}`}`);
    if (r.chance(0.4)) tdecls.push(...border(1, 5).map((b) => b.replace(/^border-(\w+): (\S+) \S+/, "border-$1: $2 solid")));
    if (r.chance(0.3)) tdecls.push(`padding: ${px(0, 10)}`);
    const width = r.pick(["auto", "auto", "100%", "100%", "60%", "400px", "250px"]);
    if (width !== "auto") tdecls.push(`width: ${width}`);
    if (fixed && width !== "auto") tdecls.push("table-layout: fixed");
    if (r.chance(0.15)) tdecls.push(`height: ${px(60, 300)}`);
    if (r.chance(0.3)) tdecls.push(`margin: ${px(0, 16)} 0`);
    const cellPad = r.chance(0.7) ? `padding: ${px(0, 10)} ${px(0, 12)}` : undefined;
    const cellBase = [...(cellPad ? [cellPad] : []), ...(r.chance(0.5) ? [`border-bottom: ${px(1, 3)} solid #ccc`] : []), ...(r.chance(0.3) ? [`vertical-align: ${r.pick(["top", "middle", "bottom", "baseline"])}`] : [])];
    const tcls = cls(tdecls);
    // Bootstrap's reset: every table part has a solid border of no width.
    if (r.chance(0.2)) css.push(`.${tcls} thead, .${tcls} tbody, .${tcls} tfoot, .${tcls} tr, .${tcls} td, .${tcls} th, .${tcls} .dcell, .${tcls} .drow { border-style: solid; border-width: 0; border-color: inherit }`);
    if (cellBase.length) css.push(`.${tcls} td, .${tcls} th, .${tcls} .dcell { ${cellBase.join("; ")} }`);
    const cols = r.int(1, 5);
    const tattrs = [r.chance(0.1) ? ` cellspacing="${r.int(0, 6)}"` : "", r.chance(0.1) ? ` cellpadding="${r.int(0, 8)}"` : "", r.chance(0.05) ? ` border="${r.int(0, 3)}"` : ""].join("");
    let h = `<${tag("table")} class="${dcls("table", tcls)}"${attrs("table", tattrs)}>`;
    if (r.chance(0.25)) {
      const cc = cls([...(r.chance(0.5) ? ["caption-side: bottom"] : []), ...(r.chance(0.5) ? [`padding: ${px(0, 8)}`] : []), ...(r.chance(0.3) ? [`margin: ${px(0, 6)}`] : []), ...(r.chance(0.15) ? [`width: ${px(60, 300)}; margin-left: auto; margin-right: auto`] : [])]);
      h += `<${tag("caption")}${dcls("caption", cc) ? ` class="${dcls("caption", cc)}"` : ""}>${words(r, 1, 8)}</${tag("caption")}>`;
    }
    if (!divs && r.chance(0.25)) {
      h += "<colgroup>";
      const k = r.int(1, cols);
      for (let i = 0; i < k; i++) {
        const span = r.chance(0.2) ? r.int(2, 3) : 1;
        const cc = cls(r.chance(0.6) ? [`width: ${r.chance(0.7) ? px(20, 160) : `${r.int(5, 40)}%`}`] : []);
        h += `<col${cc ? ` class="${cc}"` : ""}${span > 1 ? ` span="${span}"` : ""}>`;
      }
      h += "</colgroup>";
    }
    const section = (name: string, rows: number, th: boolean) => {
      const sc = dcls(name, cls(collapse && r.chance(0.3) ? border(1, 4) : []));
      let s = `<${tag(name)}${sc ? ` class="${sc}"` : ""}>`;
      for (let i = 0; i < rows; i++) {
        const rc = dcls("tr", cls([...(collapse && r.chance(0.2) ? border(1, 3) : []), ...(r.chance(0.1) ? [`height: ${px(20, 80)}`] : [])]));
        s += `<${tag("tr")}${rc ? ` class="${rc}"` : ""}${attrs("tr", r.chance(0.05) ? ` valign="${r.pick(["top", "bottom", "middle"])}"` : "")}>`;
        let c = 0;
        while (c < cols) {
          const colspan = !divs && r.chance(0.12) ? Math.min(r.int(2, 3), cols - c + (r.chance(0.2) ? 1 : 0)) : 1;
          const rowspan = !divs && r.chance(0.08) ? r.pick([2, 2, 3, 0]) : 1;
          const decls = [...textStyle()];
          if (r.chance(0.2)) decls.push(...border(1, 4));
          if (r.chance(0.2)) decls.push(`padding: ${px(0, 10)}`);
          if (r.chance(0.15)) decls.push(`width: ${r.chance(0.7) ? px(10, 200) : `${r.int(5, 50)}%`}`);
          if (r.chance(0.08)) decls.push(`height: ${px(10, 90)}`);
          if (r.chance(0.25)) decls.push(`vertical-align: ${r.pick(["top", "middle", "bottom", "baseline"])}`);
          if (r.chance(0.15)) decls.push("box-sizing: border-box");
          if (r.chance(0.05)) decls.push(r.chance(0.5) ? "max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" : `max-width: ${px(20, 160)}`);
          const cc = dcls("td", cls(decls));
          const t = tag(th ? "th" : "td");
          const content = r.chance(0.08) ? "" : r.chance(0.15) ? `<div>${words(r, 1, 6)}</div><div>${words(r, 1, 6)}</div>` : r.chance(0.06) ? `<span class="pill">${words(r, 1, 2)}</span>` : r.chance(0.04) ? `<div class="blk"></div>` : words(r, 0, r.chance(0.3) ? 14 : 4) || "x";
          const ca = attrs("td", [r.chance(0.05) ? ` width="${r.chance(0.7) ? r.int(20, 150) : `${r.int(5, 40)}%`}"` : "", r.chance(0.05) ? ` valign="${r.pick(["top", "bottom", "middle", "baseline"])}"` : "", r.chance(0.04) ? " nowrap" : ""].join(""));
          s += `<${t}${cc ? ` class="${cc}"` : ""}${colspan > 1 ? ` colspan="${colspan}"` : ""}${rowspan !== 1 ? ` rowspan="${rowspan}"` : ""}${ca}>${content}</${t}>`;
          c += colspan;
        }
        s += `</${tag("tr")}>`;
      }
      return s + `</${tag(name)}>`;
    };
    if (r.chance(0.5)) h += section("thead", 1, true);
    h += section("tbody", r.int(1, 4), false);
    if (r.chance(0.2)) h += section("tbody", r.int(1, 2), false);
    if (r.chance(0.2)) h += section("tfoot", 1, false);
    h += `</${tag("table")}>`;
    // Around it: nothing, a narrower or padded block, a flex row or column, or a grid.
    const around = r.pick(["none", "none", "none", "width", "padding", "flex", "column", "grid"] as const);
    const wrap =
      around === "width" ? cls([`width: ${px(150, 600)}`]) : around === "padding" ? cls([`padding: ${px(0, 20)}`]) : around === "flex" ? cls(["display: flex", "gap: 8px"]) : around === "column" ? cls(["display: flex", "flex-direction: column"]) : around === "grid" ? cls(["display: grid", `grid-template-columns: ${r.pick(["1fr", "200px 1fr", "1fr 1fr"])}`, "gap: 8px"]) : "";
    const sibling = around === "flex" || around === "grid" ? `<div>${words(r, 1, 5)}</div>` : "";
    tables.push(wrap ? `<div class="${wrap}">${h}${sibling}</div>` : h);
  }
  const html = `<!doctype html>\n<html>\n<head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head>\n<body>\n${tables.join("\n<p>Between the tables</p>\n")}\n</body>\n</html>\n`;
  const widths = [r.int(280, 500), r.int(500, 900), r.int(900, 1400)];
  return { html, css: css.join("\n") + "\n", widths };
}

const seeds = args.seeds
  ? args.seeds.split(",").map(Number)
  : args.replay
    ? (existsSync(args.out!) ? readdirSync(args.out!) : []).filter((d) => /^\d+$/.test(d)).map(Number)
    : Array.from({ length: Number(args.cases) }, (_, i) => Number(args.seed) * 100000 + i);
const verbose = !!args.seeds;
const overrides = new Map<string, string>();
const server = await serveFiles(ROOT, overrides);
const browser = await launchChromium();
let failures = 0;
let exact = 0;
let flagged = 0;
let flaggedSame = 0;
const failed: number[] = [];

async function runCase(seed: number) {
  const dir = join(args.out!, String(seed));
  mkdirSync(dir, { recursive: true });
  const pagePath = join(dir, "page.html");
  // --replay: a saved case as it is (its widths in case.json).
  const saved = args.replay && existsSync(join(dir, "case.json")) ? (JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as { widths: number[] }) : undefined;
  const { html, css, widths } = saved ? { html: readFileSync(pagePath, "utf8"), css: readFileSync(join(dir, "page.css"), "utf8"), widths: saved.widths } : genCase(seed);
  writeFileSync(pagePath, html);
  writeFileSync(join(dir, "page.css"), css);
  writeFileSync(join(dir, "case.json"), JSON.stringify({ seed, widths }) + "\n");
  const t = cssPageFile(pagePath, join(dir, "page.css"), 800);
  overrides.set(resolve(ROOT, pagePath), t.html);
  const m = modelOf(loadSource(pagePath, t.yaml));
  const layouts = widths.map((w) => render(m, t.fixtureAt(w), [w])[0]);
  const impacts = tailwindImpact(t, layouts);
  const lines: string[] = [];
  let bad = 0;
  for (const l of layouts) {
    const uncertain = new Set<string>(impacts.find((i) => i.width === l.width)?.uncertain.map((u) => u.id));
    for (const b of walk(l.boxes)) if (b.assumptions.length) uncertain.add(b.id);
    const page = await browser.newPage({ viewport: { width: l.width, height: 800 } });
    await page.goto(server.url(pagePath));
    await settle(page);
    const rects = await measureBoxes(page);
    await page.close();
    for (const b of walk(l.boxes)) {
      if (b.anonymous) continue;
      const c = rects[b.id];
      const d = c ? rectDelta(b, c) : Infinity;
      const ok = d <= TOL;
      const fl = uncertain.has(b.id);
      if (fl) {
        flagged++;
        if (ok) flaggedSame++;
      } else exact++;
      const f = (x: { x: number; y: number; w: number; h: number }) => `${+x.x.toFixed(3)},${+x.y.toFixed(3)} ${+x.w.toFixed(3)}×${+x.h.toFixed(3)}`;
      if ((!ok && !fl) || verbose) lines.push(`${l.width}px ${ok ? (fl ? "≈" : "✓") : fl ? "≈" : "✖"} #${b.id} engine ${f(b)} chromium ${c ? f(c) : "missing"}${fl ? `  (${b.assumptions[0] ?? impacts.find((i) => i.width === l.width)?.uncertain.find((u) => u.id === b.id)?.reasons?.[0] ?? ""})` : ""}`);
      if (!ok && !fl) bad++;
    }
  }
  if (bad) {
    failures++;
    failed.push(seed);
    writeFileSync(join(dir, "report.txt"), lines.join("\n") + "\n");
    console.log(`✖ seed ${seed}: ${bad} box(es) differ (${dir})\n  ${lines.filter((x) => x.includes("✖")).slice(0, 6).join("\n  ")}`);
  } else if (!verbose) rmSync(dir, { recursive: true, force: true });
  if (verbose) console.log(`seed ${seed}\n${lines.join("\n")}`);
}

const queue = [...seeds];
await Promise.all(
  Array.from({ length: Number(args.workers) }, async () => {
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      try {
        await runCase(s);
      } catch (e) {
        failures++;
        failed.push(s);
        console.log(`✖ seed ${s}: ${(e as Error).stack?.split("\n").slice(0, 4).join("\n")}`);
      }
    }
  }),
);
await browser.close();
server.close();
console.log(`\n${seeds.length} cases: ${exact} boxes marked exact, ${flagged} marked ≈ (${flaggedSame} of them match anyway)`);
console.log(failures ? `✖ ${failures} case(s) with exact boxes that differ: ${failed.join(",")}` : "✓ every box marked exact matches Chromium");
process.exitCode = failures ? 1 : 0;
