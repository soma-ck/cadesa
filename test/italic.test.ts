/**
 * Italic faces: text and runs in a family whose italic face the page loads are measured with its
 * italic table (fixtures/fonts/metrics has Lato's); a synthesized italic (no italic face) is as wide
 * as upright text. conformance:css checks fixtures/css/italic.html.
 */
import { afterEach, describe, expect, it } from "vitest";
import { clearMetricsCache } from "../src/engine/text.js";
import { run } from "./lift-page.js";

const faces = `<style>@font-face { font-family: "Lato"; font-weight: 400; src: url(Lato-Regular.woff2) }
@font-face { font-family: "Lato"; font-weight: 400; font-style: italic; src: url(Lato-Italic.woff2) }
@font-face { font-family: "Inter"; font-weight: 100 900; src: url(Inter.woff2) }</style>`;

describe("italic faces", () => {
  const saved = process.env.CADESA_METRICS;
  afterEach(() => {
    if (saved === undefined) delete process.env.CADESA_METRICS;
    else process.env.CADESA_METRICS = saved;
    clearMetricsCache();
  });

  it("measures text and runs in a real italic face with its italic table", () => {
    process.env.CADESA_METRICS = "fixtures/fonts/metrics";
    clearMetricsCache();
    const r = run(
      `<p data-fixture="a" class="i">forty-one years</p><p data-fixture="b">kept for <em>forty-one years</em> on</p>`,
      `body { margin: 0; font: 17px/1.5 Lato } p { margin: 0; width: max-content } .i { font-style: italic }`,
      [800],
      { bare: true, head: faces },
    );
    // Chromium: 104.5px in the italic face (114.31px upright).
    expect(r.box("a").w).toBeCloseTo(104.5, 1);
    expect(r.approx("a")).toBeUndefined();
    expect(r.approx("b")).toBeUndefined();
    expect(r.t.yaml).toMatch(/style: italic/);
  });

  it("measures a synthesized italic upright, and leaves text in a face without an italic table approximate", () => {
    process.env.CADESA_METRICS = "test/no-metrics-here";
    clearMetricsCache();
    const r = run(
      `<p data-fixture="a"><em>slanted</em> text</p><p data-fixture="b" class="l"><em>real</em> italic</p>`,
      `body { margin: 0; font: 16px/1.5 Inter } p { margin: 0 } .l { font-family: Lato }`,
      [800],
      { bare: true, head: faces },
    );
    expect(r.approx("a")).toBeUndefined();
    expect(r.approx("b")).toMatch(/italic/);
  });
});
