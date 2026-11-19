/**
 * Ordinary CSS from real apps (CSS Modules, Bootstrap) that used to crash the lift, make whole pages
 * approximate, or report the wrong thing. Box numbers are checked against Chromium by
 * conformance:css (fixtures/css/common.html).
 */
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { tailwindImpact } from "../src/commands.js";
import { walk, type Box, type Layout } from "../src/engine/layout.js";
import { liftCssPage } from "../src/lift/css-page.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";

const FONT = `body { margin: 0; font: 16px/1.5 Inter, sans-serif; color: #111111; background: #ffffff }`;

/** Lift `body` with `css` (after a zero-margin Inter body unless `bare`), lay it out and check it. */
export function run(body: string, css: string, widths = [400], opts: { bare?: boolean; head?: string } = {}) {
  const t = liftCssPage("t.html", `<!doctype html><html><head>${opts.head ?? ""}<link rel="stylesheet" href="t.css"></head><body>${body}</body></html>`, [{ file: "t.css", text: opts.bare ? css : `${FONT}\n${css}` }]);
  const m = modelOf(loadSource("t.html (lifted)", t.yaml));
  const layouts = widths.map((w) => render(m, t.fixtureAt(w), [w])[0]);
  const impacts = tailwindImpact(t, layouts);
  const findings = check(layouts, impacts, t);
  const box = (id: string, w = widths[0]): Box => [...walk(layouts[widths.indexOf(w)].boxes)].find((b) => b.id === id)!;
  const approx = (id: string, w = widths[0]) => {
    const i = impacts[widths.indexOf(w)].uncertain.find((u) => u.id === id);
    const b = box(id, w);
    return i ? i.reasons[0] : b?.assumptions[0];
  };
  const exact = (w = widths[0]) => [...walk(layouts[widths.indexOf(w)].boxes)].filter((b) => !b.anonymous).every((b) => !approx(b.id, w));
  return { t, m, layouts, impacts, findings, box, approx, exact, layout: (w = widths[0]): Layout => layouts[widths.indexOf(w)] };
}
const geo = (b: Box) => [b.x, b.y, b.w, b.h].map((n) => +n.toFixed(3));

describe("a lift never aborts on one rule", () => {
  it("models aspect-ratio with a height and no width: the width follows the height", () => {
    const r = run(`<div class="a"><span class="logo">Brand</span><p class="p">Hello</p></div>`, `.logo { display: block; width: auto; height: 1.1em; aspect-ratio: 4/1 } p { margin: 0 }`);
    expect(geo(r.box("logo"))).toEqual([0, 0, 70.375, 17.594]);
    expect(r.approx("logo")).toBeUndefined();
  });

  it("stretched across a column flexbox, the ratio gives way to the column's width", () => {
    const r = run(`<div class="col"><span class="logo">Brand</span></div>`, `.col { display: flex; flex-direction: column } .logo { display: block; height: 20px; aspect-ratio: 4/1 }`);
    expect(geo(r.box("logo"))).toEqual([0, 0, 400, 20]);
  });

  it("inside an inline link (block-in-inline), as Chromium lays it out", () => {
    const r = run(`<a class="brand" href="/"><span class="logo">Brand</span></a><p class="p">Hello</p>`, `.logo { display: block; height: 1.1em; aspect-ratio: 4/1 } p { margin: 0 }`);
    expect(geo(r.box("brand"))).toEqual([0, 0, 400, 17.594]);
    expect(geo(r.box("p"))).toEqual([0, 17.594, 400, 24]);
  });

  it("drops what the validator rejects and marks that box ≈, instead of failing", async () => {
    const { liftElements } = await import("../src/lift/lift.js");
    const decl = (prop: string, value: string) => ({ prop, value, important: false, line: 3 });
    const lifted = liftElements({
      file: "x.css",
      vars: new Map(),
      notes: new Map(),
      prefix: "",
      elements: [{ className: "card", block: "card", states: new Map([[Infinity, new Map([["height", decl("height", "20px")], ["aspect-ratio", decl("aspect-ratio", "2 / 1")]])]]) }],
      blockOrder: ["card"],
      bpPx: [],
      bpRaw: new Map(),
      layerChildren: new Map(),
      unlifted: [],
      resets: new Map(),
      declarations: 2,
    });
    expect(() => modelOf(loadSource("x (lifted)", lifted.yaml))).not.toThrow();
    expect(lifted.unlifted.find((u) => u.className === "card" && u.kind === "geometry")?.reason).toMatch(/no exact Cadesa equivalent/);
  });
});

describe("overflow-wrap", () => {
  for (const [where, css] of [
    ["inherited", `body { overflow-wrap: break-word } .card { width: 100px; padding: 8px } .desc { margin: 0 }`],
    ["on the element", `.card { width: 100px; padding: 8px } .desc { margin: 0; overflow-wrap: break-word }`],
    ["as word-wrap", `.card { width: 100px; padding: 8px } .desc { margin: 0; word-wrap: break-word }`],
    ["anywhere", `.card { width: 100px; padding: 8px } .desc { margin: 0; overflow-wrap: anywhere }`],
  ])
    it(`lets a long word break, so it doesn't overflow (${where})`, () => {
      const r = run(`<div class="card"><p class="desc">Inspections, nonconformances and certifications</p></div>`, css);
      expect(r.findings.filter((f) => /can't wrap/.test(f.message))).toEqual([]);
      expect(r.box("desc").lines!.some((l) => /^nonconform\w*$/.test(l.text.trim()) && l.text.trim() !== "nonconformances")).toBe(true);
    });

  it("without it the word still overflows", () => {
    const r = run(`<div class="card"><p class="desc">Inspections, nonconformances and certifications</p></div>`, `.card { width: 100px; padding: 8px } .desc { margin: 0 }`);
    expect(r.findings.map((f) => f.message)).toContainEqual(expect.stringMatching(/"nonconformances" .* can't wrap and overflows by 37.38px/));
  });
});

describe("grids", () => {
  it("repeat(3, minmax(0, 1fr)) in a flex row is three columns, in layout units (it used to crash)", () => {
    const r = run(`<div class="controls"><div class="play"></div><div class="steps"><p class="s">One</p><p class="s">Two</p><p class="s">Three</p><p class="s">Four</p></div></div>`, `p { margin: 0 } .controls { display: flex } .play { width: 40px; height: 40px } .steps { flex: 1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) }`, [400]);
    expect(r.m.components.get("controls")!.slots.get("steps")!.props.layout?.columns).toHaveLength(3);
    expect(geo(r.box("s-4"))).toEqual([40, 24, 120, 24]);
    expect(r.exact()).toBe(true);
  });

  it("shares fr columns in layout units, around fixed and percentage tracks", () => {
    const r = run(`<div class="g1"><p>One</p><p>Two</p><p>Three</p></div><div class="g3"><p>One</p><p>Two</p></div><div class="g9"><p>One</p><p>Two</p><p>Three</p></div>`, `p { margin: 0 } .g1 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px } .g3 { display: grid; grid-template-columns: 1fr 2fr } .g9 { display: grid; grid-template-columns: 25% 1fr 30%; gap: 5px }`, [333, 401]);
    const ws = (id: string, w: number) => r.box(id, w).children.map((b) => +b.w.toFixed(3));
    expect(ws("g1", 333)).toEqual([106.328, 106.328, 106.344]);
    expect(ws("g3", 401)).toEqual([133.656, 267.344]);
    expect(ws("g9", 333)).toEqual([83.25, 139.859, 99.891]);
    expect(r.exact(333) && r.exact(401)).toBe(true);
  });

  it("a plain <n>fr column is never narrower than its items' min-content width", () => {
    const r = run(`<div class="g"><p>Supercalifragilisticexpialidocious</p><p>Two</p><p>Three</p></div>`, `p { margin: 0 } .g { display: grid; grid-template-columns: repeat(3, 1fr) }`, [333]);
    expect(r.box("g").children.map((b) => +b.w.toFixed(3))).toEqual([247.719, 41.078, 44.203]);
  });

  it("repeat(auto-fill, minmax(0, 1fr)) counts a 0 track as 1px (it used to crash with no gap)", () => {
    const r = run(`<div class="g"><p>One</p><p>Two</p></div>`, `p { margin: 0 } .g { display: grid; grid-template-columns: repeat(auto-fill, minmax(0, 1fr)) }`, [333]);
    expect(r.box("g").children.map((b) => b.w)).toEqual([1, 1]);
  });

  it("place-items: center sizes items to their content and centres them in the cell", () => {
    const r = run(`<div class="g"><p>One</p><p>Two longer text here</p><p>Three</p></div>`, `p { margin: 0 } .g { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); place-items: center }`, [333]);
    expect(r.box("g").children.map(geo)).toEqual([
      [39.984, 12, 31.016, 24],
      [111, 0, 111, 48],
      [255.391, 12, 44.203, 24],
    ]);
    expect(r.exact()).toBe(true);
  });

  it("separate row and column gaps", () => {
    const r = run(`<div class="g"><p>One</p><p>Two</p><p>Three</p></div>`, `p { margin: 0 } .g { display: grid; grid-template-columns: 123px 1fr; column-gap: 10px; row-gap: 4px }`, [333]);
    expect(r.box("g").children.map(geo)).toEqual([
      [0, 0, 123, 24],
      [133, 0, 200, 24],
      [0, 28, 123, 24],
    ]);
    expect(r.exact()).toBe(true);
  });
});

describe("units", () => {
  it("pt, pc, in, cm and mm are px (1in = 96px)", () => {
    const r = run(`<main class="page"><p class="small">Small print</p></main>`, `body { margin: 0; font-family: Inter; font-size: 10pt; line-height: 1.5 } .page { padding: 0.25in 1pc } .small { margin: 0.5cm 0 0; font-size: 9pt }`, [400], { bare: true });
    expect(r.box("small").props.text!.value.sizePx).toBeCloseTo(12, 6);
    expect(r.box("small").x).toBe(16);
    expect(r.box("small").y).toBe(24 + 18.890625);
    expect(r.exact()).toBe(true);
  });

  it("vw and clamp()/min()/max() are computed at each width", () => {
    const r = run(`<main class="page"><h1 class="title">Fluid heading</h1><div class="box"><p class="in">Box</p></div></main>`, `h1, p { margin: 0 } .page { padding: 0 4vw } .title { font-size: clamp(1.5rem, 1rem + 3vw, 3rem); line-height: 1.2 } .box { width: min(80vw, 30rem); padding: max(8px, 2vw) }`, [400, 1440]);
    expect(r.box("title", 400).props.text!.value.sizePx).toBeCloseTo(28);
    expect(r.box("title", 1440).props.text!.value.sizePx).toBe(48);
    expect(r.box("box", 400).w).toBeCloseTo(320 + 16);
    expect(r.box("box", 1440).w).toBeCloseTo(480 + 2 * 28.8, 1);
    expect(r.exact(400) && r.exact(1440)).toBe(true);
  });

  it("vh is computed for an 800px tall viewport and marked ≈", () => {
    const r = run(`<div class="shell"><div class="card"><p class="cp">Sign in</p></div></div><p class="after">Below</p>`, `p { margin: 0 } .shell { display: grid; place-items: center; min-height: 100dvh; padding: 16px; box-sizing: border-box } .card { width: 280px; padding: 24px; border: 1px solid #ddd }`, [400]);
    expect(geo(r.box("card"))).toEqual([35, 363, 330, 74]);
    expect(geo(r.box("after"))).toEqual([0, 800, 400, 24]);
    expect(r.approx("shell")).toMatch(/800px tall viewport/);
    expect(r.approx("card")).toMatch(/800px tall viewport/);
  });
});

describe("heights", () => {
  it("min-height makes a box at least that tall", () => {
    const r = run(`<section class="hero"><p class="hl">Hero</p></section><p class="next">Next</p>`, `p { margin: 0 } .hero { min-height: 240px; padding: 20px }`, [400]);
    expect(geo(r.box("hero"))).toEqual([0, 0, 400, 280]);
    expect(geo(r.box("next"))).toEqual([0, 280, 400, 24]);
    expect(r.exact()).toBe(true);
  });

  it("a grid with a min-height stretches its rows (align-items places items in them)", () => {
    const r = run(`<div class="g"><p>One</p><p>Two</p></div>`, `p { margin: 0 } .g { display: grid; grid-template-columns: 1fr 1fr; min-height: 100px; align-items: end }`, [400]);
    expect(r.box("g").children.map(geo)).toEqual([
      [0, 76, 200, 24],
      [200, 76, 200, 24],
    ]);
    expect(r.exact()).toBe(true);
  });

  it("height: 100% of a parent with a height is exact; of an auto height it is auto", () => {
    const r = run(`<div class="parent"><div class="child h-100"><p>Full</p></div></div><div class="auto"><div class="child2 h-100"><p>Auto</p></div></div>`, `p { margin: 0 } .parent { height: 120px; padding: 10px; box-sizing: border-box } .h-100 { height: 100% !important }`, [400]);
    expect(geo(r.box("child"))).toEqual([10, 10, 380, 100]);
    expect(geo(r.box("child2"))).toEqual([0, 120, 400, 24]);
    expect(r.exact()).toBe(true);
  });

  it("height: 100% inside a flex item, whose height may be stretched, is ≈", () => {
    const r = run(`<div class="row"><div class="col"><div class="h-100"><p>In a column</p></div></div></div>`, `p { margin: 0 } .row { display: flex } .h-100 { height: 100% }`, [400]);
    expect(r.approx("h-100")).toMatch(/may be stretched/);
  });
});

describe("the page", () => {
  it("models the browser's default body margin", () => {
    const r = run(`<main class="page"><h1 class="title">Hello there</h1><p class="lead">Lead</p></main>`, `body { font-family: Inter; font-size: 16px; line-height: 24px } .page { padding: 16px }`, [320], { bare: true });
    expect(geo(r.box("page"))).toEqual([8, 8, 304, 138.875]);
    expect(geo(r.box("title"))).toEqual([24, 45.438, 272, 24]);
    expect(r.exact()).toBe(true);
  });

  it("a body margin collapses with the first box's top margin; padding stops it", () => {
    const a = run(`<p class="p">Hello</p>`, `body { margin: 8px; font: 16px/1.5 Inter } p { margin: 20px 0 }`, [400], { bare: true });
    expect(geo(a.box("p"))).toEqual([8, 20, 384, 24]);
    const b = run(`<p class="p">Hello</p>`, `html { padding: 4px } body { margin: 8px; padding: 2px; border: 1px solid; font: 16px/1.5 Inter } p { margin: 20px 0 }`, [400], { bare: true });
    expect(geo(b.box("p"))).toEqual([15, 35, 370, 24]);
    expect(a.exact() && b.exact()).toBe(true);
  });

  it("overflow: hidden on the body doesn't make the page approximate", () => {
    const r = run(`<main class="page"><p class="p">Hi</p></main>`, `body { overflow: hidden } .page { padding: 16px } p { margin: 0 }`, [400]);
    expect(r.exact()).toBe(true);
  });
});

describe("approximate only where it matters", () => {
  it("decides :has() against the page", () => {
    const css = `.page { padding: 16px } p, h1 { margin: 0 } body:has(.app-shell) { overflow: hidden } .page:has(> .lead) { padding: 24px } .page:has(.missing) { padding: 40px }`;
    const r = run(`<main class="page"><h1 class="title">Hello</h1><p class="lead">Lead</p></main>`, css, [400]);
    expect(r.exact()).toBe(true);
    expect(r.box("page").props.padding!.value.top).toBe(24);
  });

  it("properties that can't move a box never make it ≈", () => {
    const r = run(`<main class="page"><div class="list"><p class="item">One</p></div></main>`, `body { text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; cursor: default } .page { counter-reset: step; padding: 8px } .item { margin: 0; counter-increment: step; user-select: none }`, [400]);
    expect(r.exact()).toBe(true);
  });
});

describe("a page that scrolls sideways", () => {
  const ROW = `.content { width: 100%; padding: 0 } .row { display: flex; flex-wrap: wrap; margin-left: -12px; margin-right: -12px } .col { flex: 1 0 0%; padding: 0 12px }`;
  const HTML = `<div class="shell"><div class="content"><div class="row"><div class="col">A card with some text</div></div></div></div>`;
  it("reports a box past the right edge of the viewport (a gutter row without its container padding)", () => {
    const r = run(HTML, ROW, [400]);
    const f = r.findings.filter((x) => /past the right edge/.test(x.message));
    expect(f.map((x) => [x.id, x.message, x.inconclusive])).toEqual([["row", "#row extends 12px past the right edge of the viewport at 400px (to 412px): the page scrolls sideways", undefined]]);
    expect(r.exact()).toBe(true);
  });

  it("not when the page clips it (overflow-x: hidden on the body), nor what a box clips", () => {
    expect(run(HTML, `${ROW} body { overflow-x: hidden }`, [400]).findings.filter((x) => /past the right edge/.test(x.message))).toEqual([]);
    expect(run(HTML, `${ROW} .content { overflow: hidden }`, [400]).findings.filter((x) => /past the right edge/.test(x.message))).toEqual([]);
  });
});

describe("align-items: baseline", () => {
  it("in a row of text in one font, aligning baselines aligns the tops of the content: exact", () => {
    const r = run(`<div class="r1"><span class="a">Label</span><span class="b">Value with padding</span><span class="c">Bordered</span></div>`, `.r1 { display: flex; align-items: baseline; gap: 8px } .b { padding: 10px 6px 2px } .c { border: 3px solid #333; margin-top: 4px }`, [400]);
    expect(r.box("r1").children.map(geo)).toEqual([
      [0, 10, 41.031, 24],
      [49.031, 0, 156.219, 36],
      [213.25, 7, 75.828, 30],
    ]);
    expect(r.exact()).toBe(true);
  });

  it("text in different sizes needs the font's vertical metrics: ≈", () => {
    const r = run(`<div class="r2"><span class="a">Small</span><span class="big">Big heading</span></div>`, `.r2 { display: flex; align-items: baseline; gap: 8px } .big { font-size: 28px }`, [400]);
    expect(r.approx("a")).toMatch(/baseline/);
  });
});

describe("elements not laid out are counted", () => {
  it("children of a grid Cadesa has no pattern for, and the rows of a table", async () => {
    const { notLaidOut } = await import("../src/laidout.js");
    const r = run(`<section class="g"><p>One</p><p>Two</p></section><table class="t"><tr><td>Cell</td></tr></table><p class="after">After</p>`, `p { margin: 0 } .g { display: grid; grid-template-columns: minmax(200px, 1fr) auto }`, [400]);
    expect(r.layout().notLaidOut!.map((x) => x.tag)).toEqual(["p", "p"]);
    const c = notLaidOut(r.t, r.layouts)!;
    expect(c.count).toBe(5);
    expect(c.causes).toEqual([
      { cause: "inside a table, laid out as one box", count: 3 },
      { cause: "inside a box whose layout Cadesa can't model (its children aren't placed)", count: 2 },
    ]);
  });
});

describe("advice on a lifted page is in CSS terms", () => {
  it("no layout: { pattern }, text roles or size tokens", () => {
    const r = run(`<section class="g"><p>One</p></section><p class="n">Normal</p><img class="i" src="x.png">`, `p { margin: 0 } .g { display: grid; grid-template-columns: minmax(200px, 1fr) auto } .n { line-height: normal }`, [400]);
    const text = r.findings.map((f) => f.message).join("\\n");
    expect(text).not.toMatch(/pattern:|text: <role>|size token|add aspect/);
    expect(text).toMatch(/the children of #g aren.t laid out: its display \(or grid template\) has no Cadesa equivalent/);
    expect(text).toMatch(/the text of #n can.t be measured/);
    expect(r.m.css).toBe(true);
  });
});
