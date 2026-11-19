/**
 * Line boxes from the font's vertical metrics: inline-blocks alone on their line (buttons centered
 * on it, a badge on the baseline, an icon taller than its button's line), text fields and
 * line-height: normal. Every number is what Chromium lays out (conformance:css checks the same
 * cases at every width in fixtures/css/lines.html).
 */
import { describe, expect, it } from "vitest";
import { metricsFor } from "../src/engine/text.js";
import { run } from "./lift-page.js";

const geo = (b: { x: number; y: number; w: number; h: number }) => [b.x, b.y, b.w, b.h].map((n) => +n.toFixed(3));

describe("vertical metrics", () => {
  it("rounds ascent, descent and line gap to whole px at each size, as Chromium does", () => {
    const m = metricsFor("Inter")!;
    // Measured in Chromium: canvas fontBoundingBoxAscent / Descent.
    expect([16, 14, 13, 12, 17.5, 20].map((s) => [m.vertical(s, 400)!.ascent, m.vertical(s, 400)!.descent])).toEqual([[16, 4], [14, 3], [13, 3], [12, 3], [17, 4], [19, 5]]);
    expect(m.vertical(16, 400)!.xHeight).toBeCloseTo(8.734375, 6);
    expect(m.vertical(16, 400)!.lineGap).toBe(0);
  });
});

describe("an inline-block alone on its line", () => {
  const css = `* { box-sizing: border-box } p { margin: 0 }
.bar { display: flex; align-items: center; justify-content: space-between; padding: 8px }
.tog { font-family: inherit; padding: 4px 12px; font-size: 20px; line-height: 1; border: 1px solid #999; background: none }
.icon { display: inline-block; width: 1.5em; height: 1.5em; vertical-align: middle }
.btn { display: inline-block; font: inherit; padding: 6px 12px; line-height: 1.5; border: 1px solid #333; vertical-align: middle }
.sm { font-size: 14px; padding: 4px 8px }
.badge { display: inline-block; padding: 3px 6px; font-size: 12px; line-height: 1; font-weight: 700; border: 1px solid #333; white-space: nowrap }
.big { font-size: 24px; line-height: 2 }
.dot { display: inline-block; width: 8px; height: 8px }
.center { text-align: center }`;
  const r = run(
    `<div class="bar"><button class="tog" type="button"><span class="icon"></span></button><a class="brand">Brand</a></div>
<div class="slot"><button class="btn" type="button">Save changes</button></div>
<div class="slot"><button class="btn sm" type="button">Small one</button></div>
<div class="slot"><span class="badge">New</span></div>
<div class="slot big"><span class="dot"></span></div>
<div class="slot center"><button class="btn" type="button">Centered</button></div>`,
    css,
    [400],
  );

  it("lays out the page exactly", () => expect(r.exact()).toBe(true));

  it("an icon taller than its button's line, centered on it: the line box is the icon", () => {
    expect(geo(r.box("tog"))).toEqual([8, 8, 56, 40]);
    expect(geo(r.box("icon"))).toEqual([21, 13, 30, 30]);
  });

  it("buttons centered on the line contain the strut: the line box is the button", () => {
    expect(geo(r.box("btn"))).toEqual([0, 56, 132.156, 38]);
    expect(geo(r.box("slot-2"))).toEqual([0, 94, 400, 31]);
  });

  it("a badge on the baseline: the strut reaches above it", () => {
    expect(r.box("slot-3").h).toBe(24);
    expect(r.box("badge").y - r.box("slot-3").y).toBe(4);
  });

  it("an 8px box on the baseline of a 48px line sits on the baseline", () => {
    expect(geo(r.box("slot-4"))).toEqual([0, 149, 400, 48]);
    expect(geo(r.box("dot"))).toEqual([0, 173, 8, 8]);
  });

  it("text-align: center centers it (in layout units, rounded down)", () => {
    expect(geo(r.box("btn-3"))).toEqual([152.109, 197, 95.766, 38]);
  });
});

describe("text fields and line-height: normal", () => {
  const r = run(
    `<p class="n">Normal line height text that wraps across a few lines when the window is narrow</p><p class="n2">Normal at 13px</p><div class="f"><input class="in" type="text" value="Hello"></div><div class="f"><input class="in3" type="email"></div>`,
    `p { margin: 0 } body { line-height: normal } .n { font-size: 16px } .n2 { font-size: 13px } .in { font: inherit; width: 200px } .in3 { font-family: Inter; width: 150px; line-height: 1.5 }`,
    [400],
  );

  it("line-height: normal is the font's ascent, descent and line gap", () => {
    expect(geo(r.box("n"))).toEqual([0, 0, 400, 40]);
    expect(geo(r.box("n2"))).toEqual([0, 40, 400, 16]);
  });

  it("a text field is one line (never shorter than normal) plus padding and border, with or without native appearance", () => {
    expect(geo(r.box("in"))).toEqual([0, 56, 208, 26]);
    // 13.33px at line-height 1.5: 19.984px, more than normal (16px).
    expect(geo(r.box("in3"))).toEqual([0, 82, 158, 25.984]);
    expect(r.approx("in")).toBeUndefined();
    expect(r.approx("in3")).toBeUndefined();
  });
});
