/**
 * Conformance: does Chromium, loading the exact CSS bytes `cadesa build` wrote, put every
 * fixture box where the Cadesa reference engine says it goes?
 *
 * This is the only place a browser is used. It verifies the engine; it is not part of the dev loop.
 *
 *   npm run conformance [-- --widths 390,1280 --tolerance 0.5]
 *
 * Browser: $CADESA_CHROME, else a system Chrome/Chromium, else Playwright's bundled Chromium
 * (`npx playwright install chromium`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { measureBoxes, measureLineCounts, rectDelta, serveFiles, settle, sha256 as sha } from "../src/browser.js";
import { findChrome, launchChromium } from "../src/metrics.js";
import { sizeUncertainty } from "../src/check.js";
import { compile } from "../src/compile.js";
import { walk, type Layout } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { loadSource, loadSourceFile } from "../src/load.js";
import type { WidthImpact } from "../src/lift/impact.js";
import { modelOf, render } from "../src/project.js";
import { cssPageFile, tailwindFile, tailwindImpact, parseWidths } from "../src/commands.js";
import type { Model } from "../src/model.js";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "settings.cadesa.yaml" },
    fixtures: { type: "string", default: "fixtures/settings.html,fixtures/settings-long.html" },
    css: { type: "string", default: "dist/settings.css" },
    widths: { type: "string", default: "320,390,768,1280" },
    tolerance: { type: "string", default: "0.5" },
    /** The window height (px): vh units on a lifted page are computed for it, and Chromium opens at it. */
    height: { type: "string", default: "800" },
    out: { type: "string", default: "artifacts" },
    /**
     * Verify a lift instead: the fixture links this hand-written CSS, which the engine sees only
     * through the page lift (as `--css` does). Each page is served with generated class names and
     * ids added (nothing else changes).
     */
    lift: { type: "string" },
    /**
     * Verify Tailwind support: --fixtures are Tailwind pages, this is the CSS Tailwind compiled for
     * them. Each page is served with generated class names and ids added (nothing else changes) and
     * the engine works from the page's on-the-fly lift.
     */
    tailwind: { type: "string" },
    /**
     * Also fail on any box the engine flags (a text box it couldn't measure, say) and on any text
     * box whose line count differs from Chromium's (counted from the text's line boxes).
     */
    strict: { type: "boolean", default: false },
  },
});
const strict = values.strict!;

const root = process.cwd();
const tolerance = Number(values.tolerance);
const viewportHeight = Number(values.height);
const widths = parseWidths(values.widths!);
/** A page lift: Tailwind's compiled CSS, or plain CSS (--lift). */
const tw = values.tailwind ?? values.lift;

// 1. Build, so we know exactly which bytes the browser must receive. With --lift, the original CSS
//    is served untouched and the engine works from its lift.
const lifted = !!values.lift;
const model: Model | undefined = tw ? undefined : modelOf(loadSourceFile(values.source!));
const cssFile = tw ?? values.css!;
/** --lift takes several stylesheets, comma-separated (bootstrap.css,app.css): each must load unchanged. */
const cssFiles = lifted ? cssFile.split(",") : [cssFile];
const css = tw ? readFileSync(cssFiles[0], "utf8") : compile(model!);
if (!tw) {
  mkdirSync(join(root, values.css!, ".."), { recursive: true });
  writeFileSync(values.css!, css);
}
const builtSha = sha(css);

// 2. Serve the repo and record every stylesheet byte stream the page actually loads.
/** Pages served with different bytes (Tailwind: generated classes and ids added). */
const overrides = new Map<string, string>();
const server = await serveFiles(root, overrides);
const served = server.css;

const executablePath = findChrome();
const browser = await launchChromium();

mkdirSync(values.out!, { recursive: true });
let failures = 0;
const report: unknown[] = [];
console.log(`browser: ${browser.version()}${executablePath ? ` (${executablePath})` : " (playwright bundled)"}`);
console.log(`tolerance: ±${tolerance}px\n`);

// Font families the source sets text in; each must load in the fixture or the comparison is meaningless.
const familiesOf = (model: Model) => [...new Set([...model.text.values()].filter((r) => r.font).map((r) => model.tokens.get(`font.${r.font!.name}`)!.raw.split(",")[0].trim().replace(/^["']|["']$/g, "")))];
let checked = 0;
let linesChecked = 0;
let assumed = 0;
const flaggedSame: string[] = [];
const flaggedDiff: string[] = [];
/** ≈ boxes whose width check still treats as known (clipped and overflowing text stay conclusive there). */
let widthKnown = 0;
let sizeKnown = 0;
const widthWrong: string[] = [];
for (const fixtureFile of values.fixtures!.split(",")) {
const name = fixtureFile.replace(/^.*\//, "").replace(/\.html$/, "");
console.log(`── ${fixtureFile}`);
let layouts: Layout[];
let impacts: WidthImpact[] | undefined;
let families: string[];
if (tw) {
  const t = lifted ? cssPageFile(fixtureFile, tw, viewportHeight) : tailwindFile(fixtureFile, tw, viewportHeight);
  overrides.set(resolve(root, fixtureFile), t.html);
  const m = modelOf(loadSource(`${fixtureFile} (${lifted ? "lifted" : "tailwind"})`, t.yaml));
  layouts = widths.map((w) => render(m, t.fixtureAt(w), [w])[0]);
  impacts = tailwindImpact(t, layouts);
  families = familiesOf(m);
} else {
  const fixture = parseFixture(fixtureFile);
  layouts = render(model!, fixture, widths);
  impacts = undefined;
  families = familiesOf(model!);
}
for (const layout of layouts) {
  const uncertain = new Set<string>(impacts?.find((i) => i.width === layout.width)?.uncertain.map((u) => u.id));
  const { width: widthUnsure, size: sizeUnsure } = sizeUncertainty(layout, impacts?.find((i) => i.width === layout.width));
  // A text box the engine couldn't measure (no font metrics) is flagged in every report: uncertain.
  if (tw) for (const b of walk(layout.boxes)) if (b.assumptions.length) (uncertain.add(b.id), assumed++);
  const page = await browser.newPage({ viewport: { width: layout.width, height: viewportHeight } });
  await page.goto(server.url(fixtureFile));
  await settle(page);
  for (const family of families) {
    const ok = await page.evaluate(`document.fonts.check(${JSON.stringify(`16px "${family}"`)}) && ![...document.fonts].some((f) => f.status === "error")`);
    if (!ok) throw new Error(`font "${family}" did not load in ${fixtureFile}`);
  }
  const rects = await measureBoxes(page);
  const lineCounts = strict ? await measureLineCounts(page) : {};
  const bottom = Math.max(...Object.values(rects).map((r) => r.y + r.h));
  if (!tw || [400, 760, 1280].includes(layout.width)) await page.screenshot({
    path: join(values.out!, `${name}-${layout.width}.png`),
    clip: { x: 0, y: 0, width: layout.width, height: Math.ceil(bottom) + 24 },
  });
  await page.close();

  console.log(`${layout.width}px${layout.active.length ? ` (${layout.active.join(", ")} active)` : ""}`);
  console.log("  box           engine (x,y w×h)           chromium (x,y w×h)         max Δ");
  for (const b of walk(layout.boxes)) {
    // An anonymous text run has no element to compare with.
    if (b.anonymous) continue;
    const c = rects[b.id];
    const fmt = (r: { x: number; y: number; w: number; h: number }) =>
      `${+r.x.toFixed(2)},${+r.y.toFixed(2)} ${+r.w.toFixed(2)}×${+r.h.toFixed(2)}`;
    const delta = c ? rectDelta(b, c) : Infinity;
    const linesOk = !strict || !b.lines || b.lines.length === lineCounts[b.id];
    const ok = delta <= tolerance && linesOk;
    const flagged = uncertain.has(b.id) || (strict && b.assumptions.length > 0);
    if ((!ok && !flagged) || (strict && flagged)) failures++;
    if (strict && b.lines) linesChecked++;
    const lh = b.props.text ? b.props.text.value.sizePx * b.props.text.value.lineHeight : 0;
    const note = b.assumptions.length
      ? "  (text: 1 line assumed)"
      : b.lines && !b.props.height
        ? `  ${b.lines.length} line${b.lines.length > 1 ? "s" : ""}${c ? ` / chromium ${strict ? lineCounts[b.id] : Math.round(c.h / lh)}` : ""}`
        : "";
    checked++;
    // Tailwind sweeps are long: print only what isn't a plain match.
    if (!tw || !ok || flagged) console.log(
      `  ${ok ? (flagged ? "≈" : "✓") : flagged ? "≈" : "✖"} #${b.id.padEnd(12)} ${fmt(b).padEnd(26)} ${(c ? fmt(c) : "missing").padEnd(26)} ${c ? delta.toFixed(3) : "-"}${note}`,
    );
    if (flagged) (ok ? flaggedSame : flaggedDiff).push(`${layout.width}px #${b.id}`);
    // Flagged, but its width (or its width and height) is claimed: that claim must hold too.
    if (flagged && !widthUnsure.has(b.id) && c) {
      widthKnown++;
      const hToo = !sizeUnsure.has(b.id);
      if (hToo) sizeKnown++;
      if (Math.abs(b.w - c.w) > tolerance || (hToo && Math.abs(b.h - c.h) > tolerance)) {
        widthWrong.push(`${layout.width}px #${b.id} ${+b.w.toFixed(2)}×${+b.h.toFixed(2)} vs ${+c.w.toFixed(2)}×${+c.h.toFixed(2)}${hToo ? " (size claimed)" : " (width claimed)"}`);
        failures++;
      }
    }
    report.push({ fixture: fixtureFile, width: layout.width, id: b.id, lines: b.lines?.length, flagged, engine: { x: b.x, y: b.y, w: b.w, h: b.h }, chromium: c, delta, ok });
  }
  console.log("");
}
}

await browser.close();
server.close();

// 3. The page must have loaded the emitted stylesheet byte-for-byte, and nothing else.
const expected = new Map(cssFiles.map((f, i) => [resolve(root, f), i === 0 ? builtSha : sha(readFileSync(f))]));
const bytesOk = served.size === expected.size && [...expected].every(([p, h]) => served.get(p) === h);
if (!bytesOk) failures++;
console.log(
  bytesOk
    ? `✓ stylesheet: the fixture loaded ${cssFile} unchanged (sha256 ${builtSha.slice(0, 12)})`
    : `✖ stylesheet: expected only ${cssFile} (sha256 ${builtSha.slice(0, 12)}), page loaded ${JSON.stringify([...served])}`,
);
writeFileSync(join(values.out!, "conformance.json"), JSON.stringify({ tolerance, cssSha256: builtSha, boxes: report }, null, 2) + "\n");
if (tw) {
  const exact = checked - flaggedSame.length - flaggedDiff.length;
  console.log(
    failures
      ? `\n✖ ${failures} box(es) marked exact differ from Chromium`
      : `\n✓ all ${exact} boxes marked exact agree with Chromium`,
  );
  console.log(`≈ ${flaggedSame.length + flaggedDiff.length} boxes marked uncertain: ${flaggedDiff.length} differ, ${flaggedSame.length} happen to match`);
  console.log(
    widthWrong.length
      ? `✖ ${widthWrong.length} of ${widthKnown} uncertain boxes whose width (${sizeKnown}: and height) check treats as known differ:\n  ${widthWrong.slice(0, 20).join("\n  ")}`
      : `✓ all ${widthKnown} uncertain boxes whose width check treats as known have Chromium's width (${sizeKnown} of them also its height)`,
  );
  if (tw) console.log(`  (${assumed} of them flagged by the engine itself, e.g. unmeasured text; ${widths.length} widths ${widths[0]}–${widths.at(-1)}px, ${values.fixtures!.split(",").length} pages)`);
} else console.log(failures ? `\n✖ ${failures} mismatch(es) of ${checked} boxes` : `\n✓ engine and Chromium agree on all ${checked} boxes${strict ? `, none flagged; line counts agree on all ${linesChecked} text boxes` : ""}`);
process.exitCode = failures ? 1 : 0;
