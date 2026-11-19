/**
 * Transforms: where a box and its content are drawn (getBoundingClientRect()), which is what the
 * conformance suites compare. Every number is Chromium's (fixtures/css/transforms.html checks more
 * cases at every width).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { individual, originOf, transformList } from "../src/engine/transform.js";
import { run } from "./lift-page.js";

const geo = (b: { x: number; y: number; w: number; h: number }) => [b.x, b.y, b.w, b.h].map((n) => +n.toFixed(3));

describe("transform values", () => {
  it("reads 2D transform functions", () => {
    expect(transformList("translate(10px, 50%)", 100, 40)).toEqual([1, 0, 0, 1, 10, 20]);
    expect(transformList("scale(2) translateX(5px)", 0, 0)).toEqual([2, 0, 0, 2, 10, 0]);
    expect(transformList("rotate(90deg)", 0, 0)).toEqual([0, 1, -1, 0, 0, 0]);
    expect(transformList("translateZ(0)", 0, 0)).toEqual([1, 0, 0, 1, 0, 0]);
    // 3D rotations and perspective aren't a 2D map Cadesa draws.
    expect(transformList("rotateX(20deg)", 10, 10)).toBeUndefined();
    expect(transformList("perspective(100px) rotateY(3deg)", 10, 10)).toBeUndefined();
  });

  it("reads transform-origin and the individual properties", () => {
    expect(originOf(undefined, 100, 40)).toEqual([50, 20]);
    expect(originOf("left top", 100, 40)).toEqual([0, 0]);
    expect(originOf("bottom right", 100, 40)).toEqual([100, 40]);
    expect(originOf("25% 10px", 100, 40)).toEqual([25, 10]);
    expect(individual("translate", "4px 0")).toBe("translate(4px, 0)");
    expect(individual("rotate", "z 5deg")).toBe("rotate(5deg)");
    expect(individual("rotate", "x 5deg")).toBeUndefined();
  });
});

describe("transformed boxes", () => {
  const r = run(
    `<div data-fixture="rot" class="rot"></div>
<div data-fixture="box" class="box"><div data-fixture="badge" class="badge"></div></div>
<div data-fixture="sc" class="sc"><div data-fixture="in" class="in"></div></div>`,
    `* { box-sizing: border-box }
.rot { width: 200px; height: 100px; transform: rotate(30deg); }
.box { position: relative; height: 50px; }
.badge { position: absolute; top: 0; left: 0; width: 40px; height: 20px; transform: translate(-50%, -50%); }
.sc { width: 100px; height: 40px; scale: 2; transform-origin: 0 0; }
.in { width: 50px; height: 20px; margin-left: 10px; }`,
  );

  it("is exact", () => expect(r.exact()).toBe(true));

  it("draws a rotated box as the bounding box of its corners, and moves nothing else", () => {
    expect(geo(r.box("rot"))).toEqual([-11.603, -43.301, 223.205, 186.603]);
    expect(geo(r.box("box"))).toEqual([0, 100, 400, 50]);
  });

  it("translates by a percentage of the box's own size", () => expect(geo(r.box("badge"))).toEqual([-20, 90, 40, 20]));

  it("maps what is inside a transformed box too", () => {
    expect(geo(r.box("sc"))).toEqual([0, 150, 200, 80]);
    expect(geo(r.box("in"))).toEqual([20, 150, 100, 40]);
  });
});

describe("the transforms fixture", () => {
  const html = readFileSync("fixtures/css/transforms.html", "utf8").replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, "");
  const r = run(html, readFileSync("fixtures/css/transforms.css", "utf8"), [360, 1200], { bare: true });
  it("is exact", () => {
    expect(r.exact(360)).toBe(true);
    expect(r.exact(1200)).toBe(true);
  });
});
