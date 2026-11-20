/**
 * Inline-blocks with content of their own on shared lines, vertical-align: top and bottom, boxes
 * aligned by their extent that are never split across lines, and an inline element made a flex item.
 * Expected values measured in Chromium; conformance:css checks fixtures/css/atoms.html.
 */
import { describe, expect, it } from "vitest";
import { run } from "./lift-page.js";

const css = `body { margin: 0; font: 16px/1.5 Inter; color: #111111; background: #ffffff }
p, div { margin: 0 }
.chip { display: inline-block; height: 34px; padding: 0 8px; line-height: 34px; font-size: 13px; vertical-align: top }
.low { vertical-align: bottom; height: 44px }
.stop { display: inline-block; padding: 4px 8px; border: 1px solid #ccc; line-height: 1.25 }
.small { font-size: 13px }
.tile { display: inline-block; width: 150px; padding: 8px; border: 1px solid #ccc; font-size: 14px }
.row { display: flex; align-items: center }
.unit { display: block; font-size: 12px }
.mid { vertical-align: middle }
.big { font-size: 28px }`;

const html = `<p data-fixture="a">Drivers <span class="chip">top</span> and <span class="chip low">bottom</span> sign.</p>
<p data-fixture="b">Next <span class="stop"><b>Mill Lane</b><br><span class="small">09:40, 12 parcels</span></span> then on.</p>
<div data-fixture="c"><span class="tile">North<br>6 vans</span> <span class="tile">South<br>4 vans<br>2 bikes</span> <span class="tile">Harbor</span></div>
<div class="row" data-fixture="d"><div>Plan</div><span data-fixture="e">60<small class="unit">min / day</small></span></div>
<p data-fixture="f">Signals <span class="mid">a<span class="big">B</span>c</span> on the mast.</p>`;

describe("atomic inlines and runs on shared lines", () => {
  const r = run(html, css, [600], { bare: true });
  const geo = (id: string) => [r.box(id).y, r.box(id).h].map((n) => +n.toFixed(3));
  it("grows the line box below a top-aligned box and above a bottom-aligned one", () => {
    expect(geo("a")).toEqual([0, 44]);
    expect(r.approx("a")).toBeUndefined();
  });
  it("measures an inline-block of several lines of runs on a line of text: its baseline is its last line's", () => {
    expect(geo("b")).toEqual([44, 50]);
    expect(r.approx("b")).toBeUndefined();
  });
  it("aligns inline-blocks of different line counts on their last baselines", () => {
    expect(geo("c")).toEqual([94, 81]);
    expect(r.approx("c")).toBeUndefined();
  });
  it("blockifies an inline element made a flex item, holding text and a block", () => {
    expect(geo("d")).toEqual([175, 42]);
    expect(+r.box("e").w.toFixed(3)).toBe(52.25);
    expect(r.approx("e")).toBeUndefined();
  });
  it("places a middle-aligned box by its whole extent when it can't be split across lines", () => {
    expect(geo("f")).toEqual([217, 42]);
    expect(r.approx("f")).toBeUndefined();
  });
});

describe("an inline svg or image alone on its line (fixtures/css/icons.html)", () => {
  const r = run(
    `<div class="stage"><div class="pointer" data-fixture="pointer"><svg class="arrow" data-fixture="arrow" viewBox="0 0 25 31"><path d="M2 2l20 14z"/></svg></div></div><div class="avatar" data-fixture="avatar"><img data-fixture="img" src="x.png" alt=""></div><div class="seal" data-fixture="seal"><svg class="arrow" data-fixture="seal-icon"></svg></div>`,
    `.stage { position: relative; height: 48px } .pointer { position: absolute; top: 6px; left: 12px; width: 27px; height: 34px } .arrow { position: relative; width: 25px; height: 31px } img { width: 20px; height: 20px }`,
  );
  const rect = (id: string) => [r.box(id).x, r.box(id).y, r.box(id).w, r.box(id).h];

  it("sits at the top of its line in a box of set height when it reaches above the strut", () => {
    expect(rect("arrow")).toEqual([12, 6, 25, 31]);
    expect(r.approx("arrow")).toBeUndefined();
    expect(r.approx("pointer")).toBeUndefined();
  });

  it("makes its parent as tall as its line box", () => {
    expect(rect("avatar")).toEqual([0, 48, 400, 26]);
    expect(rect("img")).toEqual([0, 48, 20, 20]);
    expect(r.box("seal").h).toBe(37);
    for (const id of ["avatar", "img", "seal", "seal-icon"]) expect(r.approx(id)).toBeUndefined();
  });
});
