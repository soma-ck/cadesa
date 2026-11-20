/**
 * shrink (flex-shrink) in a cluster: an item with a width that still gives way in a full row, and
 * one without a width that doesn't. Chromium's boxes come from conformance:css
 * (fixtures/css/shrink.html).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.js";
import { walk } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";
import { validate } from "../src/validate.js";
import { run } from "./lift-page.js";

const SRC = `tokens: { size: { a: 300px, b: 200px, c: 100px } }
styles:
  row:
    layout: { pattern: cluster, wrap: false }
    width: c
    slots:
      a: { width: a, shrink: 1 }
      b: { width: b, shrink: 2 }
      c: { width: c }
`;

describe("shrink", () => {
  it("compiles to flex-shrink, keeping a width's flex: none where it isn't set", () => {
    const css = compile(modelOf(loadSource("t.yaml", SRC)));
    expect(css).toMatch(/\.ca-row__a \{[^}]*flex: 0 1 auto;/);
    expect(css).toMatch(/\.ca-row__b \{[^}]*flex: 0 2 auto;/);
    expect(css).toMatch(/\.ca-row__c \{[^}]*flex: none;/);
  });

  it("rejects a negative factor", () => {
    expect(validate(loadSource("t.yaml", SRC.replace("shrink: 2", "shrink: -1"))).diagnostics.map((d) => d.message)).toContain("invalid shrink");
  });

  it("shrinks items with a width in proportion to factor × size, never below their minimum", () => {
    const html = `<div class="ca-row" data-fixture="row"><div class="ca-row__a" data-fixture="a"></div><div class="ca-row__b" data-fixture="b"></div><div class="ca-row__c" data-fixture="c"></div></div>`;
    const l = render(modelOf(loadSource("t.yaml", SRC.replace("c: 100px }", "c: 100px, r: 400px }").replace("width: c\n    slots", "width: r\n    slots"))), parseFixture("t.html", html), [1000])[0];
    const b = Object.fromEntries([...walk(l.boxes)].map((x) => [x.id, x.w]));
    // 600px of items in 400px: 200px to give up, weighted 300 × 1 and 200 × 2 (c doesn't shrink),
    // the last item first, in layout units.
    expect([b.a, b.b, b.c]).toEqual([13714 / 64, 5486 / 64, 100]);
  });

  it("lifts flex-shrink on an item with a width, and flex-shrink: 0 on one without", () => {
    const r = run(
      `<div class="row"><div class="side">Pantry shelves</div><div class="main">Tins, jars and a sack of flour by the door</div><div class="end">Stocked</div></div>`,
      `.row { display: flex; width: 300px }
.side { width: 160px }
.main { width: 420px; flex-shrink: 2 }
.end { flex-shrink: 0 }`,
    );
    expect(r.exact()).toBe(true);
    expect(r.t.yaml).toMatch(/shrink: 2/);
    expect(r.t.yaml).toMatch(/shrink: 0/);
    // The text item keeps its max-content width; the others share what is left.
    expect(r.box("side").w + r.box("main").w + r.box("end").w).toBe(300);
  });
});
