import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { critique } from "../src/critique.js";
import { parseFixture } from "../src/fixture.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";

const run = (src: string, fx: string, widths = [390, 768, 1280], edit = (s: string) => s) => {
  const model = modelOf(loadSource(src, edit(readFileSync(src, "utf8"))));
  const fixture = parseFixture(fx);
  return critique(model, fixture, render(model, fixture, widths));
};
const LANDING = ["examples/landing/landing.cadesa.yaml", "examples/landing/landing.html"] as const;

describe("critique", () => {
  it("has nothing to say about the landing example", () => {
    expect(run(...LANDING)).toEqual([]);
  });

  it("flags a palette with no hue (the settings panel is all greys)", () => {
    const c = run("settings.cadesa.yaml", "fixtures/settings-long.html");
    expect(c.map((x) => x.check)).toEqual(["type-scale", "palette"]);
    expect(c[1].message).toMatch(/every color in use is a grey/);
  });

  it("reports one band of near-identical sizes, not one per pair", () => {
    const c = run(...LANDING, undefined, (s) => s.replace("card-meta: { font: ui, size: 0.9375rem", "card-meta: { font: ui, size: 1rem"));
    expect(c).toHaveLength(1);
    expect(c[0].message).toMatch(/^font sizes 15, 16, 17px are within 1\.13×/);
  });

  it("flags a heading that barely stands out from the text under it", () => {
    const c = run(...LANDING, undefined, (s) => s.replace("heading: { font: ui, size: 2.25rem, weight: 720", "heading: { font: ui, size: 1.1875rem, weight: 500"));
    expect(c.find((x) => x.check === "hierarchy")!.message).toMatch(/#trips-title <h2> is 19px\/500 over #trips-intro at 17px\/400/);
  });

  it("flags groups whose inner gap isn't smaller than the gap around them", () => {
    const c = run(...LANDING, undefined, (s) => s.replace("head: { layout: { pattern: stack, gap: snug } }", "head: { layout: { pattern: stack, gap: section } }"));
    expect(c.find((x) => x.check === "grouping")!.path).toBe("styles.trips.slots.head.layout.gap");
  });

  it("flags misaligned left edges and names them", () => {
    const c = run(...LANDING, [1280], (s) => s.replace("inner: { layout: { pattern: stack, gap: roomy }, maxWidth: content, padding: { inline: roomy } }", "inner: { layout: { pattern: stack, gap: roomy }, maxWidth: content }"));
    expect(c.find((x) => x.check === "alignment")!.message).toMatch(/text edges almost line up at 1280px: x=64: #closing-title, #closing-body vs x=88: #title, #lede… \(24px apart\)/);
  });

  it("flags template tells in the source and the copy", () => {
    const c = run(...LANDING, undefined, (s) => s.replace("card-meta: { font: ui, size: 0.9375rem, weight: 400, lineHeight: 1.45, color: slate }", "card-meta: { font: ui, size: 0.75rem, weight: 600, lineHeight: 1.45, color: slate, letterSpacing: 0.08, transform: uppercase }"));
    expect(c.some((x) => x.check === "tells" && /tracked uppercase/.test(x.message))).toBe(true);
  });
});
