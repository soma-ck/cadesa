/**
 * Form controls sized as Chromium sizes them on Linux, from probe pages: a select's widest option
 * plus the menulist's internal padding (20px with native appearance), a text field's average and
 * maximum character widths × size, a textarea's columns plus its 15px scrollbar, button inputs'
 * labels at line-height: normal, the theme's 13×13 checkbox and radio and 129×16 range, and a
 * button with a set height centering its text. conformance:css checks fixtures/css/forms.html.
 */
import { describe, expect, it } from "vitest";
import { metricsFor } from "../src/engine/text.js";
import { run } from "./lift-page.js";

const geo = (b: { x: number; y: number; w: number; h: number }) => [b.x, b.y, b.w, b.h].map((n) => +n.toFixed(3));

describe("form controls", () => {
  const r = run(
    `<div class="f"><select data-fixture="s2" class="n"><option>English</option><option>Español</option></select></div>
<div class="f"><input data-fixture="c1" type="checkbox"> <input data-fixture="r1" type="radio"> label</div>
<div class="f"><input data-fixture="t1"></div>
<div class="f"><input data-fixture="t2" size="1"></div>
<div class="f"><input data-fixture="t4" size="10" type="email"></div>
<div class="f"><textarea data-fixture="a1"></textarea></div>
<div class="f"><textarea data-fixture="a2" cols="10" rows="3"></textarea></div>
<div class="f"><input data-fixture="g1" type="range"></div>
<div class="f"><input data-fixture="b1" type="submit"></div>
<div class="f"><input data-fixture="b2" type="button" value="Go"></div>
<div class="f"><input data-fixture="b3" type="reset"></div>
<div class="row"><select data-fixture="s9"><option>Short</option><option>A longer option</option></select><span>after</span></div>
<ul class="nav"><li data-fixture="li1"><select class="pct"><option>English</option><option>Español</option></select></li><li>Next</li></ul>
<div class="f"><select data-fixture="s1"><option>English</option><option>Español</option></select></div>`,
    `.f { margin: 0 0 4px }
select, input, textarea { font: inherit }
.n { appearance: none }
.row { display: flex; gap: 6px; align-items: center }
.nav { display: flex; list-style: none; margin: 0; padding: 0; gap: 4px }
.pct { width: 100%; appearance: none; padding: 4px 32px 4px 8px; border: 1px solid #999; line-height: 1.5 }`,
    [600],
  );
  it("reads a text field's character widths from the font", () => {
    const v = metricsFor("Inter")!.vertical(16, 400)!;
    expect([v.avgChar, v.maxChar]).toEqual([10, 44]);
  });
  it("sizes each control as Chromium does", () => {
    expect(geo(r.box("s2"))).toEqual([0, 0, 62, 26]);
    expect(geo(r.box("f-2"))).toEqual([0, 30, 600, 24]);
    expect([geo(r.box("t1")), geo(r.box("t2")), geo(r.box("t4"))]).toEqual([[0, 58, 242, 30], [0, 92, 52, 30], [0, 126, 142, 30]]);
    expect([geo(r.box("a1")), geo(r.box("f-6")), geo(r.box("a2")), geo(r.box("f-7"))]).toEqual([[0, 160, 221, 54], [0, 160, 600, 60], [0, 224, 121, 78], [0, 224, 600, 84]]);
    expect(geo(r.box("g1"))).toEqual([2, 314, 129, 16]);
    expect([geo(r.box("b1")), geo(r.box("b2")), geo(r.box("b3"))]).toEqual([[0, 340, 68.656, 26], [0, 370, 37.531, 26], [0, 400, 58.406, 26]]);
    expect([geo(r.box("s9")), geo(r.box("li1"))]).toEqual([[0, 430, 138, 24], [0, 454, 102, 34]]);
    for (const id of ["s2", "f-2", "t1", "t2", "t4", "a1", "a2", "g1", "b1", "b2", "b3", "s9", "li1"]) expect(r.approx(id)).toBeUndefined();
  });
  it("leaves a native select's place on its line approximate (its baseline sits half a pixel off at some sizes)", () => {
    expect(r.approx("s1")).toBeDefined();
  });
});

describe("a button with a set height", () => {
  it("centers its text, never above its content box", () => {
    const r = run(
      `<div class="l"><button data-fixture="b1" style="height: 60px">Go</button></div>
<div class="l"><button data-fixture="b4" style="height: 20px">Go</button></div>`,
      `.l { margin: 0 0 30px; line-height: 80px } button { font: inherit; line-height: 1.5 }`,
      [400],
    );
    // Baselines 36px and 21px below their tops (Chromium), on 80px lines whose strut puts the baseline 46px down.
    expect([r.box("b1").y, r.box("b4").y]).toEqual([46 - 36, 110 + 46 - 21]);
    expect(r.exact()).toBe(true);
  });
});
