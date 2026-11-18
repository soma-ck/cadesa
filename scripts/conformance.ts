/**
 * Conformance: does Chromium, loading the exact CSS bytes `cascadio build` wrote, put every
 * fixture box where the Cascadio reference engine says it goes?
 *
 * This is the only place a browser is used. It verifies the engine; it is not part of the dev loop.
 *
 *   npm run conformance [-- --widths 390,1280 --tolerance 0.5]
 *
 * Browser: $CASCADIO_CHROME, else a system Chrome/Chromium, else Playwright's bundled Chromium
 * (`npx playwright install chromium`).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { compile } from "../src/compile.js";
import { walk } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { loadSourceFile } from "../src/load.js";
import { modelOf, render } from "../src/project.js";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "settings.cascade.yaml" },
    fixture: { type: "string", default: "fixtures/settings.html" },
    css: { type: "string", default: "dist/settings.css" },
    widths: { type: "string", default: "390,1280" },
    tolerance: { type: "string", default: "0.5" },
    out: { type: "string", default: "artifacts" },
  },
});

const root = process.cwd();
const tolerance = Number(values.tolerance);
const widths = values.widths!.split(",").map(Number);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// 1. Build, so we know exactly which bytes the browser must receive.
const model = modelOf(loadSourceFile(values.source!));
const css = compile(model);
mkdirSync(join(root, values.css!, ".."), { recursive: true });
writeFileSync(values.css!, css);
const builtSha = sha(css);

// 2. Serve the repo and record every stylesheet byte stream the page actually loads.
const served = new Map<string, string>();
const types: Record<string, string> = { ".html": "text/html", ".css": "text/css" };
const server = createServer((req, res) => {
  const path = resolve(root, "." + decodeURIComponent(new URL(req.url!, "http://x").pathname));
  if (!path.startsWith(root) || !existsSync(path)) return void res.writeHead(404).end();
  const body = readFileSync(path);
  if (path.endsWith(".css")) served.set(path, sha(body));
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const executablePath =
  process.env.CASCADIO_CHROME ??
  ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
const browser = await chromium.launch({ executablePath });
const fixture = parseFixture(values.fixture!);
const engine = render(model, fixture, widths);

mkdirSync(values.out!, { recursive: true });
let failures = 0;
const report: unknown[] = [];
console.log(`browser: ${browser.version()}${executablePath ? ` (${executablePath})` : " (playwright bundled)"}`);
console.log(`tolerance: ±${tolerance}px\n`);

for (const layout of engine) {
  const page = await browser.newPage({ viewport: { width: layout.width, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/${values.fixture}`);
  const rects: Record<string, { x: number; y: number; w: number; h: number }> = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("[data-fixture]")].map((el) => {
        const r = el.getBoundingClientRect();
        return [el.dataset.fixture!, { x: r.x, y: r.y, w: r.width, h: r.height }];
      }),
    ),
  );
  const bottom = Math.max(...Object.values(rects).map((r) => r.y + r.h));
  await page.screenshot({
    path: join(values.out!, `settings-${layout.width}.png`),
    clip: { x: 0, y: 0, width: layout.width, height: Math.ceil(bottom) + 24 },
  });
  await page.close();

  console.log(`${layout.width}px${layout.active.length ? ` (${layout.active.join(", ")} active)` : ""}`);
  console.log("  box           engine (x,y w×h)           chromium (x,y w×h)         max Δ");
  for (const b of walk(layout.boxes)) {
    const c = rects[b.id];
    const fmt = (r: { x: number; y: number; w: number; h: number }) =>
      `${+r.x.toFixed(2)},${+r.y.toFixed(2)} ${+r.w.toFixed(2)}×${+r.h.toFixed(2)}`;
    const delta = c ? Math.max(...(["x", "y", "w", "h"] as const).map((k) => Math.abs(b[k] - c[k]))) : Infinity;
    const ok = delta <= tolerance;
    if (!ok) failures++;
    const note = b.assumptions.length ? "  (text: 1 line assumed)" : "";
    console.log(
      `  ${ok ? "✓" : "✖"} #${b.id.padEnd(12)} ${fmt(b).padEnd(26)} ${(c ? fmt(c) : "missing").padEnd(26)} ${c ? delta.toFixed(3) : "-"}${note}`,
    );
    report.push({ width: layout.width, id: b.id, engine: { x: b.x, y: b.y, w: b.w, h: b.h }, chromium: c, delta, ok });
  }
  console.log("");
}

await browser.close();
server.close();

// 3. The page must have loaded the emitted stylesheet byte-for-byte, and nothing else.
const cssPath = resolve(root, values.css!);
const loadedSha = served.get(cssPath);
const bytesOk = loadedSha === builtSha && served.size === 1;
if (!bytesOk) failures++;
console.log(
  bytesOk
    ? `✓ stylesheet: the fixture loaded ${values.css} unchanged (sha256 ${builtSha.slice(0, 12)})`
    : `✖ stylesheet: expected only ${values.css} (sha256 ${builtSha.slice(0, 12)}), page loaded ${JSON.stringify([...served])}`,
);
writeFileSync(join(values.out!, "conformance.json"), JSON.stringify({ tolerance, cssSha256: builtSha, boxes: report }, null, 2) + "\n");
console.log(failures ? `\n✖ ${failures} mismatch(es)` : `\n✓ engine and Chromium agree on every box`);
process.exitCode = failures ? 1 : 0;
