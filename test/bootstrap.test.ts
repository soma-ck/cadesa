/**
 * The language features behind Bootstrap-style pages (none in overrides, per-side padding and
 * borders, negative and auto margins, justify, one-line clusters, grow, width: fit, nowrap text)
 * and the page lift of the Angular + Bootstrap fixtures. Chromium's numbers here were measured with
 * the probes described in the comments; conformance:bootstrap and the fuzzer check the rest.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.js";
import { walk } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { liftCssPage } from "../src/lift/css-page.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";
import { validate } from "../src/validate.js";

const errors = (yaml: string) => validate(loadSource("t.yaml", yaml)).diagnostics.map((d) => `${d.path}: ${d.message}`);
const boxes = (yaml: string, html: string, w = 1000) => {
  const l = render(modelOf(loadSource("t.yaml", yaml)), parseFixture("t.html", html), [w])[0];
  return { l, b: Object.fromEntries([...walk(l.boxes)].map((b) => [b.id, [b.x, b.y, b.w, b.h]])) };
};
const div = (cls: string, id: string, inner = "") => `<div class="${cls}" data-fixture="${id}">${inner}</div>`;

describe("language: what Bootstrap's CSS needs", () => {
  it("validates none (overrides only), negative space (margins only), justify, wrap, grow, fit and side widths", () => {
    const base = `tokens: { space: { s: 8px, n: -12px }, size: { w: 300px }, color: { c: "#000" } }\nbreakpoints: { narrow: 600px }\n`;
    expect(errors(base + "styles: { a: { maxWidth: w, when: { narrow: { maxWidth: none } } } }")).toEqual([]);
    expect(errors(base + "styles: { a: { maxWidth: none } }")[0]).toMatch(/maxWidth: none only applies in a breakpoint override/);
    expect(errors(base + "styles: { a: { margin: { inline: n, top: s } } }")).toEqual([]);
    expect(errors(base + "styles: { a: { padding: { left: n } } }")[0]).toMatch(/"n" is negative; padding can't be/);
    expect(errors(base + "styles: { a: { margin: { top: auto } } }")[0]).toMatch(/only left and right margins can be auto/);
    expect(errors(base + "styles: { a: { layout: { pattern: cluster, justify: between, wrap: false } } }")).toEqual([]);
    expect(errors(base + "styles: { a: { layout: { pattern: stack, justify: between } } }")[0]).toMatch(/justify only applies to a cluster/);
    expect(errors(base + "styles: { a: { grow: { factor: 1, basis: zero }, width: fit } }")).toEqual([]);
    expect(errors(base + "styles: { a: { grow: 0 } }")[0]).toMatch(/invalid grow/);
    expect(errors(base + "styles: { a: { border: { color: c, bottom: s } } }")).toEqual([]);
    expect(errors(base + "text: { t: { size: 16px, weight: 400, lineHeight: 1.5, color: c, wrap: none } }")).toEqual([]);
  });

  it("compiles them to CSS that means the same thing", () => {
    const m = modelOf(
      loadSource(
        "t.yaml",
        `tokens: { space: { s: 8px, n: -12px, b: 4px }, size: { w: 300px }, color: { c: "#000" } }
breakpoints: { narrow: 600px }
text: { t: { size: 16px, weight: 400, lineHeight: 1.5, color: c, wrap: none } }
styles:
  row:
    layout: { pattern: cluster, justify: between, wrap: false }
    margin: { top: n }
    maxWidth: w
    border: { color: c, left: b, width: s }
    padding: { top: s, left: b }
    when: { narrow: { maxWidth: none, margin: { inline: auto } } }
    slots:
      col: { grow: { factor: 1, basis: zero }, width: w }
      label: { text: t, width: fit }
`,
      ),
    );
    const css = compile(m);
    expect(css).toContain("justify-content: space-between");
    expect(css).toContain("flex-wrap: nowrap");
    expect(css).toContain("border-width: var(--ca-space-s) var(--ca-space-s) var(--ca-space-s) var(--ca-space-b)");
    expect(css).toContain("padding: var(--ca-space-s) 0 0 var(--ca-space-b)");
    expect(css).toMatch(/@media \(max-width: 600px\) \{\n  \.ca-row \{[^}]*max-width: none;[^}]*margin-left: auto;\n    margin-right: auto/);
    // A width says no shrinking; flex: 1 0 0px after the width's flex: none.
    expect(css).toMatch(/width: var\(--ca-size-w\);\n  align-self: auto;\n  flex: none;\n  flex: 1 0 0px;/);
    expect(css).toContain("width: fit-content");
    expect(css).toContain("white-space: nowrap");
    expect(css).toContain(".ca-row .ca-row__label :where(*) {\n  white-space: inherit;");
  });

  it("distributes a cluster line's free space as Chromium's diffuser does (justify)", () => {
    // Chromium: three 33.3px items in a 1001px row, space-between: 0, 483.859375, 967.703125.
    const src = `tokens: { size: { w: 33.3px, h: 5px, row: 1001px } }\nstyles:\n  r:\n    layout: { pattern: cluster, justify: between }\n    width: row\n    slots: { i: { width: w, height: h } }\n`;
    const i = (n: number) => div("ca-r__i", `i${n}`);
    const { b } = boxes(src, div("ca-r", "r", i(1) + i(2) + i(3)), 1200);
    expect([b.i1[0], b.i2[0], b.i3[0]]).toEqual([0, 30967 / 64, 61933 / 64]);
  });

  it("shares free space like Chromium's LineFlexer (grow from zero), last item first", () => {
    // Chromium: flex: 1 0 0% ×3 in 1000px → 333.328125, 333.34375, 333.328125.
    const src = `tokens: { size: { row: 1000px, h: 10px } }\nstyles:\n  r:\n    layout: { pattern: cluster }\n    width: row\n    slots: { c: { grow: { factor: 1, basis: zero }, height: h } }\n`;
    const c = (n: number) => div("ca-r__c", `c${n}`);
    const { b } = boxes(src, div("ca-r", "r", c(1) + c(2) + c(3)), 1200);
    expect([b.c1[2], b.c2[2], b.c3[2]]).toEqual([21333 / 64, 21334 / 64, 21333 / 64]);
  });

  it("lays out negative margins: wider than the parent, and collapsing as positive plus negative", () => {
    const src = `tokens: { space: { n: -12px, p: 20px, q: -5px }, size: { h: 10px } }\nstyles:\n  c:\n    layout: { pattern: flow }\n    slots:\n      row: { height: h, margin: { inline: n, top: q } }\n      a: { height: h, margin: { bottom: p } }\n`;
    const { b } = boxes(src, div("ca-c", "c", div("ca-c__a", "a") + div("ca-c__row", "row")), 400);
    expect(b.row).toEqual([-12, 10 + 20 - 5, 424, 10]);
  });

  it("draws border widths at whole pixels, as Chromium does at device pixel ratio 1", () => {
    const src = `tokens: { space: { t: 2.7px, h: 0.5px }, color: { c: "#000" }, size: { z: 10px } }\nstyles:\n  a: { height: z, border: { color: c, top: t, bottom: h } }\n`;
    const { l } = boxes(src, div("ca-a", "a"), 400);
    expect(l.boxes[0].props.border!.value.widths).toEqual({ top: 2, right: 0, bottom: 1, left: 0 });
    expect(l.boxes[0].h).toBe(10);
  });

  it("puts a cluster line's free space into auto margins, and shrinks a one-line cluster's items to fit", () => {
    const src = `tokens: { size: { w: 100px, row: 600px } }\nstyles:\n  r:\n    layout: { pattern: cluster }\n    width: row\n    slots:\n      a: { width: w }\n      b: { width: w, margin: { left: auto } }\n`;
    const { b } = boxes(src, div("ca-r", "r", div("ca-r__a", "a") + div("ca-r__b", "b")), 800);
    expect(b.b[0]).toBe(500);
  });
});

const BS = ["fixtures/bootstrap/bootstrap.css", "fixtures/bootstrap/app.css"].map((file) => ({ file, text: readFileSync(file, "utf8") }));
const lift = (page: string) => liftCssPage(page, readFileSync(page, "utf8"), BS);

describe("Angular + Bootstrap pages through --css", () => {
  const dash = lift("fixtures/bootstrap/dashboard.html");
  const styles = (dash.lifted.data.styles as Record<string, { slots: Record<string, Record<string, unknown>>; when?: Record<string, { slots?: Record<string, Record<string, unknown>> }> }>)["app-root"];

  it("lifts a valid source", () => {
    expect(validate(loadSource("d.yaml", dash.yaml)).diagnostics).toEqual([]);
  });

  it("removes .container's max-width below 576px instead of flagging it", () => {
    const narrowest = Object.entries(styles.when!).find(([k]) => k === "max-575-99px")![1];
    expect(narrowest.slots!.container.maxWidth).toBe("none");
    expect(dash.lifted.unlifted.some((u) => /can't unset/.test(u.reason))).toBe(false);
  });

  it("lifts .row's negative gutters and the columns' grow, .d-flex as a one-line justified cluster", () => {
    expect((styles.slots.row.margin as { inline: string }).inline).toMatch(/^px-n/);
    expect(styles.slots["d-flex"].layout).toEqual({ pattern: "cluster", justify: "between", wrap: false });
  });

  it("lays out unstyled Angular elements (inline, wrapping blocks) as Chromium does, and an empty <router-outlet> as a 0×0 box", () => {
    expect(styles.slots["app-dashboard-page"].layout).toEqual({ pattern: "flow" });
    const l = render(modelOf(loadSource("d.yaml", dash.yaml)), dash.fixtureAt(1280), [1280])[0];
    const ro = [...walk(l.boxes)].find((b) => b.id === "router-outlet")!;
    expect([ro.w, ro.h]).toEqual([0, 0]);
  });

  it("gives a list-group item's text its anonymous flex item, and a table one box of unknown height", () => {
    const l = render(modelOf(loadSource("d.yaml", dash.yaml)), dash.fixtureAt(1280), [1280])[0];
    const all = [...walk(l.boxes)];
    expect(all.find((b) => b.id === "text")?.anonymous).toBe(true);
    expect(all.find((b) => b.id === "table")!.children).toEqual([]);
    expect(dash.lifted.unlifted.find((u) => u.decl === "display: table")?.kind).toBe("height");
  });

  it("predicts Bootstrap's form controls: one line of line-height plus padding and border", () => {
    const edit = lift("fixtures/bootstrap/order-edit.html");
    const l = render(modelOf(loadSource("e.yaml", edit.yaml)), edit.fixtureAt(1000), [1000])[0];
    const h = (tag: string) => [...walk(l.boxes)].find((b) => b.tag === tag)!.h;
    expect(h("input")).toBe(38);
    expect(h("select")).toBe(38);
    expect(h("textarea")).toBe(86); // rows="3"
  });
});
