/**
 * grid-auto-flow: column (and column dense), subgrid columns, and 3D transforms under a parent's
 * perspective, each box where getBoundingClientRect() reports it. Expected values measured in
 * Chromium; conformance:css checks fixtures/css/flow.html.
 */
import { describe, expect, it } from "vitest";
import { run } from "./lift-page.js";

const css = `body { margin: 0; font: 16px/1.5 Inter; color: #111111; background: #ffffff }
.col { display: grid; grid-auto-flow: column; grid-template-rows: auto auto; grid-auto-columns: 100px; gap: 4px }
.dense { display: grid; grid-auto-flow: column dense; grid-template-rows: 30px 30px; grid-auto-columns: 50px }
.two { grid-row: span 2 }
.led { display: grid; grid-template-columns: auto 1fr auto; column-gap: 10px }
.row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid }
.p3 { display: flex; gap: 20px; perspective: 400px; padding: 20px }
.p3 > div { width: 100px; height: 60px }
.rx { transform: rotateX(40deg) } .ry { transform: rotateY(-30deg); transform-origin: left center } .tz { transform: translateZ(50px) }`;

const html = `<div class="col" data-fixture="col"><div data-fixture="c1">a</div><div>b</div><div data-fixture="c3">c</div></div>
<div class="dense" data-fixture="dense"><div class="two">x</div><div>y</div><div class="two" data-fixture="d3">z</div><div data-fixture="d4">w</div></div>
<div class="led" data-fixture="led"><div class="row"><span data-fixture="a1">12 May</span><span>Mended nets</span><span data-fixture="a3">4.20</span></div><div class="row"><span>13 May</span><span data-fixture="b2">Hull paint, two coats</span><span>18.00</span></div></div>
<div class="p3" data-fixture="p3"><div class="rx" data-fixture="rx"></div><div class="ry" data-fixture="ry"></div><div class="tz" data-fixture="tz"></div></div>`;

describe("column flow, subgrids and 3D transforms", () => {
  const r = run(html, css, [600], { bare: true });
  const geo = (id: string) => [r.box(id).x, r.box(id).y, r.box(id).w, r.box(id).h].map((n) => +n.toFixed(3));
  it("fills columns with grid-auto-flow: column, and holes with column dense", () => {
    expect([geo("col"), geo("c1"), geo("c3")]).toEqual([[0, 0, 600, 52], [0, 0, 100, 24], [104, 0, 100, 24]]);
    expect([geo("dense"), geo("d3"), geo("d4")]).toEqual([[0, 52, 600, 60], [100, 52, 50, 60], [50, 82, 50, 30]]);
    for (const id of ["col", "c1", "c3", "dense", "d3", "d4"]) expect(r.approx(id)).toBeUndefined();
  });
  it("sizes a subgrid's columns with its parent's, from every row's items", () => {
    expect(geo("led")).toEqual([0, 112, 600, 48]);
    expect([geo("a1"), geo("a3"), geo("b2")].map((g) => g.map((n) => +n.toFixed(2)))).toEqual([[0, 112, 53.09, 24], [559.56, 112, 40.44, 24], [63.09, 136, 486.47, 24]]);
    for (const id of ["led", "a1", "a3", "b2"]) expect(r.approx(id)).toBeUndefined();
  });
  it("projects 3D transforms from the parent's perspective, as getBoundingClientRect() reports them", () => {
    const close = (id: string, want: number[]) => geo(id).forEach((v, i) => expect(v).toBeCloseTo(want[i], 2));
    close("rx", [5.8177, 188.0756, 122.4608, 46.0697]);
    close("ry", [140, 175.7143, 76.1172, 68.5714]);
    close("tz", [254.2857, 175.7143, 114.2857, 68.5714]);
    for (const id of ["p3", "rx", "ry", "tz"]) expect(r.approx(id)).toBeUndefined();
  });
});
