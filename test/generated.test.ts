/**
 * Generated content (::before / ::after), inline runs in another weight or with edges of their own,
 * and percentage gaps. Every number is what Chromium lays out (conformance:css checks the same
 * cases at every width in fixtures/css/generated.html).
 */
import { describe, expect, it } from "vitest";
import { layoutText, metricsFor } from "../src/engine/text.js";
import { contentText } from "../src/lift/page.js";
import { run } from "./lift-page.js";

const geo = (b: { x: number; y: number; w: number; h: number }) => [b.x, b.y, b.w, b.h].map((n) => +n.toFixed(3));
/** The page loads Inter's upright face only: its italic is the upright one slanted. */
const INTER = `<style>@font-face { font-family: "Inter"; font-weight: 100 900; src: url("inter.woff2") format("woff2") }</style>`;

describe("::before and ::after", () => {
  const body = `<ol class="bc"><li class="it">Home</li><li class="it"><a href="#">Projects and other long things</a></li></ol>
<div class="cf"><p class="p">Kept inside</p></div>
<div class="cfb"><p class="p">Let through</p></div>
<div class="chip"><span class="lbl">Status</span></div>
<div class="grid"><span class="g">A</span><span class="g">B</span><span class="g">C</span></div>
<div class="card"><p class="txt">Decorated</p></div>`;
  const css = `p { margin: 0 }
.bc { display: flex; flex-wrap: wrap; padding: 0; margin: 0; list-style: none }
.it + .it { padding-left: 8px }
.it + .it::before { float: left; padding-right: 8px; content: var(--divider, "/") }
.cf::after { content: ""; display: table; clear: both }
.cfb::after { content: ""; display: block; clear: both }
.p { margin-bottom: 10px }
.chip { display: flex; align-items: center; gap: 6px }
.chip::before { content: ""; display: block; width: 10px; height: 10px }
.grid { display: grid; grid-template-columns: 1fr 1fr }
.grid::before { content: ""; display: block; height: 20px }
.card { position: relative }
.card::before { content: ""; position: absolute; inset: 0; border: 2px solid red }`;
  const r = run(body, css, [200]);

  it("lays out the page exactly", () => expect(r.exact()).toBe(true));

  it("floats a breadcrumb divider to the start of the item's first line", () => {
    expect(geo(r.box("it"))).toEqual([0, 0, 44.828, 24]);
    // "/" and its padding shorten the first line only: the link wraps onto a second, full-width line.
    expect(geo(r.box("it-2"))).toEqual([0, 24, 200, 48]);
  });

  it("an empty table (the clearfix) keeps the last child's margin inside; an empty block lets it through", () => {
    expect(geo(r.box("cf"))).toEqual([0, 72, 200, 34]);
    expect(geo(r.box("cfb"))).toEqual([0, 106, 200, 24]);
  });

  it("a fixed-size ::before is a flex item, and a grid's first cell", () => {
    expect(geo(r.box("lbl"))).toEqual([16, 140, 47.703, 24]);
    expect(geo(r.box("g"))).toEqual([100, 164, 100, 24]);
    expect(geo(r.box("g-2"))).toEqual([0, 188, 100, 24]);
  });

  it("an absolutely positioned ::before moves nothing", () => {
    expect(r.approx("card")).toBeUndefined();
    expect(r.approx("txt")).toBeUndefined();
  });

  it("text in an icon font (no metrics) stays ≈", () => {
    const r2 = run(`<p class="icon"><span class="ic"></span>With an icon</p>`, `.icon { margin: 0 } .ic::before { content: "\\f101"; font-family: "icons"; margin-right: 4px }`);
    expect(r2.approx("icon")).toMatch(/::before \(font-family\): inline runs in another style aren.t measured/);
  });

  it("content Cadesa can't read (a counter) stays ≈", () => {
    const r2 = run(`<p class="n">Step</p>`, `.n { margin: 0 } .n::before { content: counter(step) ". " }`);
    expect(r2.approx("n")).toMatch(/content other than text/);
  });

  it("reads content strings with escapes and alternative text", () => {
    expect(contentText(`"\\2022"`)).toBe("\u2022");
    expect(contentText(`"\\f101" / ""`)).toBe("\uf101");
    expect(contentText(`"a" "b"`)).toBe("ab");
    expect(contentText(`none`)).toBeUndefined();
    expect(contentText(`counter(x)`)).toEqual({ unknown: "counter(x)" });
  });
});

describe("inline runs in another weight, and inline boxes with edges", () => {
  const css = `p { margin: 0 }
.fit { display: flex; align-items: flex-start }
.semi { font-weight: 600 }
.x + .x::before { content: "\\2022"; padding: 0 6px }
.pill { padding: 1px 6px; border: 1px solid #999 }
.pad { padding: 0 6px }`;

  it("measures bold, semibold and synthetic italic runs, bullets and padded inline boxes", () => {
    const r = run(
      `<div class="fit"><p class="m"><span class="x">One</span><span class="x">Two</span></p><p class="t">Orders <span class="pill">12 open</span></p><p class="b">Plain <strong>Bold</strong> <span class="semi">Semi</span></p><p class="i">Some <em>italic</em></p></div>`,
      css,
      [600],
      { head: INTER },
    );
    expect(r.exact()).toBe(true);
    expect([r.box("m"), r.box("t"), r.box("b"), r.box("i")].map((b) => +b.w.toFixed(3))).toEqual([83.75, 129.031, 118.703, 82.766]);
  });

  it("padding between two runs stops the kerning across them", () => {
    const r = run(`<div class="fit"><p class="a">One<span class="pad">Two</span></p><p class="a">One<span class="pad"></span>Two</p></div>`, css, [600]);
    expect([r.box("a"), r.box("a-2")].map((b) => +b.w.toFixed(3))).toEqual([74.75, 74.75]);
  });

  it("breaks lines across runs of different weights as Chromium does", () => {
    const r = run(`<p class="b">A paragraph with <strong>bold words in it</strong> and <span class="semi">semibold ones</span> that wraps.</p>`, css, [200]);
    expect(r.approx("b")).toBeUndefined();
    expect(r.box("b").lines!.length).toBe(3);
  });

  it("italic stays ≈ when the page loads an italic face", () => {
    const head = `<style>@font-face { font-family: "Inter"; src: url("a.woff2") } @font-face { font-family: "Inter"; font-style: italic; src: url("b.woff2") }</style>`;
    expect(run(`<p class="i">Some <em>italic</em></p>`, `p { margin: 0 }`, [400], { head }).approx("i")).toMatch(/is italic/);
  });

  it("layoutText: a span's weight and edges", () => {
    const m = metricsFor("Inter")!;
    const plain = layoutText(m, "One Two", 16, 400, Infinity).maxContent;
    const bold = layoutText(m, "One Two", 16, 400, Infinity, { items: [4], spans: [{ from: 4, to: 7, weight: 700 }] }).maxContent;
    expect(bold).toBeGreaterThan(plain);
    const padded = layoutText(m, "One Two", 16, 400, Infinity, { items: [4], spans: [{ from: 4, to: 7, open: 6, close: 6 }] }).maxContent;
    expect(padded).toBeCloseTo(Math.ceil(m.measure("One ", 16, 400)! * 64) / 64 + m.measure("Two", 16, 400)! + 12, 5);
  });
});

describe("percentage gaps", () => {
  it("a row's column gap is a share of its width; a row gap of an auto height is 0", () => {
    const r = run(
      `<div class="row"><p class="h">Left</p><p class="h">Right</p></div><div class="col"><p class="s">One</p><p class="s">Two</p></div>`,
      `p { margin: 0 } .row { display: flex; column-gap: 10% } .h { flex: 1 } .col { display: flex; flex-direction: column; row-gap: 10% }`,
      [200],
    );
    expect(r.exact()).toBe(true);
    expect(geo(r.box("h-2"))).toEqual([110, 0, 90, 24]);
    expect(geo(r.box("s-2"))).toEqual([0, 48, 200, 24]);
  });

  it("a grid's percentage gaps: of its width between columns, of its final height between rows", () => {
    const r = run(`<div class="grid"><p class="g">One</p><p class="g">Two</p><p class="g">Three</p></div>`, `p { margin: 0 } .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5% }`, [400]);
    expect(geo(r.box("g-2"))).toEqual([210, 0, 190, 24]);
    // Rows sized without the row gap (48px), then placed 5% of that apart.
    expect(r.exact()).toBe(true);
    expect(r.box("g-3").y).toBe(24 + 2.390625);
  });
});
