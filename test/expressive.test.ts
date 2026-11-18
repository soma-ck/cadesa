import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { compile } from "../src/compile.js";
import { walk, type Layout } from "../src/engine/layout.js";
import { layoutText, metricsFor } from "../src/engine/text.js";
import { parseFixture } from "../src/fixture.js";
import { loadSource } from "../src/load.js";
import { modelOf, render, whatif } from "../src/project.js";

const SRC = "examples/landing/landing.cadesa.yaml";
const text = readFileSync(SRC, "utf8");
const model = modelOf(loadSource(SRC, text));
const fixture = parseFixture("examples/landing/landing.html");
const box = (l: Layout, id: string) => [...walk(l.boxes)].find((b) => b.id === id)!;
const [phone, tablet, desktop] = render(model, fixture, [390, 768, 1280]);

describe("expressive layout (verified against Chromium by npm run conformance:landing)", () => {
  it("has no layout issues and passes check, including contrast against page.background", () => {
    expect([...phone.issues, ...tablet.issues, ...desktop.issues]).toEqual([]);
    // Only the hero copy over the photo is left to the eye: its scrim starts fully transparent.
    const findings = check([phone, tablet, desktop]);
    expect(findings.every((f) => f.inconclusive && /sits over the image #art/.test(f.message))).toBe(true);
    expect([...new Set(findings.map((f) => f.id))].sort()).toEqual(["hero-how", "lede", "title"]);
  });

  it("grid: auto-fills columns from min, never leaving an orphan here (4 → 2 → 1)", () => {
    const xs = (l: Layout) => new Set(["dawn", "glacier", "island", "seals"].map((id) => box(l, id).x)).size;
    expect([xs(desktop), xs(tablet), xs(phone)]).toEqual([4, 2, 1]);
    expect(box(desktop, "dawn").w).toBe((1104 - 3 * 24) / 4);
  });

  it("aspect: an image's height follows its width", () => {
    const p = box(desktop, "dawn-photo");
    expect(p.h).toBeCloseTo((p.w * 3) / 4, 9);
    expect(box(desktop, "art").h).toBeCloseTo((1280 * 7) / 16, 9);
    expect(box(phone, "art").h).toBeCloseTo((390 * 4) / 3, 9);
  });

  it("layer: children share one cell; align end puts the copy on the bottom edge", () => {
    const art = box(desktop, "art");
    const copy = box(desktop, "copy");
    expect(copy.y + copy.h).toBeCloseTo(art.y + art.h, 9);
    expect(copy.x).toBe(art.x);
  });

  it("maxWidth frames inside full-bleed bands line up with the content column", () => {
    for (const l of [desktop, tablet, phone]) {
      const x = box(l, "trips-title").x;
      expect(box(l, "title").x).toBe(x);
      expect(box(l, "closing-title").x).toBe(x);
    }
  });

  it("measure caps a line length without centering", () => {
    const intro = box(desktop, "trips-intro");
    expect(intro.w).toBe(38 * 16);
    expect(intro.x).toBe(box(desktop, "trips-title").x);
  });

  it("compiles paint, shadow, layer children and page background", () => {
    const css = compile(model);
    expect(css).toContain(":root {\n  --ca-color-glacier: #e9f0f1;\n  background-color: var(--ca-color-glacier);\n}");
    expect(css).toContain("background-image: var(--ca-paint-scrim);");
    expect(css).toContain("box-shadow: var(--ca-shadow-lift);");
    expect(css).toContain(".ca-hero > * {\n  grid-area: 1 / 1;\n}");
    expect(css).toContain("grid-template-columns: repeat(auto-fill, minmax(min(var(--ca-size-card-min), 100%), 1fr));");
    expect(css).toContain("aspect-ratio: 16 / 7;");
    expect(css).toContain("letter-spacing: -0.035em;");
  });

  it("whatif across a grid: a smaller min reflows cards without touching the hero", () => {
    const r = whatif(loadSource(SRC, text), fixture, [768], [{ path: "tokens.size.card-min", value: "13rem" }]);
    const ids = r.widths[0].elements.map((e) => e.id);
    expect(ids).toContain("seals");
    expect(ids).not.toContain("title");
  });

  it("measures letter-spacing and uppercase", () => {
    const inter = metricsFor("Inter")!;
    const plain = layoutText(inter, "Seal colony", 13, 560, 1000).maxContent;
    const spaced = layoutText(inter, "Seal colony", 13, 560, 1000, { letterSpacing: 0.78 }).maxContent;
    expect(spaced - plain).toBeCloseTo(11 * 0.78, 9);
    expect(layoutText(inter, "SEAL COLONY", 13, 560, 1000).maxContent).toBeGreaterThan(plain);
  });

  it("warns about media without aspect or height instead of measuring 0px silently", () => {
    const html = '<section class="ca-trips"><img class="ca-trips__list" data-fixture="pic" src="x.png" /></section>';
    const m = modelOf(loadSource(SRC, text.replace("list: { layout: { pattern: grid, min: card-min, gap: roomy, align: start } }", "list: {}")));
    const [l] = render(m, parseFixture("x.html", html), [390]);
    expect(l.issues.map((i) => i.message).join()).toMatch(/<img> #pic has no aspect or height/);
  });

  it("validates the new vocabulary", () => {
    const bad = (from: string, to: string) => () => modelOf(loadSource(SRC, text.replace(from, to)));
    expect(bad("list: { layout: { pattern: grid, min: card-min,", "list: { layout: { pattern: grid,")).toThrow(/a grid needs "min"/);
    expect(bad('scrim: "linear-gradient', 'scrim: "red; linear-gradient')).toThrow(/invalid paint/);
    expect(bad('photo: { aspect: "4:3"', 'photo: { aspect: "4:0"')).toThrow(/invalid aspect/);
    expect(bad('photo: { aspect: "4:3", fit: cover', 'photo: { aspect: "4:3", height: control, fit: cover')).toThrow(/aspect and height both set the height/);
  });
});
