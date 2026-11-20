/**
 * Math set by KaTeX (fixtures/katex: its CSS, fonts and formulas it rendered): superscripts,
 * subscripts, fractions and roots are inline tables of rows of set heights (vlist), laid out as one
 * object on their line. Every number is what Chromium lays out (conformance:css checks every width).
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { walk } from "../src/engine/layout.js";
import { clearMetricsCache } from "../src/engine/text.js";
import { liftCssPage } from "../src/lift/css-page.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";
import { tailwindImpact } from "../src/commands.js";

const read = (f: string) => readFileSync(`fixtures/katex/${f}`, "utf8");
let before: string | undefined;
beforeAll(() => {
  before = process.env.CADESA_METRICS;
  process.env.CADESA_METRICS = "fixtures/fonts/metrics";
  clearMetricsCache();
});
afterAll(() => {
  if (before === undefined) delete process.env.CADESA_METRICS;
  else process.env.CADESA_METRICS = before;
  clearMetricsCache();
});

describe("KaTeX's stacks: superscripts, subscripts, fractions and roots", () => {
  it("lays out every formula in scripts.html exactly, as Chromium does at 400px", () => {
    const t = liftCssPage("fixtures/katex/scripts.html", read("scripts.html"), [
      { file: "fixtures/katex/katex.css", text: read("katex.css") },
      { file: "fixtures/katex/math.css", text: read("math.css") },
    ]);
    const layout = render(modelOf(loadSource("scripts (lifted)", t.yaml)), t.fixtureAt(400), [400])[0];
    const impact = tailwindImpact(t, [layout])[0];
    expect(impact.uncertain).toEqual([]);
    const top = [...walk(layout.boxes)].find((b) => b.id === "page")!.children;
    // Chromium: each paragraph's and box's x, y, width and height (px).
    const chromium = [
      [16, 16, 368, 50.53125],
      [16, 78.53125, 368, 50.859375],
      [16, 141.390625, 368, 48.671875],
      [16, 202.0625, 368, 48.515625],
      [16, 262.578125, 368, 21.765625],
      [16, 296.34375, 368, 67.703125],
      [16, 376.046875, 368, 51.984375],
      [16, 440.03125, 368, 25.21875],
      [16, 477.25, 368, 48.0625],
      [16, 537.3125, 173.28125, 35.21875],
      [16, 580.53125, 103.984375, 34.671875],
      [16, 623.203125, 205.390625, 35.21875],
      [16, 666.421875, 141.78125, 29.875],
      [16, 704.296875, 205.96875, 45.140625],
      [16, 757.4375, 368, 28],
    ];
    expect(top.map((b) => [b.x, b.y, b.w, b.h].map((n) => Math.round(n * 64) / 64))).toEqual(chromium);
  });
});
