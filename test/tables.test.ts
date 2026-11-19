/**
 * Tables, laid out as Chromium lays them out (src/engine/table.ts). Every geometry here was checked
 * against Chromium; conformance:css (fixtures/css/tables.html), conformance:bootstrap
 * (fixtures/bootstrap/tables.html) and `npm run fuzz:tables` keep checking it.
 */
import { describe, expect, it } from "vitest";
import type { Box } from "../src/engine/layout.js";
import { loadSource } from "../src/load.js";
import { validate } from "../src/validate.js";
import { run } from "./lift-page.js";

describe("a table sized by a grid track narrower than its caption", () => {
  it("is as wide as its caption, and its columns fill that width (fuzz:tables seed 100462)", () => {
    const r = run(
      `<div class="g"><div class="dt" data-fixture="t"><div class="cap">tools yard due harbor picking status line</div><div class="row"><div class="cell" data-fixture="c">shipped quantity</div></div></div><div>works</div></div>`,
      `.g { display: grid; grid-template-columns: 200px 1fr; gap: 8px } .dt { display: table; border-spacing: 7px 1px } .cap { display: table-caption; padding: 8px; width: 243px } .row { display: table-row } .cell { display: table-cell }`,
      [300],
    );
    expect([r.box("t").w, r.box("c").w]).toEqual([259, 245]);
  });
});

const geo = (b: Box) => [b.x, b.y, b.w, b.h].map((n) => +n.toFixed(3));

const BODY =
  `<table class="t1"><tr><td class="a">Apple</td><td class="b">Banana split</td></tr><tr><td class="c" colspan="2">Across both columns of the table</td></tr></table>` +
  `<table class="t2"><thead><tr><th class="h1">Order</th><th class="h2">Qty</th></tr></thead><tbody><tr><td class="d1">SO-1042</td><td class="d2">120</td></tr></tbody></table>` +
  `<table class="t3"><colgroup><col class="k1"><col class="k2"><col></colgroup><tr><td class="f1">One</td><td class="f2">Two</td><td class="f3">Three</td></tr></table>` +
  `<table class="t4"><tr><td class="v1"><div class="x1">Top</div></td><td class="v2"><div class="x2">Middle</div></td><td class="v3"><div class="x3">Bottom</div></td><td class="v4">A cell with enough words to wrap onto three lines here</td></tr></table>` +
  `<table class="t5"><tr><td class="r1" rowspan="2">Spans two rows</td><td class="r2">One</td></tr><tr><td class="r3">Two</td></tr></table>` +
  `<div class="dt"><div class="dr"><div class="dc1">Label</div><div class="dc2">Value of the field</div></div></div>`;
const CSS = `
.t2 { width: 100%; border-collapse: collapse } .t2 th, .t2 td { padding: 8px; border-bottom: 1px solid #ccc; text-align: left } .t2 th { border-bottom-width: 2px }
.t3 { width: 300px; table-layout: fixed; border-spacing: 0 } .k1 { width: 60px } .k2 { width: 50% }
.t4 { width: 300px } .v1 { vertical-align: top } .v2 { vertical-align: middle } .v3 { vertical-align: bottom }
.t5 { height: 120px; border-spacing: 4px }
.dt { display: table; border-spacing: 6px } .dr { display: table-row } .dc1, .dc2 { display: table-cell; padding: 4px } .dc1 { width: 80px }
`;

describe("tables", () => {
  const r = run(BODY, CSS, [400]);

  it("are exact: rows, cells, columns and the parser's implied <tbody> all have boxes", () => {
    expect(r.exact()).toBe(true);
    expect(r.layout().notLaidOut).toEqual([]);
  });

  it("auto layout with the browser's defaults: 2px border spacing, 1px cell padding, as wide as the content", () => {
    expect(geo(r.box("t1"))).toEqual([0, 0, 255.828, 58]);
    expect(geo(r.box("a"))).toEqual([2, 2, 81.859, 26]);
    expect(geo(r.box("b"))).toEqual([85.859, 2, 167.969, 26]);
    // A cell spanning both columns: as wide as they are with the spacing between them.
    expect(geo(r.box("c"))).toEqual([2, 30, 251.828, 26]);
  });

  it("collapsed borders: each cell gets half of the widest border on each edge, the table half of its outer ones", () => {
    expect(geo(r.box("t2"))).toEqual([0, 58, 400, 83]);
    // 8px padding, 24px line, 1px (half of the 2px below the header) at the bottom.
    expect(geo(r.box("h1"))).toEqual([0, 58, 260.359, 41]);
    // 1px above, 8 + 24 + 8, half of its own 1px bottom border.
    expect(geo(r.box("d1"))).toEqual([0, 99, 260.359, 41.5]);
  });

  it("table-layout: fixed takes the column widths: fixed, a percentage, the rest", () => {
    expect([r.box("f1"), r.box("f2"), r.box("f3")].map((b) => b.w)).toEqual([60, 150, 90]);
    expect(geo(r.box("k2"))).toEqual([60, 141, 150, 26]);
  });

  it("vertical-align places a cell's content at the top, middle or bottom of its row", () => {
    expect(r.box("v1").h).toBe(74);
    expect([r.box("x1").y, r.box("x2").y, r.box("x3").y]).toEqual([170, 194, 218]);
  });

  it("a table's height is shared by its rows; a cell spanning them is as tall as both and the spacing", () => {
    expect(geo(r.box("t5"))).toEqual([0, 245, 168.313, 120]);
    expect([r.box("r2").h, r.box("r3").h, r.box("r1").h]).toEqual([54, 54, 112]);
  });

  it("display: table, table-row and table-cell on <div>s", () => {
    expect(geo(r.box("dt"))).toEqual([0, 365, 241.719, 44]);
    expect(geo(r.box("dc1"))).toEqual([6, 371, 88, 32]);
  });

  it("keeps a table it can't lay out as one box (≈), and counts its contents as not laid out", () => {
    const t = run(`<table class="t"><tr class="gone"><td>A</td></tr><tr><td>B</td></tr></table>`, `.gone { visibility: collapse }`);
    expect(t.approx("t")).toMatch(/table is laid out as one box/);
    expect(t.box("t").children).toEqual([]);
  });

  it("what it can't place is ≈ on its own: a doubt about one row's height leaves the rows above exact", () => {
    // Fixed layout: a later row's cells don't size the columns; one in a font without metrics makes
    // only its row (and what's below) approximate.
    const t = run(
      `<table class="t"><tr class="r0"><td class="a">One</td><td class="b">Two</td></tr><tr class="r1"><td class="odd">Unmeasured</td><td>x</td></tr><tr class="r2"><td class="c">Three</td><td>y</td></tr></table><p class="after">After</p>`,
      `.t { table-layout: fixed; width: 300px } .odd { font-family: Unmeasured } p { margin: 0 }`,
    );
    expect([t.approx("r0"), t.approx("a"), t.approx("b")]).toEqual([undefined, undefined, undefined]);
    for (const id of ["r1", "odd", "r2", "c", "t", "after"]) expect(t.approx(id)).toBeDefined();
    // In auto layout the same cell sizes the columns: the whole table is approximate.
    const a = run(`<table class="t"><tr><td class="a">One</td></tr><tr><td class="odd">Unmeasured</td></tr></table>`, `.odd { font-family: Unmeasured }`);
    expect(a.approx("a")).toBeDefined();
  });

  it("rowspan=\"0\" spans the rows left in its row group", () => {
    const t = run(`<table class="t"><tr><td class="s" rowspan="0">All</td><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></table>`, ``);
    expect(t.box("s").h).toBe(82);
    expect(t.exact()).toBe(true);
  });

  it("a content-box cell's width leaves out its padding and the borders it gets", () => {
    const t = run(`<table class="t"><tr><td class="w">A</td><td>B</td></tr></table>`, `.t { border-collapse: collapse } .t td { border: 3px solid; padding: 4px } .w { width: 50px }`);
    // 50 + 4 + 4 + 1.5 + 1.5 (half of each collapsed 3px border).
    expect(t.box("w").w).toBe(61);
    expect(t.exact()).toBe(true);
  });

  it("reads presentational attributes: cellspacing, cellpadding, width, valign", () => {
    const t = run(`<table class="t" cellspacing="5" cellpadding="3"><tr><td class="w" width="70" valign="top">A</td><td>B</td></tr></table>`, ``);
    expect(t.box("w").x).toBe(5);
    // A 70px content box with 3px padding on each side.
    expect(t.box("w").w).toBe(76);
    expect(t.exact()).toBe(true);
  });
});

describe("the table pattern in a source", () => {
  const src = (styles: string) =>
    validate(
      loadSource(
        "t.cadesa.yaml",
        `version: 1\ntokens:\n  space: { s: 4px }\n  size: { m: 600px }\nstyles:\n${styles}`,
      ),
    );

  it("takes collapse, fixed, min and the border spacing as gap and rowGap; parts on its children", () => {
    const { diagnostics, model } = src(`  t:\n    layout: { pattern: table, collapse: false, fixed: true, min: m, gap: s, rowGap: s }\n    slots:\n      row: { part: row }\n      cell: { part: "cell middle content-box" }\n      cap: { part: "caption bottom" }\n`);
    expect(diagnostics).toEqual([]);
    const t = model!.components.get("t")!;
    expect(t.props.layout).toMatchObject({ pattern: "table", fixed: true });
    expect(t.slots.get("cell")!.props.part).toMatchObject({ value: "cell", align: "middle", contentBox: true });
    expect(t.slots.get("cap")!.props.part).toMatchObject({ value: "caption", side: "bottom" });
  });

  it("rejects collapse outside a table, and a part it doesn't know", () => {
    expect(src(`  t:\n    layout: { pattern: stack, collapse: true }\n`).diagnostics[0].message).toMatch(/collapse only applies to a table/);
    expect(src(`  t:\n    part: "cell sideways"\n`).diagnostics[0].message).toMatch(/invalid part/);
  });
});
