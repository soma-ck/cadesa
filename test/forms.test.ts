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
input[type=submit], input[type=button], input[type=reset] { line-height: normal }
.n { appearance: none }
.row { display: flex; gap: 6px; align-items: center }
.nav { display: flex; list-style: none; margin: 0; padding: 0; gap: 4px }
.pct { width: 100%; appearance: none; padding: 4px 32px 4px 8px; border: 1px solid #999; line-height: 1.5 }`,
    [600],
  );
  it("reads a text field's character widths from the font", () => {
    const v = metricsFor("Inter")!.vertical(16, 400)!;
    expect([v.avgChar, v.maxChar]).toEqual([9.765625, 44.453125]);
  });
  it("sizes text fields and textareas from them at every font size as Chromium does", () => {
    // Widths Chromium gives <input size=1>, <input size=10> and <textarea cols=10> with no padding or border.
    const chromium: [number, number, number, number][] = [[12, 33, 99, 89], [13, 36, 108, 95], [14, 39, 120, 105], [15, 42, 125, 107], [16, 44, 134, 115], [17, 47, 141, 119], [18, 50, 149, 125], [19, 53, 161, 135], [20, 56, 166, 138], [21, 58, 175, 145], [22, 61, 182, 150], [23, 64, 191, 156], [24, 67, 202, 165], [28, 78, 232, 186], [32, 89, 269, 215], [15.5, 43, 129, 110], [17.6, 49, 148, 125]];
    const body = chromium.map(([s]) => `<div><input data-fixture="a${String(s).replace(".", "_")}" size="1" style="font-size: ${s}px"></div><div><input data-fixture="b${String(s).replace(".", "_")}" size="10" style="font-size: ${s}px"></div><div><textarea data-fixture="c${String(s).replace(".", "_")}" cols="10" style="font-size: ${s}px"></textarea></div>`).join("");
    const q = run(body, `input, textarea { font: inherit; padding: 0; border: 0 }`, [800]);
    const id = (p: string, s: number) => `${p}${String(s).replace(".", "_")}`;
    expect(chromium.map(([s]) => [s, q.box(id("a", s)).w, q.box(id("b", s)).w, q.box(id("c", s)).w])).toEqual(chromium);
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
  it("places a native select on its line (its line centered on one of line-height: normal)", () => {
    expect(r.approx("s1")).toBeUndefined();
  });
});

describe("native selects on lines of text", () => {
  const body = `<div data-fixture="d"><select data-fixture="s1"><option>English</option><option>Español</option></select></div>
<p data-fixture="p">Sail on <select><option>Monday</option></select> with the pilot.</p>
<p data-fixture="q" class="t">Moor at <select class="pad"><option>the quay</option></select> after.</p>`;
  const css = `select { font: inherit } p { margin: 0 } .t { line-height: 1.15 } .pad { padding: 3px 5px; border: 2px solid #889 }`;
  it("sit on their line: 1px inside their padding box, their font's ascent and half its line gap down", () => {
    const r = run(body, css, [600]);
    // Chromium, with the font installed (or loaded before the selects are laid out).
    expect([r.box("d").h, r.box("s1").y, r.box("p").h, r.box("q").h]).toEqual([24, 0, 24, 32]);
    for (const id of ["d", "s1", "p", "q"]) expect(r.approx(id)).toBeUndefined();
  });
  it("stay approximate in a web font: laid out before it loads, Chromium keeps a baseline half a pixel off", () => {
    const r = run(body, css, [600], { head: `<style>@font-face { font-family: "Inter"; src: url(Inter.woff2) }</style>` });
    expect(r.approx("d")).toMatch(/web font/);
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

describe("date inputs (en-US)", () => {
  it("sizes a date input from its fields' widest values and its picker, and its line", () => {
    const css = `input { font: 16px Inter } .wide { box-sizing: border-box; width: 100%; padding: 6px 12px; border: 1px solid #999; font: 20px/1.25 Inter }`;
    const r = run(`<div class="a"><input data-fixture="d" type="date"></div><div class="b"><input data-fixture="wide" class="wide" type="date"></div>`, css, [400]);
    // Measured in Chromium: 148×26 (its fields 116px + 7px, its picker 20px, padding 1px at the start, a 2px border).
    expect(geo(r.box("d"))).toEqual([0, 0, 148, 26]);
    expect(r.approx("d")).toBeUndefined();
    // A line of 25px (and the fields' 1px padding) over the picker's 24px, its padding and border.
    expect(r.box("wide").h).toBe(41);
    expect(r.approx("wide")).toBeUndefined();
  });

  it("leaves a date input whose inner parts the page styles approximate", () => {
    const r = run(`<div class="a"><input data-fixture="d" type="date"></div>`, `input { font: 16px Inter } ::-webkit-datetime-edit { padding: 0 }`, [400]);
    expect(r.approx("d")).toBeDefined();
  });
});
