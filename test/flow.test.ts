import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.js";
import { walk } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { liftCssPage, parseSelector } from "../src/lift/css-page.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";
import { validate } from "../src/validate.js";

const SRC = `
tokens:
  space: { s8: 8px, s20: 20px, s30: 30px }
  size: { half: 50%, w200: 200px }
styles:
  box:
    layout: { pattern: flow }
    slots:
      a: { height: w200, margin: { bottom: s20 } }
      b: { height: w200, margin: { top: s30, inline: s8 } }
      empty: { margin: s30 }
      half: { width: half, height: w200 }
  stack:
    layout: { pattern: stack, gap: s8 }
    slots:
      a: { height: w200, margin: { block: s20 } }
`;
const boxes = (yaml: string, html: string, w = 400) => {
  const l = render(modelOf(loadSource("t.yaml", yaml)), parseFixture("t.html", html), [w])[0];
  return Object.fromEntries([...walk(l.boxes)].map((b) => [b.id, [b.x, b.y, b.w, b.h]]));
};

describe("block flow, margins and percentages", () => {
  it("collapses adjoining margins between siblings, through empty blocks and through the parent", () => {
    const r = boxes(
      SRC,
      `<div class="ca-box" data-fixture="box"><div class="ca-box__a" data-fixture="a"></div><div class="ca-box__empty" data-fixture="e"></div><div class="ca-box__b" data-fixture="b"></div></div>`,
    );
    // a's bottom 20, the empty block's 30/30 and b's top 30 collapse into one 30px margin.
    expect(r.a).toEqual([0, 0, 400, 200]);
    expect(r.e).toEqual([30, 230, 340, 0]);
    expect(r.b).toEqual([8, 230, 384, 200]);
    expect(r.box).toEqual([0, 0, 400, 430]);
  });

  it("adds margins to a stack item's outer size (no collapsing)", () => {
    const r = boxes(SRC, `<div class="ca-stack" data-fixture="s"><div class="ca-stack__a" data-fixture="a1"></div><div class="ca-stack__a" data-fixture="a2"></div></div>`);
    expect(r.a1[1]).toBe(20);
    expect(r.a2[1]).toBe(20 + 200 + 20 + 8 + 20);
    expect(r.s[3]).toBe(20 + 200 + 20 + 8 + 20 + 200 + 20);
  });

  it("resolves a percentage width against the parent's content width, as Chromium does", () => {
    const r = boxes(SRC, `<div class="ca-box" data-fixture="box"><div class="ca-box__half" data-fixture="h"></div></div>`, 333.328125 as number);
    expect(r.h[2]).toBe(166.65625);
  });

  it("rejects a percentage height, and gap or align on a flow", () => {
    const ds = validate(loadSource("t.yaml", SRC.replace("half: { width: half, height: w200 }", "half: { width: w200, height: half }").replace("pattern: flow }", "pattern: flow, gap: s8 }"))).diagnostics;
    expect(ds.map((d) => d.message)).toEqual(expect.arrayContaining([expect.stringMatching(/percentage; a height needs a length/), expect.stringMatching(/a flow has no gap/)]));
  });

  it("compiles flow children to blocks and margins to every side", () => {
    const css = compile(modelOf(loadSource("t.yaml", SRC)));
    expect(css).toContain(":where(.ca-box > *) {\n  display: block;\n}");
    expect(css).toContain("margin: var(--ca-space-s30) var(--ca-space-s8) 0 var(--ca-space-s8);");
  });
});

describe("plain CSS page lift", () => {
  it("parses selectors with combinators and functional pseudo-classes", () => {
    expect(parseSelector(".a > .b + .c ~ p:not(.x):is(h1, .y)")?.parts.length).toBe(4);
    expect(parseSelector("a[href^='http' i]::before")).toBeDefined();
  });

  it("inherits body text, matches descendant and sibling selectors, and lifts block flow with margins", () => {
    const t = liftCssPage("fixtures/css/panel.html", readFileSync("fixtures/css/panel.html", "utf8"), "fixtures/css/panel.css", readFileSync("fixtures/css/panel.css", "utf8"));
    const data = t.lifted.data as { text: Record<string, { size: string; lineHeight: number; font: string }>; styles: Record<string, { layout: unknown; slots: Record<string, Record<string, unknown>> }> };
    const panel = data.styles["side-panel"];
    expect(panel.layout).toEqual({ pattern: "flow" });
    // body { font: 14px/1.5 Inter } reaches the paragraph; .item p sets only its color.
    const desc = data.text[panel.slots["item-desc"].text as string];
    expect(desc).toMatchObject({ size: "14px", lineHeight: 1.5 });
    // .detail-row + .detail-row { margin-top: 8px } matches only the later rows.
    expect(panel.slots["detail-row"].margin).toBeUndefined();
    expect(panel.slots["detail-row-2"].margin).toEqual({ top: "px-8" });
    // width: 40% becomes a percentage size token.
    expect(panel.slots["detail-label"].width).toBe("pct-40");
  });
});
