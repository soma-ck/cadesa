/**
 * Regenerate the metrics bundled for popular Google Fonts (fonts/<family>.metrics.json.gz).
 *
 *   npm run metrics:bundled [-- Roboto "Open Sans"]
 *
 * Each family is fetched from the Google Fonts CSS API (its variable wght axis when it has one,
 * else every static weight), latin subset, and measured in Chromium. The table records each
 * file's URL and sha256: it is exact for those files. Only the metrics are bundled, not the fonts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureGoogle } from "../src/fonts.js";
import { launchChromium, metricsFileName, readMetrics, writeMetrics } from "../src/metrics.js";

export const BUNDLED = ["Roboto", "Open Sans", "Montserrat", "Lato", "Poppins", "Source Sans 3", "Nunito", "Raleway"];

const families = process.argv.slice(2).length ? process.argv.slice(2) : BUNDLED;
const tmp = mkdtempSync(join(tmpdir(), "cadesa-bundled-"));
const browser = await launchChromium();
try {
  for (const family of families) {
    const t0 = performance.now();
    const r = await measureGoogle(family, { out: join(tmp, "metrics"), cacheDir: join(tmp, "fonts"), browser });
    if (r.error || !r.metrics) throw new Error(`${family}: ${r.error}`);
    const m = readMetrics(r.metrics);
    m.source = `Google Fonts ${family} (latin subset${m.kind === "variable" ? ", wght axis" : `, weights ${m.weights.join(", ")}`}), SIL OFL 1.1`;
    // Start from scratch: static faces would otherwise merge into an older table.
    rmSync(join("fonts", metricsFileName(family) + ".gz"), { force: true });
    const file = writeMetrics(m, "fonts", { gzip: true });
    console.log(`${file}: ${m.kind} ${m.weights.join(",")} from ${[...new Set(r.faces.map((f) => f.url))].join(", ")} (${Math.round(performance.now() - t0)}ms)`);
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
