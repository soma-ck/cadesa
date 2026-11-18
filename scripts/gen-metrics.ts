/**
 * Regenerate fonts/inter.metrics.json for the bundled Inter variable font.
 *
 *   npm run metrics
 *
 * Users measure their own fonts with `cascadio metrics <font> --family <name>`.
 */
import { generateMetrics, writeMetrics } from "../src/metrics.js";

const m = await generateMetrics({ font: "fonts/InterVariable-latin.woff2", family: "Inter" });
m.source = "InterVariable-latin.woff2 (Inter 4, SIL OFL 1.1, latin subset, wght axis)";
const file = writeMetrics(m, "fonts");
const pairs = Object.values(m.kerning).reduce((n, k) => n + Object.keys(k).length, 0);
console.log(`wrote ${file}: ${m.chars.length} glyphs × ${m.weights.length} weights, ${pairs} kerning pairs`);
