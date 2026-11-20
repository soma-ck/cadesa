/**
 * A handwriting font whose contextual alternates are too many to search (Caveat): its text is
 * exact where `cadesa fonts --measure` laid each of its runs out whole in Chromium and the run
 * stays on one line (fixtures/fonts/metrics/caveat.metrics.json.gz, for fixtures/css/handwriting.html).
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { walk } from "../src/engine/layout.js";
import { clearMetricsCache, metricsFor } from "../src/engine/text.js";
import { liftCssPage } from "../src/lift/css-page.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";
import { tailwindImpact } from "../src/commands.js";

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

describe("a handwriting font measured line by line", () => {
  it("has the page's runs laid out whole, at their sizes and weights", () => {
    const m = metricsFor("Caveat")!;
    expect(m.info.contextualIncomplete).toBe(true);
    // Chromium shapes contextual forms across spaces: the run's width isn't its words' sum.
    expect(m.lineWidth("Weeded the beetroot bed.", 22, 400)).toBeGreaterThan(0);
    expect(m.lineWidth("Weeded the beetroot bed.", 23, 400)).toBeUndefined();
  });

  it("lays out one-line runs exactly, and flags a run that wraps", () => {
    const t = liftCssPage("fixtures/css/handwriting.html", readFileSync("fixtures/css/handwriting.html", "utf8"), [{ file: "fixtures/css/handwriting.css", text: readFileSync("fixtures/css/handwriting.css", "utf8") }]);
    const layout = render(modelOf(loadSource("handwriting (lifted)", t.yaml)), t.fixtureAt(900), [900])[0];
    const impact = tailwindImpact(t, [layout])[0];
    const unsure = new Set(impact.uncertain.map((u) => u.id));
    const boxes = [...walk(layout.boxes)];
    const note = boxes.find((b) => b.id === "note")!;
    expect(note.lines?.length).toBe(1);
    expect(note.assumptions).toEqual([]);
    expect(unsure.has("note")).toBe(false);
    // The last note wraps: its pieces aren't measured.
    const last = boxes.filter((b) => /^note/.test(b.id)).at(-1)!;
    expect(last.lines!.length).toBeGreaterThan(1);
    expect(last.assumptions.join(" ")).toMatch(/contextual alternates/);
  });
});
