/**
 * Containment (contain, content-visibility) and the containing blocks it makes. Every number is
 * what Chromium lays out (conformance:css checks the same cases at every width in
 * fixtures/css/contained.html).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseContain } from "../src/model.js";
import { run } from "./lift-page.js";

const geo = (b: { x: number; y: number; w: number; h: number }) => [b.x, b.y, b.w, b.h].map((n) => +n.toFixed(3));
const fixture = (name: string) => {
  const html = readFileSync(`fixtures/css/${name}.html`, "utf8").replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, "");
  return run(html, readFileSync(`fixtures/css/${name}.css`, "utf8"), [400], { bare: true });
};

describe("contain values", () => {
  it("reads keywords, shorthands and combinations", () => {
    expect(parseContain("layout paint style")).toEqual({ layout: true, paint: true });
    expect(parseContain("content")).toEqual({ layout: true, paint: true });
    expect(parseContain("strict")).toEqual({ layout: true, paint: true, size: "both" });
    expect(parseContain("inline-size layout")).toEqual({ layout: true, paint: false, size: "inline" });
    expect(parseContain("none")).toEqual({ layout: false, paint: false });
    expect(parseContain("size inline-size")).toBeUndefined();
    expect(parseContain("layout layout")).toBeUndefined();
  });
});

describe("containment", () => {
  const r = fixture("contained");

  it("lays out the page exactly", () => expect(r.exact()).toBe(true));

  it("layout and paint containment keep the children's margins inside", () => {
    // The inner block's 20px margins don't collapse through the panel's edges.
    expect(geo(r.box("panel"))).toEqual([16, 0, 368, 146]);
    expect(geo(r.box("panel-inner"))).toEqual([16, 20, 368, 106]);
    // contain: content: the paragraph's 24px margins stay inside too; a plain block lets them through.
    expect(geo(r.box("notes"))).toEqual([16, 146, 368, 96]);
    expect(geo(r.box("loose"))).toEqual([16, 266, 368, 48]);
  });

  it("a contained box is the containing block of its absolute and fixed descendants", () => {
    expect(geo(r.box("panel-badge"))).toEqual([312, 8, 64, 24]);
    expect(geo(r.box("note-pin"))).toEqual([108, 238, 184, 4]);
    // position: fixed, placed in the dock rather than the window.
    expect(geo(r.box("dock-bar"))).toEqual([16, 486, 184, 6]);
  });

  it("size containment sizes the box as if empty; inline-size only its widths", () => {
    expect(geo(r.box("sized"))).toEqual([16, 338, 368, 20]);
    expect(geo(r.box("note-3"))).toEqual([28, 372, 344, 48]);
    // An inline-size-contained flex item is as wide as its padding.
    expect(geo(r.box("row-item"))).toEqual([16, 374, 16, 96]);
    expect(geo(r.box("row-side"))).toEqual([44, 374, 64.859, 96]);
  });

  it("paint containment alone is an independent formatting context too", () => {
    expect(geo(r.box("painted"))).toEqual([16, 570, 368, 72]);
    expect(geo(r.box("note-4"))).toEqual([16, 594, 368, 24]);
  });

  it("content-visibility: auto is containment whose height depends on being on screen (≈)", () => {
    const c = run(`<section class="cv"><p class="t">Shown when on screen</p></section><p class="after">After</p>`, `p { margin: 24px 0 } .cv { content-visibility: auto }`);
    expect(geo(c.box("cv"))).toEqual([0, 0, 400, 72]);
    expect(c.approx("cv")).toMatch(/content-visibility: auto/);
    expect(c.approx("t")).toBeUndefined();
    expect(c.approx("after")).toMatch(/content-visibility/);
  });

  it("will-change and isolation change nothing, unless will-change makes a fixed box's containing block", () => {
    const c = run(`<div class="a"><p class="t">Text</p></div><div class="b"><p class="t">Text</p><div class="bar"></div></div>`, `p { margin: 0 } .a { will-change: transform; isolation: isolate } .b { will-change: transform } .bar { position: fixed; top: 0; width: 10px; height: 10px }`);
    expect(c.approx("a")).toBeUndefined();
    expect(c.approx("bar")).toMatch(/containing block/);
  });
});
