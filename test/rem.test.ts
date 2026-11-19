/**
 * Rem lengths resolve against the page's root font size, per width range: `html { font-size:
 * 62.5% }`, `10pt`, a media query that changes it, and one that follows the viewport width.
 */
import { describe, expect, it } from "vitest";
import { run } from "./lift-page.js";

const geo = (b: { x: number; y: number; w: number; h: number }) => [b.x, b.y, b.w, b.h].map((n) => +n.toFixed(3));

describe("a root font size other than 16px", () => {
  it("resolves rem lengths, calc(), clamp() and font sizes against it", () => {
    const r = run(
      `<div data-fixture="d"><p data-fixture="p">Text</p></div>`,
      `html { font-size: 62.5% } body { margin: 0; font: 1.6rem/2.4rem Inter, sans-serif }
div { padding: 1rem calc(2rem + 4px); width: clamp(10rem, 50vw, 30rem) } p { margin: 0 0 0.5rem; font-size: 2rem; line-height: 1.5 }`,
      [400, 1000],
      { bare: true },
    );
    expect(geo(r.box("d", 400))).toEqual([0, 0, 200 + 48, 10 + 30 + 5 + 10]);
    expect(geo(r.box("p", 400))).toEqual([24, 10, 200, 30]);
    expect(geo(r.box("d", 1000))).toEqual([0, 0, 300 + 48, 55]);
    expect(r.exact(400) && r.exact(1000)).toBe(true);
  });
  it("follows a media query that changes it", () => {
    const r = run(
      `<p data-fixture="p">Text</p>`,
      `html { font-size: 10pt } @media (min-width: 600px) { html { font-size: 20px } }
body { margin: 0; font: 16px/1 Inter, sans-serif } p { margin: 0; padding: 1rem; width: 10rem }`,
      [400, 800],
      { bare: true },
    );
    // 13.333px in layout units (1/64 px), as Chromium has it.
    expect(geo(r.box("p", 400))).toEqual([0, 0, 159.984, 42.656]);
    expect(geo(r.box("p", 800))).toEqual([0, 0, 240, 56]);
    expect(r.exact(400) && r.exact(800)).toBe(true);
  });
  it("makes rem follow a root size that follows the viewport width", () => {
    const r = run(`<p data-fixture="p">Text</p>`, `html { font-size: calc(10px + 1vw) } body { margin: 0; font: 16px/1 Inter, sans-serif } p { margin: 0; width: 10rem }`, [400, 1000], { bare: true });
    expect(r.box("p", 400).w).toBeCloseTo(140, 3);
    expect(r.box("p", 1000).w).toBeCloseTo(200, 3);
  });
});
