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
