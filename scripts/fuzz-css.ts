/**
 * Differential fuzzer for pages lifted from their CSS: random paragraphs with inline runs in
 * another font, size, line height or vertical-align (small, sub, sup, spans, generated content),
 * atomic inlines of different heights on their lines, rows aligned on their baselines and form
 * controls, lifted the way `check --css` lifts a page and laid out by the engine, compared with
 * Chromium box by box. Every box the lift and engine mark exact must match within the tolerance.
 *
 *   npm run fuzz -- --cases 500             (runs these cases too: one for every four others)
 *   npx tsx scripts/fuzz-css.ts --cases 300 --seed 1
 *   npx tsx scripts/fuzz-css.ts --seeds 17,42   (re-run particular cases, printing every box)
 *
 * A failing case is written to artifacts/fuzz-css/<seed>/ (page.html, page.css, report.txt).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { measureBoxes, rectDelta, serveFiles, settle } from "../src/browser.js";
import { cssPageFile, tailwindImpact } from "../src/commands.js";
import { walk } from "../src/engine/layout.js";
import { loadSource } from "../src/load.js";
import { launchChromium } from "../src/metrics.js";
import { modelOf, render } from "../src/project.js";

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

const WORDS = "the field notes of a harbor town record tides and boats leaving at dawn with nets mended by hand north wind 12 May 08:00 orders shipped quickly every week along the ridge".split(" ");
const words = (r: Rng, lo: number, hi: number) => Array.from({ length: r.int(lo, hi) }, () => r.pick(WORDS)).join(" ");

export interface CssCase {
  html: string;
  css: string;
  widths: number[];
}

/** One random case: a page of paragraphs and rows, with its stylesheet. */
export function genCssCase(seed: number): CssCase {
  const r = rng(seed);
  const css: string[] = [
    `@font-face { font-family: "Inter"; font-weight: 100 900; src: url("../../../fonts/InterVariable-latin.woff2") format("woff2"); }`,
    `@font-face { font-family: "Roboto"; font-weight: 100 900; src: url("../../../fixtures/fonts/fonts/roboto/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBA.woff2") format("woff2"); }`,
    // Lato with a real italic face (Inter and Roboto have none here: their italic is synthesized).
    `@font-face { font-family: "Lato"; font-weight: 400; src: url("../../../fixtures/fonts/fonts/lato/Lato-Regular.woff2") format("woff2"); }`,
    `@font-face { font-family: "Lato"; font-weight: 700; src: url("../../../fixtures/fonts/fonts/lato/Lato-Bold.woff2") format("woff2"); }`,
    `@font-face { font-family: "Lato"; font-weight: 400; font-style: italic; src: url("../../../fixtures/fonts/fonts/lato/Lato-Italic.woff2") format("woff2"); }`,
    `body { margin: 8px; font-family: Inter; font-size: ${r.pick(["16px", "16px", "14px", "15px", "18px"])}; line-height: ${r.pick(["1.5", "1.5", "1.25", "1.4", "24px", "normal", "1"])}; color: #222; }`,
    `p { margin: 0 0 ${r.int(0, 12)}px }`,
  ];
  // A root font size other than 16px (maybe changed by a media query): rem lengths resolve against it.
  const remRoot = r.chance(0.3);
  if (remRoot) {
    css.push(`html { font-size: ${r.pick(["62.5%", "10pt", "14px", "18px", "112.5%", "0.875rem", "20px"])} }`);
    if (r.chance(0.5)) css.push(`@media (min-width: ${r.int(400, 1000)}px) { html { font-size: ${r.pick(["16px", "75%", "12pt", "1.25em"])} } }`);
    css.push(`body { font-size: ${r.pick(["1rem", "1.4rem", "1.6rem", "0.875rem"])} }`, `p { margin-bottom: ${r.pick(["0.5rem", "1rem", "calc(0.25rem + 2px)"])} }`);
  }
  let n = 0;
  const cls = (decls: string[]) => {
    if (!decls.length) return "";
    const c = `k${++n}`;
    css.push(`.${c} { ${decls.join("; ")} }`);
    return c;
  };
  const attr = (c: string) => (c ? ` class="${c}"` : "");
  const size = () => r.pick(["10px", "12px", "13px", "14px", "18px", "20px", "24px", "28px", "0.875em", "0.75em", "1.25em", "80%", "smaller", "larger", "11.5px", "13.6px", ...(remRoot ? ["0.75rem", "1.2rem", "clamp(1rem, 0.5rem + 1vw, 1.5rem)"] : [])]);
  const lineHeight = () => r.pick(["1", "1.2", "1.5", "2", "normal", "0", "16px", "30px", "1.75em"]);
  const valign = () => r.pick(["baseline", "sub", "super", "middle", "text-top", "text-bottom", "-0.125em", "2px", "-3px", "0.3em", "20%", "-50%", "top", "bottom"]);
  /** An inline run: a tag with text, maybe styled, maybe nested. */
  const run = (depth: number): string => {
    const tag = r.pick(["span", "span", "span", "small", "sup", "sub", "b", "strong", "a", "em", "i"]);
    const decls: string[] = [];
    if (r.chance(0.5)) decls.push(`font-size: ${size()}`);
    if (r.chance(0.3)) decls.push(`line-height: ${lineHeight()}`);
    if (r.chance(0.35)) decls.push(`vertical-align: ${valign()}`);
    if (r.chance(0.25)) decls.push(`font-family: ${r.pick(["Roboto", "Inter", "Lato"])}`);
    if (r.chance(0.15)) decls.push(`font-weight: ${r.pick(["300", "600", "700"])}`);
    if (r.chance(0.12)) decls.push(`font-style: ${r.pick(["italic", "normal"])}`);
    // Sometimes with no break opportunity in it (a box never split across lines).
    const inner = depth < 2 && r.chance(0.25) ? (r.chance(0.3) ? `${r.pick(WORDS)}${run(depth + 1).replace(/>([^<]*)</, (_, t: string) => `>${t.replace(/ /g, "")}<`)}` : `${words(r, 0, 2)} ${run(depth + 1)} ${words(r, 0, 2)}`) : words(r, 1, 4);
    return `<${tag}${tag === "a" ? ' href="#"' : ""}${attr(cls(decls))}>${inner}</${tag}>`;
  };
  /** An atomic inline: an inline-block of set size, or an image-like box, placed by its vertical-align. */
  const atomic = () => {
    // An inline-block with content of its own: one line, or lines broken by <br>s with runs in them,
    // padded and bordered, maybe of set height.
    if (r.chance(0.4)) {
      const d = ["display: inline-block", `padding: ${r.int(0, 6)}px ${r.int(0, 10)}px`, "background: #dde"];
      if (r.chance(0.4)) d.push(`border: ${r.int(1, 3)}px solid #889`);
      if (r.chance(0.3)) d.push(`font-size: ${r.pick(["12px", "13px", "18px"])}`);
      if (r.chance(0.3)) d.push(`line-height: ${r.pick(["1", "1.25", "20px", "normal"])}`);
      if (r.chance(0.2)) d.push(`height: ${r.int(16, 40)}px`);
      if (r.chance(0.4)) d.push(`vertical-align: ${r.pick(["middle", "top", "bottom", "-3px", "text-top"])}`);
      const lines = Array.from({ length: r.int(1, 3) }, () => (r.chance(0.3) ? `${words(r, 1, 2)} ${run(1)}` : words(r, 1, 3)));
      return `<span${attr(cls(d))}>${lines.join("<br>")}</span>`;
    }
    const decls = ["display: inline-block", `width: ${r.int(4, 40)}px`, `height: ${r.int(4, 48)}px`, "background: #9ab"];
    if (r.chance(0.5)) decls.push(`vertical-align: ${r.pick(["baseline", "middle", "-4px", "2px", "-0.25em", "text-top", "text-bottom", "sub", "super", "top", "bottom"])}`);
    if (r.chance(0.3)) decls.push(`margin: ${r.int(0, 6)}px ${r.int(0, 6)}px`);
    return `<span${attr(cls(decls))}></span>`;
  };
  /** A grid in column flow, a grid of subgrid rows, or boxes with 3D transforms under a perspective. */
  const gridBlock = () => {
    const kind = r.pick(["column", "subgrid", "3d"] as const);
    const item = (d: string[] = []) => `<div${attr(cls(["padding: 4px", "background: #e8edf2", ...d]))}>${words(r, 1, 4)}</div>`;
    if (kind === "column") {
      const g = cls(["display: grid", `grid-auto-flow: column${r.chance(0.4) ? " dense" : ""}`, `grid-template-rows: ${r.pick(["auto auto", "auto auto auto", "30px auto"])}`, `grid-auto-columns: ${r.pick(["auto", "minmax(60px, 1fr)", "90px", "1fr"])}`, `gap: ${r.int(0, 10)}px`]);
      const items = Array.from({ length: r.int(2, 7) }, () => item(r.chance(0.25) ? [r.pick(["grid-row: span 2", "grid-column: span 2", "grid-row: 1"])] : []));
      return `<div${attr(g)}>${items.join("")}</div>`;
    }
    if (kind === "subgrid") {
      const n = r.int(2, 4);
      const g = cls(["display: grid", `grid-template-columns: ${r.pick(["auto 1fr auto", "max-content 1fr", "repeat(3, auto)", "1fr 2fr 1fr", "auto auto"])}`, `gap: ${r.int(0, 8)}px ${r.int(0, 16)}px`]);
      const row = cls(["display: grid", "grid-column: 1 / -1", "grid-template-columns: subgrid", ...(r.chance(0.5) ? [`padding: ${r.int(0, 6)}px 0`] : []), ...(r.chance(0.3) ? ["border-bottom: 1px solid #ccc"] : [])]);
      const rows = Array.from({ length: r.int(1, 4) }, () => `<div${attr(row)}>${Array.from({ length: n }, () => `<span>${words(r, 1, 3)}</span>`).join("")}</div>`);
      return `<div${attr(g)}>${rows.join("")}</div>`;
    }
    const g = cls(["display: flex", "flex-wrap: wrap", `gap: ${r.int(4, 20)}px`, `perspective: ${r.pick(["300px", "600px", "1000px"])}`, ...(r.chance(0.3) ? [`perspective-origin: ${r.pick(["left top", "25% 75%", "right center"])}`] : [])]);
    const tf = () => r.pick(["rotateX(30deg)", "rotateY(-35deg)", "translateZ(40px)", "rotate3d(1, 1, 0, 25deg)", "translate3d(10px, 0, -60px)", "rotateY(20deg) scale(0.9)", "rotate(5deg)"]);
    const items = Array.from({ length: r.int(1, 4) }, () => item([`width: ${r.int(60, 200)}px`, `height: ${r.int(30, 90)}px`, `transform: ${tf()}`, ...(r.chance(0.3) ? [`transform-origin: ${r.pick(["left top", "0 100%", "center"])}`] : [])]));
    return `<div${attr(g)}>${items.join("")}</div>`;
  };
  /** Inline-blocks sharing their lines with each other: tiles of one or more lines (<br>s). */
  const tiles = () => {
    const d = ["display: inline-block", `width: ${r.int(60, 220)}px`, `padding: ${r.int(0, 8)}px`, "border: 1px solid #ccc"];
    if (r.chance(0.4)) d.push(`font-size: ${r.pick(["13px", "14px", "18px"])}`);
    const c = cls(d);
    const items = Array.from({ length: r.int(2, 5) }, () => `<span${attr(c)}>${Array.from({ length: r.int(1, 3) }, () => words(r, 1, 2)).join("<br>")}</span>`);
    return `<div>${items.join(r.chance(0.8) ? " " : "")}</div>`;
  };
  const blocks: string[] = [];
  /** A flex row of items aligned on their first baselines: text in other sizes and fonts, padding, nested blocks, boxes with no baseline. */
  const baselineRow = () => {
    const decls = ["display: flex", `align-items: ${r.pick(["baseline", "baseline", "first baseline"])}`];
    if (r.chance(0.5)) decls.push(`gap: ${r.int(0, 16)}px`);
    if (r.chance(0.4)) decls.push("flex-wrap: wrap");
    if (r.chance(0.3)) decls.push(`padding: ${r.int(0, 10)}px`);
    if (r.chance(0.3)) decls.push(`border: ${r.int(1, 3)}px solid #ccc`);
    if (r.chance(0.15)) decls.push(`height: ${r.int(40, 120)}px`);
    const items: string[] = [];
    const k = r.int(2, 5);
    for (let j = 0; j < k; j++) {
      const d: string[] = [];
      if (r.chance(0.5)) d.push(`font-size: ${r.pick(["12px", "14px", "20px", "28px", "36px"])}`);
      if (r.chance(0.3)) d.push(`line-height: ${r.pick(["1", "1.2", "1.5", "normal", "40px"])}`);
      if (r.chance(0.2)) d.push("font-family: Roboto");
      if (r.chance(0.3)) d.push(`padding: ${r.int(0, 12)}px ${r.int(0, 8)}px`);
      if (r.chance(0.2)) d.push(`margin-top: ${r.int(0, 10)}px`);
      if (r.chance(0.15)) d.push(`border-top: ${r.int(1, 4)}px solid #999`);
      if (r.chance(0.15)) d.push(`width: ${r.int(40, 200)}px`);
      const kind = r.pick(["text", "text", "text", "runs", "nested", "empty"] as const);
      if (kind === "empty") d.push(`width: ${r.int(8, 40)}px`, `height: ${r.int(8, 50)}px`, "background: #ccd");
      const c = cls(d);
      const body = kind === "text" ? words(r, 1, 5) : kind === "runs" ? `${words(r, 1, 3)} ${run(0)} ${words(r, 0, 3)}` : kind === "nested" ? `<p${attr(cls(r.chance(0.5) ? [`font-size: ${r.pick(["18px", "24px", "13px"])}`] : []))}>${words(r, 1, 4)}</p><p>${words(r, 1, 4)}</p>` : "";
      items.push(`<div${attr(c)}>${body}</div>`);
    }
    return `<div${attr(cls(decls))}>${items.join("")}</div>`;
  };
  /** A form control: a text field (size=), textarea (rows, cols), select, button input, checkbox, radio or range, in its own font and box. */
  const control = () => {
    const d: string[] = ["font: inherit"];
    if (r.chance(0.4)) d.push(`font-size: ${r.pick(["13px", "14px", "18px", "20px"])}`);
    if (r.chance(0.3)) d.push(`line-height: ${r.pick(["1", "1.25", "1.5", "normal"])}`);
    if (r.chance(0.4)) d.push(`padding: ${r.int(0, 10)}px ${r.int(0, 12)}px`);
    if (r.chance(0.4)) d.push(`border: ${r.int(0, 3)}px solid #889`);
    if (r.chance(0.2)) d.push("box-sizing: border-box");
    const kind = r.pick(["text", "text", "select", "select", "textarea", "submit", "button", "checkbox", "radio", "range", "color"] as const);
    if ((kind === "select" || kind === "text") && r.chance(0.5)) d.push("appearance: none");
    const c = attr(cls(kind === "checkbox" || kind === "radio" || kind === "range" || kind === "color" ? [] : d));
    const opts = () => Array.from({ length: r.int(1, 4) }, () => `<option>${words(r, 1, 3)}</option>`).join("");
    if (kind === "text") return `<input${c} type="${r.pick(["text", "email", "password", "tel", "url"])}"${r.chance(0.5) ? ` size="${r.int(1, 30)}"` : ""}>`;
    if (kind === "select") return `<select${c}>${opts()}</select>`;
    if (kind === "textarea") return `<textarea${c}${r.chance(0.6) ? ` rows="${r.int(1, 5)}"` : ""}${r.chance(0.6) ? ` cols="${r.int(4, 40)}"` : ""}></textarea>`;
    if (kind === "submit" || kind === "button") return `<input${c} type="${kind}"${kind === "button" || r.chance(0.5) ? ` value="${words(r, 1, 2)}"` : ""}>`;
    return `<input type="${kind}">`;
  };
  /** Controls in a line of text, alone on their line, in a flex row, or in a button of set height. */
  const formBlock = () => {
    const where = r.pick(["line", "alone", "row", "button"] as const);
    if (where === "line") return `<p>${words(r, 0, 4)} ${control()} ${words(r, 0, 4)}</p>`;
    if (where === "alone") return `<div>${control()}</div>`;
    if (where === "row") return `<div${attr(cls(["display: flex", `gap: ${r.int(0, 10)}px`, ...(r.chance(0.5) ? [`align-items: ${r.pick(["center", "stretch", "flex-start", "baseline"])}`] : [])]))}>${control()}${control()}<span>${words(r, 1, 3)}</span></div>`;
    return `<div><button${attr(cls(["font: inherit", `height: ${r.int(16, 70)}px`, `padding: ${r.int(0, 8)}px ${r.int(0, 12)}px`, ...(r.chance(0.3) ? ["box-sizing: content-box"] : [])]))}>${words(r, 1, 2)}</button></div>`;
  };
  const count = r.int(2, 5);
  for (let i = 0; i < count; i++) {
    if (r.chance(0.3)) {
      blocks.push(baselineRow());
      continue;
    }
    if (r.chance(0.3)) {
      blocks.push(formBlock());
      continue;
    }
    if (r.chance(0.15)) {
      blocks.push(tiles());
      continue;
    }
    if (r.chance(0.15)) {
      blocks.push(gridBlock());
      continue;
    }
    const decls: string[] = [];
    if (r.chance(0.3)) decls.push(`font-size: ${r.pick(["14px", "16px", "20px", "13px"])}`);
    if (r.chance(0.3)) decls.push(`line-height: ${r.pick(["1", "1.2", "1.5", "normal", "20px", "28px"])}`);
    if (r.chance(0.2)) decls.push(`width: ${remRoot && r.chance(0.5) ? `${r.int(8, 40)}rem` : `${r.int(120, 600)}px`}`);
    if (r.chance(0.15)) decls.push(`padding: ${remRoot && r.chance(0.5) ? `${r.int(0, 12) / 8}rem` : `${r.int(0, 12)}px`}`);
    if (r.chance(0.1)) decls.push(`font-family: Roboto`);
    else if (r.chance(0.15)) decls.push("font-family: Lato");
    if (r.chance(0.12)) decls.push("font-style: italic");
    const parts: string[] = [];
    const k = r.int(1, 5);
    for (let j = 0; j < k; j++) {
      parts.push(words(r, 0, 6));
      parts.push(r.chance(0.2) ? atomic() : run(0));
    }
    parts.push(words(r, 0, 5));
    const tag = r.pick(["p", "p", "div", "li"]);
    const body = parts.filter(Boolean).join(" ");
    blocks.push(tag === "li" ? `<ul><li${attr(cls(decls))}>${body}</li></ul>` : `<${tag}${attr(cls(decls))}>${body}</${tag}>`);
    if (r.chance(0.3)) blocks.push(`<p>${words(r, 2, 10)}</p>`);
  }
  const html = `<!doctype html>\n<html>\n<head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head>\n<body>\n${blocks.join("\n")}\n</body>\n</html>\n`;
  const widths = [r.int(200, 420), r.int(420, 800), r.int(800, 1300)];
  return { html, css: css.join("\n") + "\n", widths };
}

export interface CssFuzzStats {
  cases: number;
  exact: number;
  flagged: number;
  flaggedSame: number;
  failures: number[];
  errors: number;
  /** Why boxes were marked ≈: the first reason of each, generalised, with how many boxes. */
  reasons: Map<string, number>;
}

/** Run cases `seeds` (lifted and laid out, then measured in Chromium); failing cases are kept in `out`. */
export async function runCssFuzz(seeds: number[], opts: { tolerance: number; out: string; workers: number; verbose?: boolean; quiet?: boolean }): Promise<CssFuzzStats> {
  const ROOT = process.cwd();
  // The fixture fonts' tables (Lato's upright and italic faces, as the pages load them).
  process.env.CADESA_METRICS ??= "fixtures/fonts/metrics";
  const overrides = new Map<string, string>();
  const server = await serveFiles(ROOT, overrides);
  const browser = await launchChromium();
  const stats: CssFuzzStats = { cases: 0, exact: 0, flagged: 0, flaggedSame: 0, failures: [], errors: 0, reasons: new Map() };
  const runCase = async (seed: number) => {
    const dir = join(opts.out, String(seed));
    mkdirSync(dir, { recursive: true });
    const pagePath = join(dir, "page.html");
    const { html, css, widths } = genCssCase(seed);
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
      const unc = impacts.find((i) => i.width === l.width)?.uncertain ?? [];
      const uncertain = new Set<string>(unc.map((u) => u.id));
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
        const ok = d <= opts.tolerance;
        const fl = uncertain.has(b.id);
        if (fl) {
          stats.flagged++;
          if (ok) stats.flaggedSame++;
          const why = (b.assumptions[0] ?? unc.find((u) => u.id === b.id)?.reasons?.[0] ?? "")
            .replace(/^(moved|resized) (by|with) #\S+: /, "")
            .replace(/\S+\.(html|css)(:\d+)?/g, "")
            .replace(/#\S+/g, "#")
            .replace(/\.k\d+/g, ".k")
            .replace(/-?\d+(\.\d+)?/g, "N")
            .slice(0, 120);
          stats.reasons.set(why, (stats.reasons.get(why) ?? 0) + 1);
        } else stats.exact++;
        const f = (x: { x: number; y: number; w: number; h: number }) => `${+x.x.toFixed(3)},${+x.y.toFixed(3)} ${+x.w.toFixed(3)}×${+x.h.toFixed(3)}`;
        if ((!ok && !fl) || opts.verbose)
          lines.push(`${l.width}px ${ok ? (fl ? "≈" : "✓") : fl ? "≈" : "✖"} #${b.id} engine ${f(b)} chromium ${c ? f(c) : "missing"}${fl ? `  (${b.assumptions[0] ?? unc.find((u) => u.id === b.id)?.reasons?.[0] ?? ""})` : ""}`);
        if (!ok && !fl) bad++;
      }
    }
    stats.cases++;
    if (bad) {
      stats.failures.push(seed);
      writeFileSync(join(dir, "report.txt"), lines.join("\n") + "\n");
      console.log(`✖ css seed ${seed}: ${bad} box(es) differ (${dir})\n  ${lines.filter((x) => x.includes("✖")).slice(0, 6).join("\n  ")}`);
    } else if (!opts.verbose) rmSync(dir, { recursive: true, force: true });
    if (opts.verbose) console.log(`seed ${seed}\n${lines.join("\n")}`);
  };
  const queue = [...seeds];
  try {
    await Promise.all(
      Array.from({ length: opts.workers }, async () => {
        for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
          try {
            await runCase(s);
          } catch (e) {
            stats.errors++;
            stats.failures.push(s);
            console.log(`✖ css seed ${s}: ${(e as Error).stack?.split("\n").slice(0, 4).join("\n")}`);
          }
        }
      }),
    );
  } finally {
    await browser.close();
    server.close();
  }
  return stats;
}

export const cssSummary = (s: CssFuzzStats) =>
  `${s.cases} CSS cases: ${s.exact} boxes marked exact, ${s.flagged} marked ≈ (${s.flaggedSame} of them match anyway)` +
  [...s.reasons].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `\n  ${String(v).padStart(6)}  ${k}`).join("") +
  (s.failures.length ? `\n✖ ${s.failures.length} CSS case(s) with exact boxes that differ: ${s.failures.join(",")}` : "\n✓ every CSS box marked exact matches Chromium");

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  const { values: args } = parseArgs({
    options: {
      seed: { type: "string", default: "1" },
      cases: { type: "string", default: "100" },
      seeds: { type: "string" },
      tolerance: { type: "string", default: "0.5" },
      out: { type: "string", default: "artifacts/fuzz-css" },
      workers: { type: "string", default: "6" },
    },
  });
  const seeds = args.seeds ? args.seeds.split(",").map(Number) : Array.from({ length: Number(args.cases) }, (_, i) => Number(args.seed) * 100000 + i);
  const s = await runCssFuzz(seeds, { tolerance: Number(args.tolerance), out: args.out!, workers: Number(args.workers), verbose: !!args.seeds });
  console.log(`\n${cssSummary(s)}`);
  process.exitCode = s.failures.length ? 1 : 0;
}
