/**
 * Inline runs in another size, font, line height or vertical-align, atomic inlines taller than the
 * line, and flex rows aligned on their baselines. Every number is what Chromium lays out
 * (conformance:css checks the same constructs at every width in fixtures/css/runs.html).
 */
import { describe, expect, it } from "vitest";
import { run } from "./lift-page.js";

const ROBOTO = `@font-face { font-family: "Roboto"; font-weight: 100 900; src: url("fixtures/fonts/fonts/roboto/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBA.woff2") format("woff2"); }`;

describe("a line box is the union of its inline boxes around the baseline", () => {
  const r = run(
    `<p data-fixture="a">Plain line of text</p>
<p data-fixture="b">Text with <small>small run</small> inside</p>
<p data-fixture="c">Text with <sup>sup</sup> inside</p>
<p data-fixture="d">Text with <sub>sub</sub> inside</p>
<p data-fixture="e">Text with <span style="font-size: 24px">big</span> inside</p>
<p data-fixture="f" style="line-height: 1">Text with <span style="font-size: 24px">big</span> inside</p>
<p data-fixture="g" style="line-height: 1">Text with <sup>sup</sup> inside</p>
<p data-fixture="i" style="line-height: normal">Text with <span style="font-size: 24px">big</span> inside</p>
<p data-fixture="j">x <span style="vertical-align: middle">mid</span> y</p>
<p data-fixture="k">x <span style="vertical-align: -50%">neg</span> y</p>
<p data-fixture="m">x <span style="vertical-align: text-top; font-size: 30px">tt</span> y</p>
<p data-fixture="n">x <span style="vertical-align: text-bottom; font-size: 30px">tb</span> y</p>
<p data-fixture="o">x <span style="vertical-align: 50%; font-size: 30px">tb</span> y</p>
<p data-fixture="q">x <span style="vertical-align: -0.3em; font-size: 30px">tb</span> y</p>
<p data-fixture="l">x <span style="vertical-align: middle">the <strong style="vertical-align: -50%">nest</strong> y</span></p>`,
    `p { margin: 0 }`,
    [800],
  );
  it("sizes each line from the fonts' vertical metrics and each box's vertical-align", () => {
    const h = (id: string) => +r.box(id).h.toFixed(4);
    expect(["a", "b", "c", "d", "e", "f", "g", "i"].map(h)).toEqual([24, 24, 26.3281, 28.1719, 36, 24, 19.3281, 29]);
    expect(["j", "k", "m", "n", "o", "q"].map(h)).toEqual([25.625, 36, 47, 47, 61.5, 45]);
    // A middle-aligned box whose child reaches past its strut: its extent (and so its shift) may differ from line to line.
    expect(r.approx("l")).toMatch(/inline runs in another style/);
    expect(["a", "b", "c", "d", "e", "f", "g", "i", "j", "k", "m", "n", "o", "q"].every((id) => !r.approx(id))).toBe(true);
  });
});

describe("text in another font and size", () => {
  it("measures each run in its own font, and keeps an inner run's size inside an outer one", () => {
    const r = run(
      `<ul><li data-fixture="a">every <sup class="r"> <a href="#" class="big"> <span>the field notes quickly</span> May the</a> </sup></li></ul>`,
      `${ROBOTO} ul { margin: 0 } li { width: 162px } .r { font-family: Roboto; line-height: 30px; vertical-align: sub } .big { font-size: 18px; line-height: 1.75em }`,
      [300],
    );
    // Two lines, "every the field notes" and "quickly May the", each as tall as the raised 18px run.
    expect(+r.box("a").h.toFixed(3)).toBe(66.375);
    expect(r.exact()).toBe(true);
  });

  it("keeps a space before an inline box's end in that box", () => {
    const r = run(`<div class="r"><div data-fixture="a" class="big">hand a <strong class="s">with the <span>08:00 hand</span> </strong> along</div></div>`, `.r { display: flex } .big { font-size: 36px } .s { font-size: 18px }`, [900]);
    expect(+r.box("a").w.toFixed(3)).toBe(401.172);
  });
});

describe("atomic inlines taller than the line", () => {
  const r = run(
    `<p data-fixture="a">the field <span class="a1"></span> notes</p>
<p data-fixture="b">the field <span class="a2"></span> notes</p>
<p data-fixture="c">the field <span class="a3"></span> notes</p>
<p data-fixture="d">the field <span class="a4"></span> notes</p>
<p data-fixture="e">the field <span class="a5"></span> notes</p>`,
    `p { margin: 0 } .a1, .a2, .a3, .a4, .a5 { display: inline-block; width: 20px; height: 40px } .a1 { height: 10px }
.a3 { vertical-align: middle } .a4 { vertical-align: -4px; margin: 3px 2px } .a5 { vertical-align: text-top }`,
    [600],
  );
  it("grows the line box around them", () => {
    expect(["a", "b", "c", "d", "e"].map((id) => r.box(id).h)).toEqual([24, 46, 40, 48, 42]);
    expect(r.exact()).toBe(true);
  });
});

describe("align-items: baseline", () => {
  const r = run(
    `<div class="row" data-fixture="r1"><div class="big" data-fixture="a">Big title</div><div class="sm" data-fixture="b">small note</div><div class="pad" data-fixture="c">padded</div></div>
<div class="row wrap" data-fixture="r2"><div class="big">Big title here</div><div class="sm">small note that wraps along</div><div class="pad">padded item</div><div class="nest" data-fixture="n"><p class="np">nested first line</p><p>second</p></div></div>
<div class="row" data-fixture="r3"><div class="empty" data-fixture="e"></div><div class="sm">text</div><div class="big" data-fixture="f">Big</div></div>
<div class="row" data-fixture="r4"><div class="sm" data-fixture="g">a <span class="sup">tall</span> run</div><div class="big" data-fixture="h">Big</div></div>`,
    `${ROBOTO} p { margin: 0 }
.row { display: flex; align-items: baseline; gap: 8px; border: 1px solid #ccc; margin-bottom: 6px }
.wrap { flex-wrap: wrap }
.big { font-size: 28px; line-height: 1.2; font-family: Roboto }
.sm { font-size: 12px; padding-top: 7px; margin-top: 3px }
.pad { padding: 10px 4px; border: 2px solid #999 }
.nest { padding-top: 5px }
.np { font-size: 20px }
.empty { width: 20px; height: 30px; margin-bottom: 4px }
.sup { font-size: 22px; vertical-align: super }`,
    [600, 300],
  );
  it("puts the items' first baselines on one line, and sizes the line around them", () => {
    const g = (id: string, w: number) => [r.box(id, w).y, r.box(id, w).h].map((n) => +n.toFixed(3));
    expect([g("r1", 600), g("a", 600), g("b", 600), g("c", 600)]).toEqual([[0, 50], [5, 33.594], [11, 25], [1, 48]]);
    expect(g("r2", 300)).toEqual([56, 158.594]);
    expect(g("n", 300)).toEqual([154.594, 59]);
    expect([g("e", 600), g("f", 600)]).toEqual([[127, 30], [131, 33.594]]);
    // A first line made taller by a raised run: its baseline is lower.
    expect([g("g", 600), g("h", 600)]).toEqual([[175.594, 41], [185.594, 33.594]]);
    expect(r.exact(600) && r.exact(300)).toBe(true);
  });
});
