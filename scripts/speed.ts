/**
 * Speed: the same job done two ways. Get every box of a page at N viewport widths
 *   - Cadesa: the engine, in-process (validate + compile + layout + check), no browser
 *   - Playwright: launch Chromium, load the page with the compiled CSS at each width, wait for
 *     fonts and images, read every data-fixture box (what a layout test in CI does)
 *
 *   npx tsx scripts/speed.ts [--source ...] [--fixture ...] [--from 320 --to 1440 --step 10]
 *
 * Both produce the same boxes (that's what the conformance suites prove); this only times them.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus } from "node:os";
import { extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { check } from "../src/check.js";
import { compile } from "../src/compile.js";
import { walk } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { loadSource } from "../src/load.js";
import { findChrome } from "../src/metrics.js";
import { modelOf, render } from "../src/project.js";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "examples/landing/landing.cadesa.yaml" },
    fixture: { type: "string", default: "examples/landing/landing.html" },
    css: { type: "string", default: "examples/landing/landing.css" },
    from: { type: "string", default: "320" },
    to: { type: "string", default: "1440" },
    step: { type: "string", default: "10" },
  },
});
const widths: number[] = [];
for (let w = Number(values.from); w <= Number(values.to); w += Number(values.step)) widths.push(w);

// ---- Cadesa (cold: includes parsing YAML/HTML and loading font metrics)
const t0 = performance.now();
const cpu0 = process.cpuUsage();
const text = readFileSync(values.source!, "utf8");
const model = modelOf(loadSource(values.source!, text));
const css = compile(model);
const fixture = parseFixture(values.fixture!);
const layouts = render(model, fixture, widths);
const findings = check(layouts);
const engineMs = performance.now() - t0;
const engineCpu = process.cpuUsage(cpu0);
const engineBoxes = layouts.reduce((n, l) => n + [...walk(l.boxes)].length, 0);
void css;
void findings;

// ---- Playwright + Chromium
const root = process.cwd();
const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
  const p = resolve(root, "." + decodeURIComponent(new URL(req.url!, "http://x").pathname));
  if (!p.startsWith(root) || !existsSync(p)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" }).end(readFileSync(p));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const MEASURE = `[...document.querySelectorAll("[data-fixture]")].map((el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })`;

const b0 = performance.now();
const browser = await chromium.launch({ executablePath: findChrome() });
const launchMs = performance.now() - b0;
const page = await browser.newPage();
let browserBoxes = 0;
for (const w of widths) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.goto(`http://127.0.0.1:${port}/${values.fixture}`);
  await page.evaluate("document.fonts.ready");
  await page.evaluate("Promise.all([...document.images].map((i) => i.decode().catch(() => {})))");
  browserBoxes += ((await page.evaluate(MEASURE)) as unknown[]).length;
}
const browserMs = performance.now() - b0;
await browser.close();
server.close();

const f = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`);
console.log(`page: ${values.fixture} · ${widths.length} widths (${values.from}–${values.to}px, every ${values.step}px) · ${cpus()[0].model}`);
console.log(`Cadesa engine     ${f(engineMs).padStart(8)}  (${engineBoxes} boxes, cpu ${f((engineCpu.user + engineCpu.system) / 1000)}, no browser)`);
console.log(`Playwright        ${f(browserMs).padStart(8)}  (${browserBoxes} boxes, of which ${f(launchMs)} browser launch)`);
console.log(`→ ${(browserMs / engineMs).toFixed(0)}× faster; per width ${f(engineMs / widths.length)} vs ${f((browserMs - launchMs) / widths.length)}`);
