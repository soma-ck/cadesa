/**
 * overflow: boxes that clip or scroll what doesn't fit. Chromium's numbers come from
 * conformance:css (fixtures/css/overflow.html), which checks every box at every 10px.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { compile } from "../src/compile.js";
import { walk } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { liftCssPage } from "../src/lift/css-page.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";
import { validate } from "../src/validate.js";

const errors = (yaml: string) => validate(loadSource("t.yaml", yaml)).diagnostics.map((d) => `${d.path}: ${d.message}`);

describe("the overflow property", () => {
  const base = "tokens: { size: { w: 100px } }\nstyles:\n  a:\n";
  it("takes one keyword or { x, y }, computed as CSS does (visible next to auto is auto)", () => {
    expect(errors(base + "    overflow: hidden\n")).toEqual([]);
    expect(errors(base + "    overflow: { x: auto }\n")).toEqual([]);
    expect(errors(base + "    overflow: hiden\n")[0]).toMatch(/invalid overflow/);
    expect(errors(base + "    overflow: { x: auto, z: hidden }\n")[0]).toMatch(/z/);
    const m = modelOf(loadSource("t.yaml", base + "    overflow: { x: auto }\n"));
    expect(m.components.get("a")!.props.overflow).toMatchObject({ x: "auto", y: "auto" });
    const clip = modelOf(loadSource("t.yaml", base + "    overflow: { x: clip, y: scroll }\n"));
    expect(clip.components.get("a")!.props.overflow).toMatchObject({ x: "hidden", y: "scroll" });
  });

  it("compiles to overflow-x and overflow-y", () => {
    const css = compile(modelOf(loadSource("t.yaml", base + "    overflow: { x: auto }\n")));
    expect(css).toContain("overflow-x: auto;\n  overflow-y: auto;");
  });
});

const page = "fixtures/css/overflow.html";
const t = liftCssPage(page, readFileSync(page, "utf8"), [{ file: "fixtures/css/overflow.css", text: readFileSync("fixtures/css/overflow.css", "utf8") }]);
const model = modelOf(loadSource("o.yaml", t.yaml));
const at = (w: number) => {
  const l = render(model, t.fixtureAt(w), [w])[0];
  return { l, b: Object.fromEntries([...walk(l.boxes)].map((b) => [b.id, b])) };
};
const rect = (b: { x: number; y: number; w: number; h: number }) => [b.x, b.y, b.w, b.h];

describe("overflow in layout (Chromium's boxes)", () => {
  it("lifts overflow, overflow-x and overflow-y, and visible again in a narrower state", () => {
    expect(validate(loadSource("o.yaml", t.yaml)).diagnostics).toEqual([]);
    expect(t.yaml).toMatch(/overflow: hidden/);
    expect(t.yaml).toMatch(/overflow: visible/);
    expect(t.lifted.unlifted.filter((u) => /overflow|text-overflow/.test(u.decl ?? "") && u.kind !== "none")).toEqual([]);
  });

  it("keeps a scroll container's children's margins inside it (a new formatting context); clip doesn't", () => {
    const wide = at(800).b;
    expect(rect(wide.card)).toEqual([16, 16, 768, 111]);
    expect(rect(wide["card-title"])).toEqual([16, 34, 768, 26]);
    expect(rect(wide.clip)).toEqual([16, 147, 768, 22.5]);
    expect(rect(wide["clip-body"])).toEqual([16, 147, 768, 22.5]);
    // overflow: visible below 600px: the title's margin collapses through the card again.
    expect(rect(at(375).b.card)).toEqual([16, 34, 343, 103.5]);
  });

  it("never lets an empty scroll container's margins collapse through it", () => {
    const b = at(800).b;
    expect(rect(b.spacer)).toEqual([16, 236, 768, 0]);
    expect(b["after-spacer"].y).toBe(266);
  });

  it("shrinks a scroll container in a row below its content (its minimum width is 0)", () => {
    const b = at(375).b;
    expect(rect(b.name)).toEqual([28, 341.5, 211, 22.5]);
    expect(rect(b.price)).toEqual([251, 341.5, 96, 22.5]);
  });

  it("lets content scroll inside a scroll container: no overflow finding, but a scrollbar may add height", () => {
    const { l, b } = at(375);
    expect(rect(b.scroller)).toEqual([16, 388, 343, 62.5]);
    expect(rect(b.wide)).toEqual([16, 400, 880, 38.5]);
    expect(l.issues.filter((i) => i.id === "scroller")).toEqual([]);
    expect(b.scroller.assumptions[0]).toMatch(/horizontal scrollbar adds height where scrollbars aren't overlaid/);
    // Its content doesn't move for a scrollbar at the bottom.
    expect(b.wide.assumptions.some((a) => /scrollbar/.test(a))).toBe(false);
    // A vertical scrollbar narrows the list's content, not the list (which only moves with the scroller above it).
    expect(b.list.assumptions.some((a) => /#list's scrollbar/.test(a))).toBe(false);
    expect(b["item-1"].assumptions[0]).toMatch(/its width depends on #list's scrollbar/);
    // Wide enough: nothing scrolls sideways, nothing assumed.
    expect(at(1280).b.scroller.assumptions).toEqual([]);
  });
});

describe("check: clipped and non-wrapping text", () => {
  it("reports text cut off by overflow: hidden where the box is narrower than the text, and only there", () => {
    const widths = [375, 800];
    const layouts = widths.map((w) => render(model, t.fixtureAt(w), [w])[0]);
    const f = check(layouts);
    const clipped = f.filter((x) => x.check === "clipped");
    expect(clipped.map((x) => [x.width, x.id])).toEqual([
      [375, "name"],
      [375, "truncate"],
    ]);
    expect(clipped[0].message).toMatch(/^the text of #name is cut off at 375px: "Harbor Supply and Logistics Internation…" needs [\d.]+px, the box shows 211px \(overflow: hidden\)/);
    expect(clipped[0].inconclusive).toBeUndefined();
    expect(f.filter((x) => x.check === "layout")).toEqual([]);
  });

  it("calls clipped text inconclusive when the box's width isn't known, not when it only moves", () => {
    const yaml = `
tokens: { size: { w: 120px, h: 40px }, color: { ink: "#111111" }, font: { ui: "Inter, sans-serif" } }
text: { t: { font: ui, size: 16px, weight: 400, lineHeight: 1.5, color: ink, wrap: none } }
styles:
  p:
    layout: { pattern: flow }
    slots:
      top: { text: t }
      name: { text: t, width: w, overflow: hidden }
`;
    const html = `<div class="ca-p" data-fixture="p"><div class="ca-p__top" data-fixture="top">Some text above</div><div class="ca-p__name" data-fixture="name">A name far too long for the box</div></div>`;
    const l = render(modelOf(loadSource("t.yaml", yaml)), parseFixture("t.html", html), [400]);
    const moved = { width: 400, exact: [], uncertain: [{ id: "name", effects: ["position" as const], reasons: ["moved by #top: x.css:1 something above"] }], paintOnly: [], noEffect: [] };
    const clipped = check(l, [moved]).find((x) => x.check === "clipped")!;
    expect(clipped.message).toMatch(/^the text of #name is cut off at 400px/);
    expect(clipped.inconclusive).toBeUndefined();
    const resized = { ...moved, uncertain: [{ id: "name", effects: ["size" as const], reasons: ["x.css:2 .name { min-width: 3em }: min-width is not modelled"] }] };
    expect(check(l, [resized]).find((x) => x.check === "clipped")?.inconclusive).toBe(true);
  });

  it("keeps a tap target's size conclusive when something uncertain above it only moves it", () => {
    const yaml = `
tokens: { size: { s: 32px } }
styles:
  p:
    layout: { pattern: flow }
    slots:
      close: { width: s, height: s }
`;
    const html = `<div class="ca-p" data-fixture="p"><button class="ca-p__close" data-fixture="close" type="button"></button></div>`;
    const l = render(modelOf(loadSource("t.yaml", yaml)), parseFixture("t.html", html), [400]);
    const moved = { width: 400, exact: [], uncertain: [{ id: "close", effects: ["position" as const], reasons: ["moved by #top: x.css:1 something above"] }], paintOnly: [], noEffect: [] };
    const tap = (imp: typeof moved) => check(l, [imp]).find((x) => x.check === "tap-target")!;
    expect(tap(moved).message).toMatch(/^#close is 32×32px; 44×44px is recommended/);
    expect(tap(moved).inconclusive).toBeUndefined();
    expect(tap({ ...moved, uncertain: [{ id: "close", effects: ["size" as const], reasons: ["x.css:2 .close { min-height: 3em }: min-height is not modelled"] }] }).inconclusive).toBe(true);
  });

  it("reports nowrap text that spills out of a box that doesn't clip it", () => {
    const yaml = `
tokens: { size: { w: 120px }, color: { ink: "#111111" }, font: { ui: "Inter, sans-serif" } }
text: { t: { font: ui, size: 16px, weight: 400, lineHeight: 1.5, color: ink, wrap: none } }
styles:
  p:
    layout: { pattern: flow }
    slots:
      name: { text: t, width: w }
`;
    const html = `<div class="ca-p" data-fixture="p"><div class="ca-p__name" data-fixture="name">A name far too long for the box</div></div>`;
    const l = render(modelOf(loadSource("t.yaml", yaml)), parseFixture("t.html", html), [400])[0];
    expect(l.issues.map((i) => i.message)).toEqual([expect.stringMatching(/^the text of #name doesn't wrap \(white-space: nowrap\) and overflows it by [\d.]+px at 400px$/)]);
  });
});
