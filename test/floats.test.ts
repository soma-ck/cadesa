/**
 * Floats (engine/floats.ts): placement by CSS 2.1 §9.5.1, boxes of their own formatting context
 * beside them, clearance, and lines of text around them. Every number is what Chromium lays out
 * (conformance:css checks more at every width in fixtures/css/floats.html).
 */
import { describe, expect, it } from "vitest";
import { Exclusions } from "../src/engine/floats.js";
import { run } from "./lift-page.js";

const geo = (b: { x: number; y: number; w: number; h: number }) => [b.x, b.y, b.w, b.h].map((n) => +n.toFixed(3));

describe("the exclusion space", () => {
  it("places floats as high and as far to their side as the floats before them allow", () => {
    const ex = new Exclusions();
    expect(ex.place("left", 100, 30, 0, 0, 300)).toEqual({ x: 0, y: 0 });
    expect(ex.place("left", 150, 60, 0, 0, 300)).toEqual({ x: 100, y: 0 });
    // 120px doesn't fit beside them (50px left), nor below the first (still beside the second): below both.
    expect(ex.place("left", 120, 10, 0, 0, 300)).toEqual({ x: 0, y: 60 });
    // Never above an earlier float's top.
    expect(ex.place("right", 50, 10, 0, 0, 300)).toEqual({ x: 250, y: 60 });
    expect(ex.clearance("left")).toBe(70);
    expect(ex.band(65, 0, 0, 300)).toEqual({ l: 120, r: 250, beside: true });
  });
});

describe("floats among a paragraph's text", () => {
  const r = run(
    `<main><p class="p1">Some text <span class="f">x</span>more text that goes on and wraps around the float here.</p>
<p class="p2">A first line of text that is long enough <span class="f">x</span>to fill, then more text after it.</p>
<p class="p3">Text then a left one <span class="l">x</span>in the middle of the line and on.</p></main>`,
    `main { width: 300px } p { margin: 0 0 10px }
.f { float: right; width: 100px; height: 30px } .l { float: left; width: 60px; height: 40px }`,
    [800],
  );

  it("one that fits beside the line so far goes at the line's top, the line shortened (moved over by a left one)", () => {
    expect(geo(r.box("f"))).toEqual([200, 0, 100, 30]);
    expect(geo(r.box("p1"))).toEqual([0, 0, 300, 72]);
    expect(geo(r.box("l"))).toEqual([0, 140, 60, 40]);
    expect(r.box("p3").lines!.map((l) => l.x)).toEqual([60, 60]);
  });

  it("one that doesn't fit goes below the line", () => {
    expect(geo(r.box("f-2"))).toEqual([200, 106, 100, 30]);
    expect(geo(r.box("p2"))).toEqual([0, 82, 300, 48]);
    expect(r.exact()).toBe(true);
  });
});

describe("floats in block flow", () => {
  const r = run(
    `<section><div class="fl m"></div><div class="bfc">A box of its own beside the float</div><div class="wide">Margin wider than the float</div></section>
<section><div class="fl s2"></div><div class="fl s3"></div><div class="fl s4"></div><div class="fr s5"></div></section>
<section><div class="above">above</div><div class="fl s2"></div><div class="c1">cleared</div><div class="fl s6"></div><div class="c2">not cleared</div></section>
<section><div class="fl auto">shrink to fit</div><p class="t">Lines of text go around the float that came before them and then on below it.</p></section>`,
    `section { margin-bottom: 40px } p { margin: 0 }
.fl { float: left; width: 100px; height: 50px } .fr { float: right; width: 80px; height: 30px }
.m { margin: 5px 10px 7px 3px } .bfc { overflow: hidden; margin-left: 20px; margin-right: 6px } .wide { overflow: hidden; margin-left: 150px }
.s2 { height: 30px } .s3 { width: 150px; height: 60px } .s4 { width: 120px; height: 10px } .s5 { width: 50px; height: 10px }
.above { margin-bottom: 20px } .c1 { clear: left; margin-top: 10px } .c2 { clear: left; margin-top: 30px } .s6 { height: 10px }
.auto { width: auto; height: auto }`,
    [300],
  );
  const at = (cls: string) => geo(r.box(cls));

  it("a box of its own formatting context sits beside a float, its margin inside the float's", () => {
    expect(at("fl")).toEqual([3, 5, 100, 50]);
    expect(at("bfc")).toEqual([113, 0, 181, 48]);
    expect(at("wide")).toEqual([150, 48, 150, 48]);
  });

  it("floats stack beside each other, and wrap below where they don't fit", () => {
    expect(at("section-2")).toEqual([0, 136, 300, 0]);
    expect([at("fl-2"), at("fl-2-2"), at("fl-3"), at("fr")]).toEqual([
      [0, 136, 100, 30],
      [100, 136, 150, 60],
      [0, 196, 120, 10],
      [250, 196, 50, 10],
    ]);
  });

  it("clear puts a box below the floats unless its margins already do", () => {
    expect(at("fl-4")).toEqual([120, 196, 100, 30]);
    expect(at("c1")).toEqual([0, 226, 300, 24]);
    expect(at("c2")).toEqual([0, 280, 300, 24]);
  });

  it("a float without a width is as wide as its content; lines beside it are shortened", () => {
    expect(at("fl-5")).toEqual([0, 344, 84.906, 24]);
    expect(at("t")).toEqual([0, 344, 300, 72]);
    expect(r.exact()).toBe(true);
  });
});
