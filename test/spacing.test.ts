/**
 * Percentage padding and margins, auto top and bottom margins, and columns that don't stretch
 * their items. Every number is what Chromium lays out (conformance:css checks the same cases at
 * every width in fixtures/css/spacing.html).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run } from "./lift-page.js";

const geo = (b: { x: number; y: number; w: number; h: number }) => [b.x, b.y, b.w, b.h].map((n) => +n.toFixed(4));

const CSS = `
* { box-sizing: border-box }
p { margin: 0 }
.pad { padding: 5% 10%; }
.m { margin: 0 auto 4%; width: 50%; }
.col { display: flex; flex-direction: column; height: 300px; }
.push { margin-top: auto; }
.mid { margin: auto 0; }
.row { display: flex; height: 100px; }
.lo { margin-top: auto; }
.cen { display: flex; flex-direction: column; align-items: center; }
.end { display: flex; flex-direction: column; align-items: flex-end; }
`;
const HTML = `
<div data-fixture="pad" class="pad"><p data-fixture="pad-text">Some words in a padded box</p></div>
<div data-fixture="m" class="m">Half</div>
<div data-fixture="col" class="col"><div data-fixture="c1">Top</div><div data-fixture="c2" class="mid">Middle</div><div data-fixture="c3" class="push">Bottom</div></div>
<div data-fixture="row" class="row"><div data-fixture="r1">One</div><div data-fixture="r2" class="lo">Two</div><div data-fixture="r3" class="mid">Three</div></div>
<div data-fixture="cen" class="cen"><div data-fixture="cen1">Short</div><p data-fixture="cen2">A longer paragraph of text that wraps onto a second line at this width, centered.</p></div>
<div data-fixture="end" class="end"><div data-fixture="end1">Right</div></div>
`;

describe("percentages and auto margins", () => {
  const r = run(HTML, CSS, [400]);

  it("lays the page out exactly", () => expect(r.exact()).toBe(true));

  it("resolves percentage padding and margins against the containing block's width, on every side", () => {
    // 5% of 400 on top and bottom too, not of a height.
    expect(geo(r.box("pad"))).toEqual([0, 0, 400, 64]);
    expect(geo(r.box("pad-text"))).toEqual([40, 20, 320, 24]);
    // margin: 0 auto 4%: centered, and 16px below.
    expect(geo(r.box("m"))).toEqual([100, 64, 200, 24]);
    expect(r.box("col").y).toBe(104);
  });

  it("gives a column's free space to auto top and bottom margins", () => {
    expect(geo(r.box("c1"))).toEqual([0, 104, 400, 24]);
    expect(geo(r.box("c2"))).toEqual([0, 204, 400, 24]);
    expect(geo(r.box("c3"))).toEqual([0, 380, 400, 24]);
  });

  it("aligns a flex row's item by its auto margins, and doesn't stretch it", () => {
    expect(geo(r.box("r1"))).toEqual([0, 404, 31.0156, 100]);
    expect(geo(r.box("r2"))).toEqual([31.0156, 480, 31.7344, 24]);
    expect(geo(r.box("r3"))).toEqual([62.75, 442, 44.2031, 24]);
  });

  it("sizes the items of a centered or end-aligned column to fit their content", () => {
    expect(geo(r.box("cen1"))).toEqual([179.5781, 504, 40.8281, 24]);
    expect(geo(r.box("cen2"))).toEqual([0, 528, 400, 48]);
    expect(geo(r.box("end1"))).toEqual([361.3125, 576, 38.6875, 24]);
  });
});

describe("a collapsed table sized to its content", () => {
  it("counts its collapsed border once (it isn't percentage padding)", () => {
    const r = run(
      `<table data-fixture="t" class="t"><tr><th width="133" nowrap>in yard order</th></tr><tr><td>12 supply</td></tr></table>`,
      `.t { border-collapse: collapse; min-width: 577px; border-bottom: 1px solid #555 } .t td, .t th { padding: 2px 3px; border-bottom: 2px solid #ccc }`,
    );
    // Chromium: 577px, its min-width (the collapsed border is inside it).
    expect(r.box("t").w).toBe(577);
  });
});

describe("the spacing fixture", () => {
  const html = readFileSync("fixtures/css/spacing.html", "utf8").replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, "");
  const r = run(html, readFileSync("fixtures/css/spacing.css", "utf8"), [360, 1200], { bare: true });
  it("is exact at every width", () => {
    expect(r.exact(360)).toBe(true);
    expect(r.exact(1200)).toBe(true);
  });
});
