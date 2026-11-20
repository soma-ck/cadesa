/**
 * Patterns found by checking real pages against Chromium (fixtures/css/corpus.html keeps them);
 * the numbers here are Chromium's.
 */
import { describe, expect, it } from "vitest";
import { sizeUncertainty } from "../src/check.js";
import { run } from "./lift-page.js";

describe("an icon alone in a link that is a flex item", () => {
  const r = run(
    `<div class="bar"><a class="lnk" data-fixture="lnk" href="#"> <svg width="20" height="20" class="ic" data-fixture="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle></svg> </a><a class="pill" data-fixture="pill" href="#">Sign up</a></div><div class="bar2" data-fixture="bar2"><a data-fixture="lnk2" href="#"> <svg width="20" height="20" data-fixture="ic2" viewBox="0 0 24 24"></svg> </a></div><div class="bar2" data-fixture="bar3"><a data-fixture="lnk3" href="#"><svg width="16" height="16" class="low" data-fixture="ic3"></svg></a></div>`,
    `svg { vertical-align: middle } .bar { display: flex; justify-content: flex-end; align-items: center; line-height: 1; padding: 12px 0 } .ic { margin: 0 16px } .pill { display: inline-block; padding: 4px 8px; border: 1px solid #333 } .bar2 { display: flex } .low { vertical-align: -0.125em }`,
  );
  const rect = (id: string) => [r.box(id).x, r.box(id).y, r.box(id).w, r.box(id).h].map((v) => Math.round(v * 1000) / 1000);

  it("is a block of its one line, the icon aligned middle on it", () => {
    expect(rect("lnk")).toEqual([272.828, 15, 52, 20]);
    expect(rect("ic")).toEqual([288.828, 15, 20, 20]);
    for (const id of ["lnk", "ic", "pill"]) expect(r.approx(id)).toBeUndefined();
  });

  it("takes the line box's height when the strut reaches past the icon", () => {
    expect(rect("lnk2")).toEqual([0, 50, 20, 24]);
    expect(rect("ic2")).toEqual([0, 53.625, 20, 20]);
    expect(r.approx("ic2")).toBeUndefined();
  });

  it("is lowered by a vertical-align length", () => {
    expect(rect("lnk3")).toEqual([0, 74, 16, 24]);
    expect(rect("ic3")).toEqual([0, 78, 16, 16]);
    expect(r.approx("ic3")).toBeUndefined();
  });
});

describe("a caret drawn with borders in em", () => {
  const r = run(
    `<div class="menu"><button class="tog" data-fixture="tog"><svg class="g" viewBox="0 0 16 16"></svg></button></div>`,
    `.menu { display: flex; justify-content: flex-end } .tog { display: flex; align-items: center; padding: 8px 12px; font: inherit; border: 1px solid #333 } .g { width: 1em; height: 1em } .tog::after { display: inline-block; margin-left: .255em; vertical-align: .255em; content: ""; border-top: .3em solid; border-right: .3em solid transparent; border-bottom: 0; border-left: .3em solid transparent }`,
  );

  it("is as wide as its borders are drawn (4.8px is 4px)", () => {
    expect(Math.round(r.box("tog").w * 1000) / 1000).toBe(54.078);
    expect(r.approx("tog")).toBeUndefined();
  });
});

describe("properties that only paint inside an svg", () => {
  const r = run(`<svg class="art" data-fixture="art" width="100%" height="180"><text x="50%" y="50%">Thumbnail</text></svg>`, `.art { display: block; font-size: 18px; text-anchor: middle; dominant-baseline: middle }`);

  it("don't make the svg ≈", () => {
    expect(r.box("art").h).toBe(180);
    expect(r.approx("art")).toBeUndefined();
  });
});

describe("a box as wide as its content", () => {
  it("doesn't claim its width when something in it is ≈ (a fixed corner box, a button)", () => {
    const r = run(
      `<div class="corner" data-fixture="corner"><button class="tog" data-fixture="tog"><span class="g"></span></button></div>`,
      `.corner { position: fixed; bottom: 0; right: 0 } .tog { display: flex; padding: 8px } .g { width: 16px; height: 16px } .tog::after { display: inline-block; content: ""; border-top: .3ch solid }`,
    );
    const { width } = sizeUncertainty(r.layout(), r.impacts[0]);
    expect(r.approx("after")).toBeDefined();
    expect(width.has("tog")).toBe(true);
    expect(width.has("corner")).toBe(true);
  });
});

describe("CSS nesting", () => {
  const r = run(
    `<div class="card" data-fixture="card"><h2 class="title" data-fixture="title">Tides</h2><p class="lead" data-fixture="lead">Boats</p></div><div class="card wide" data-fixture="wide"><p>Nets</p></div>`,
    `.card { padding: 12px; & .title { margin: 0; font-size: 20px } p { margin: 0 } > .lead { padding-left: 16px } &.wide { padding: 24px } @media (min-width: 700px) { padding: 20px; .title { font-size: 28px } } }`,
    [400, 800],
  );

  it("applies nested rules, & and nested media queries", () => {
    expect(r.box("title", 400).h).toBe(30);
    expect(r.box("title", 800).h).toBe(42);
    expect(r.box("lead", 400).x).toBe(12);
    expect(r.box("card", 800).h).toBe(20 + 42 + 24 + 20);
    expect(r.box("wide", 800).h).toBe(24 + 24 + 24);
    for (const w of [400, 800]) expect(r.exact(w)).toBe(true);
  });
});

describe("media queries", () => {
  const r = run(
    `<div class="a" data-fixture="a">Tides</div><div class="b" data-fixture="b">Nets</div><div class="d" data-fixture="d">Dawn</div>`,
    `.a { padding: 4px } @media print, screen and (min-width: 700px) { .a { padding: 20px } } @media not all and (min-width: 700px) { .b { padding: 10px } } @media print { .d { padding: 30px } } @-moz-document url-prefix() { .d { padding: 40px } }`,
    [699, 700],
  );

  it("read a list with print as its screen query, and not all and (min-width) as its other side", () => {
    expect([r.box("a", 699).h, r.box("a", 700).h]).toEqual([32, 64]);
    expect([r.box("b", 699).h, r.box("b", 700).h]).toEqual([44, 24]);
    expect([r.box("d", 699).h, r.box("d", 700).h]).toEqual([24, 24]);
    for (const w of [699, 700]) expect(r.exact(w)).toBe(true);
  });
});

describe("logical properties", () => {
  it("are read as their physical ones", () => {
    const r = run(`<div class="a" data-fixture="a">Tides</div><div class="b" data-fixture="b">Nets</div>`, `div { box-sizing: border-box } .a { max-inline-size: 300px; margin-inline: auto } .b { inline-size: 50%; block-size: 40px; border-inline-start: 3px solid #333 }`);
    expect([r.box("a").x, r.box("a").w]).toEqual([50, 300]);
    expect([r.box("b").w, r.box("b").h]).toEqual([200, 40]);
    expect(r.exact()).toBe(true);
  });
});

describe("a flex item with a basis and no grow", () => {
  it("without an automatic minimum, is as wide as its basis, and shrinks by its factor in a full row", () => {
    const r = run(
      `<div class="row"><div class="s1" data-fixture="s1">alpha beta gamma</div><div class="s2" data-fixture="s2">delta epsilon</div><div class="s3" data-fixture="s3">zeta</div></div><div class="row"><div class="c" data-fixture="c">one</div></div>`,
      `.row { display: flex } .row > div { min-width: 0 } .s1 { flex: 0 1 300px } .s2 { flex: 0 1 250px; overflow: hidden } .s3 { flex-basis: 50%; width: 10px } .c { flex: 0 0 33.333%; padding: 0 4px; box-sizing: border-box }`,
      [400, 1600],
    );
    expect([r.box("s1", 1600).w, r.box("s2", 1600).w, r.box("s3", 1600).w]).toEqual([300, 250, 800]);
    expect(r.box("s1", 400).w + r.box("s2", 400).w + r.box("s3", 400).w).toBeCloseTo(400, 5);
    expect(Math.round(r.box("c", 1600).w * 1000) / 1000).toBe(533.313);
    for (const w of [400, 1600]) expect(r.exact(w)).toBe(true);
  });
  it("with one, is ≈ where its content is wider than the basis (its min-content width wins)", () => {
    const r = run(`<div class="row"><div class="b" data-fixture="b">tidesandboatsatdawnalongtheridge</div></div>`, `.row { display: flex } .b { flex-basis: 25% }`);
    expect(r.approx("b")).toBeDefined();
  });
});

describe("a body that is a flex or grid container", () => {
  const r = run(
    `<header class="h" data-fixture="h">Notes</header><nav class="side" data-fixture="side">Tides</nav><main class="m" data-fixture="m"><p class="x">Harbor</p></main>`,
    `body { display: flex; flex-direction: column; align-items: center; margin: 8px } .h, .side, .m { padding: 8px } .x { margin: 0 } @media (min-width: 900px) { body { display: grid; grid-template-columns: 200px 1fr; column-gap: 16px; align-items: start; margin: 0 } .h { grid-column: 1 / 3 } }`,
    [400, 1000],
  );
  const rect = (id: string, w: number) => [r.box(id, w).x, r.box(id, w).y, r.box(id, w).w];

  it("is laid out as the one box on the page, its children in it", () => {
    const body = r.layout(400).boxes[0];
    expect(body.tag).toBe("body");
    expect([body.x, body.y, body.w, body.h]).toEqual([8, 8, 384, 120]);
    expect(rect("h", 1000)).toEqual([0, 0, 1000]);
    expect(rect("side", 1000)).toEqual([0, 40, 200]);
    expect(rect("m", 1000)[0]).toBe(216);
    for (const w of [400, 1000]) for (const id of ["h", "side", "m"]) expect(r.approx(id, w)).toBeUndefined();
  });
});

describe("a run in another size in text of a fractional size", () => {
  it("is ≈ (Chromium's line is a pixel taller than the metrics give)", () => {
    const r = run(`<p class="p" data-fixture="p">field <span class="s">and</span> the field</p>`, `html { font-size: 10pt } .p { margin: 0; font-size: 1.6rem; line-height: 20px } .s { font-size: 0.75em }`);
    expect(r.approx("p")).toBeDefined();
  });
});

describe("markup quoted in an attribute", () => {
  it("isn't a <style> of the page (a wiki's template data)", () => {
    const r = run(`<div data-mw="{&quot;html&quot;:&quot;<style> h1 { color: red; } </style>&quot;}" data-fixture="d"><p class="p" data-fixture="p">Notes</p></div><!-- <style> .p { padding: 40px } </style> -->`, `.p { margin: 0 }`);
    expect(r.box("p").h).toBe(24);
    expect(r.approx("p")).toBeUndefined();
  });
});

describe("line-height: 0", () => {
  it("is left ≈ (a chevron's ::before), not an error", () => {
    const r = run(`<button class="t" data-fixture="t">Guides</button>`, `.t { display: inline-flex; border: 0 } .t::before { width: 1.25em; line-height: 0; content: "›" }`);
    expect(r.approx("t")).toBeDefined();
  });
});

describe("a <button> with display: block or flex in block flow", () => {
  const r = run(
    `<div><button class="b1" data-fixture="b1">Save the field notes</button></div><div class="narrow"><button class="b1" data-fixture="b2">Save the field notes of the harbor town for everyone</button></div><div class="fixed" data-fixture="fixed"><button class="b3" data-fixture="b3"><svg class="g" viewBox="0 0 16 16"></svg></button></div>`,
    `button { font: inherit; padding: 6px 12px; border: 1px solid #333 } .b1 { display: block } .narrow { width: 150px } .fixed { position: fixed; bottom: 0; right: 0; margin: 0 16px 16px 0 } .b3 { display: flex; align-items: center } .g { width: 1em; height: 1em }`,
  );

  it("is as wide as its content, as an inline button is", () => {
    expect(r.box("b1").w).toBe(175.25);
    expect(r.box("b2").w).toBe(150);
    expect(r.box("b3").w).toBe(42);
    for (const id of ["b1", "b2", "b3", "fixed"]) expect(r.approx(id)).toBeUndefined();
  });
});

describe("a baseline-aligned row with an item that clips its overflow", () => {
  const r = run(
    `<div class="row"><div class="a" data-fixture="a">notes</div><div class="huge" data-fixture="huge">wind</div></div><div class="row"><div class="a" data-fixture="a2">notes</div><div class="tiny" data-fixture="tiny">tide</div></div>`,
    `body { line-height: 24px } .row { display: flex; align-items: baseline } .a { font-size: 14px } .huge { font-size: 60px; overflow: hidden } .tiny { font-size: 30px; line-height: 4px; overflow: hidden }`,
  );

  it("takes the item's baseline clamped to its border box", () => {
    // (Chromium: the label 7px below the 60px item's top; the 4px-tall item 13px below the label's.)
    expect(r.box("a").y - r.box("huge").y).toBe(7);
    expect(r.box("tiny").y - r.box("a2").y).toBe(13);
    for (const id of ["a", "huge", "a2", "tiny"]) expect(r.approx(id)).toBeUndefined();
  });
});

describe("order", () => {
  const css = `.row { display: flex; flex-wrap: wrap; gap: 12px } .c1 { width: 60% } .c2 { width: 30% } .c3 { width: 100% } @media (min-width: 768px) { .last { order: 5 } .c3 { width: 20% } } .first { order: -1 } .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px }`;
  const r = run(
    `<div class="row"><div class="c1" data-fixture="c1">Summary</div><div class="c2 last" data-fixture="c2">Cart</div><div class="c3" data-fixture="c3">Notes</div></div><div class="grid" data-fixture="grid"><div>one</div><div class="first" data-fixture="g2">two</div><div>three</div><div class="last" data-fixture="g4">four</div><div data-fixture="g5">five</div></div>`,
    css,
    [400, 900],
  );
  const at = (id: string, w: number) => [r.box(id, w).x, r.box(id, w).y - r.box(/^c/.test(id) ? "c1" : "grid", w).y].map((v) => Math.round(v * 1000) / 1000);

  it("places flex items by it, from the breakpoint that sets it", () => {
    expect(at("c2", 400)).toEqual([252, 0]);
    expect(at("c3", 900)).toEqual([552, 0]);
    expect(at("c2", 900)).toEqual([0, 36]);
  });

  it("auto-places grid items by it", () => {
    expect(at("g2", 400)).toEqual([0, 0]);
    expect(at("g4", 400)).toEqual([0, 28]);
    expect(at("g4", 900)).toEqual([301.328, 28]);
    expect(at("g5", 900)).toEqual([0, 28]);
    for (const w of [400, 900]) for (const id of ["c1", "c2", "c3", "g2", "g4"]) expect(r.approx(id, w)).toBeUndefined();
  });
});

describe("a box without offsets in a flexbox", () => {
  const r = run(
    `<div class="col" data-fixture="col"><div class="item">tide</div><span class="vh" data-fixture="vh">hidden</span></div><div class="row" data-fixture="row"><div class="item">tide</div><span class="vh" data-fixture="vh3">hidden</span></div><div class="row3" data-fixture="row3"><div class="item">tide</div><span class="dot" data-fixture="dot"></span></div>`,
    `.col { display: flex; flex-direction: column; align-items: center; height: 60px; position: relative } .row { display: flex; align-items: center; height: 50px; position: relative } .row3 { display: flex; align-items: flex-end; justify-content: flex-end; height: 50px; padding: 3px; position: relative } .item { width: 40px } .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; margin: -1px; padding: 0; border: 0 } .dot { position: absolute; width: 7px; height: 5px }`,
  );
  const rel = (id: string, p: string) => [r.box(id).x - r.box(p).x, r.box(id).y - r.box(p).y];

  it("sits where the sole item would (a visually hidden label's clip only paints)", () => {
    expect(rel("vh", "col")).toEqual([199.5, -1]);
    expect(rel("vh3", "row")).toEqual([-1, 24.5]);
    expect(rel("dot", "row3")).toEqual([390, 48]);
    for (const id of ["vh", "vh3", "dot"]) expect(r.approx(id)).toBeUndefined();
  });
});

describe("a box without offsets in a grid", () => {
  const r = run(
    `<div class="grid" data-fixture="grid"><div>one</div><span class="dot" data-fixture="dot"></span><div>two</div></div><div class="grid rel" data-fixture="grid2"><div>one</div><span class="dot" data-fixture="dot2"></span></div>`,
    `.grid { display: grid; grid-template-columns: repeat(2, 1fr); padding: 7px; border: 2px solid #333 } .rel { position: relative } .dot { position: absolute; width: 11px; height: 14px }`,
  );

  it("sits at the grid's content box corner, or its padding box corner when the grid contains it", () => {
    expect([r.box("dot").x - r.box("grid").x, r.box("dot").y - r.box("grid").y]).toEqual([9, 9]);
    expect([r.box("dot2").x - r.box("grid2").x, r.box("dot2").y - r.box("grid2").y]).toEqual([2, 2]);
    for (const id of ["dot", "dot2"]) expect(r.approx(id)).toBeUndefined();
  });
});
