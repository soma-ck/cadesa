/**
 * Measure one page variant in Chromium and print its defects (a development aid for writing tasks).
 *
 *   npx tsx bench/discovery/probe.ts --yaml <source.cadesa.yaml> [--css <file.css>] [--html <page.html>]
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { compile } from "../../src/compile.js";
import { loadSource } from "../../src/load.js";
import { findChrome } from "../../src/metrics.js";
import { modelOf } from "../../src/project.js";
import { summarize, sweep } from "./judge.js";

const { values } = parseArgs({ options: { yaml: { type: "string", default: "bench/discovery/page.cadesa.yaml" }, css: { type: "string" }, html: { type: "string", default: "bench/discovery/page.html" } } });
const dir = mkdtempSync(join(tmpdir(), "cadesa-probe-"));
const css = values.css ? readFileSync(values.css, "utf8") : compile(modelOf(loadSource("page.cadesa.yaml", readFileSync(values.yaml!, "utf8"))));
writeFileSync(join(dir, "page.css"), css);
cpSync(values.html!, join(dir, "page.html"));
cpSync("fonts/InterVariable-latin.woff2", join(dir, "InterVariable-latin.woff2"));
cpSync("examples/landing/assets", join(dir, "assets"), { recursive: true });
const browser = await chromium.launch({ executablePath: findChrome() });
const snaps = await sweep(browser, resolve(dir));
await browser.close();
const s = summarize(snaps);
console.log(`distinct ${s.distinct}, instances ${s.instances}`, s.byKind);
for (const [k, ws] of Object.entries(s.where)) {
  const d = snaps.find((x) => x.width === ws[0])!.defects.find((d) => `${d.kind}:${d.id}` === k);
  console.log(`  ${k.padEnd(40)} ${ws.length === 1 ? ws[0] : `${ws[0]}–${ws[ws.length - 1]} (${ws.length})`}  ${d?.detail ?? ""}`);
}
