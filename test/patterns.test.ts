/**
 * Checks that hold where the layout is approximate (text running together, contrast against the
 * nearest painted background), and the Bootstrap patterns behind them: elements hidden at some
 * widths, scroll containers, flex-wrap: inherit. Box numbers are checked against Chromium by
 * conformance:bootstrap (fixtures/bootstrap/shell.html).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { tailwindImpact } from "../src/commands.js";
import { walk } from "../src/engine/layout.js";
import { liftCssPage } from "../src/lift/css-page.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";
import { validate } from "../src/validate.js";

const FONT = `body { margin: 0; font: 16px/1.5 Inter, sans-serif; color: #111111; background: #ffffff }`;
const pageOf = (body: string, css: string) => liftCssPage("t.html", `<!doctype html><html><head><link rel="stylesheet" href="t.css"></head><body>${body}</body></html>`, [{ file: "t.css", text: `${FONT}\n${css}` }]);
const findings = (body: string, css: string, widths = [400]) => {
  const t = pageOf(body, css);
  const m = modelOf(loadSource("t.yaml", t.yaml));
  const layouts = widths.map((w) => render(m, t.fixtureAt(w), [w])[0]);
  return check(layouts, tailwindImpact(t, layouts), t);
};
const spacing = (body: string, css = "", widths = [400]) => findings(body, css, widths).filter((f) => f.check === "spacing");

describe("text that runs together", () => {
  it("reports inline neighbours with nothing between them, with the text they make", () => {
    const f = spacing(`<div class="kpi"><span class="label">Total</span><span>1,284</span></div>`);
    expect(f.map((x) => x.message)).toEqual([
      `"Total" and "1,284" run together as "Total1,284": nothing separates the <span> and the <span> in #kpi (no space, and no margin, padding or border); add a space or a margin`,
    ]);
    expect(f[0].inconclusive).toBeUndefined();
    expect(f[0].path).toBe("t.html:1");
  });

  it("reports a text next to an inline element", () => {
    expect(spacing(`<p class="p">Due<b>today</b></p>`).map((x) => x.message)[0]).toMatch(/^"Due" and "today" run together as "Duetoday": nothing separates the text and the <b>/);
  });

  it("accepts a space, a margin, padding or punctuation between them, and sub/sup", () => {
    expect(spacing(`<div class="a"><span>Total</span> <span>42</span></div>`)).toEqual([]);
    expect(spacing(`<div class="a"><span class="me">Total</span><span>42</span></div>`, `.me { margin-right: 4px }`)).toEqual([]);
    expect(spacing(`<div class="a"><span>Total</span><span class="ps">42</span></div>`, `.ps { padding-left: 2px }`)).toEqual([]);
    expect(spacing(`<div class="a"><span>Total:</span><span>42</span></div>`)).toEqual([]);
    expect(spacing(`<div class="a">m<sup>2</sup></div>`)).toEqual([]);
  });

  it("in a flex row: the gap counts, whitespace doesn't, and distributed free space separates them", () => {
    expect(spacing(`<div class="row"><span>Total</span> <span>42</span></div>`, `.row { display: flex }`)).toHaveLength(1);
    expect(spacing(`<div class="row"><span>Total</span><span>42</span></div>`, `.row { display: flex; gap: 4px }`)).toEqual([]);
    expect(spacing(`<div class="row"><span>Total</span><span>42</span></div>`, `.row { display: flex; justify-content: space-between }`)).toEqual([]);
    expect(spacing(`<div class="row"><span>Total</span><span>42</span></div>`, `.row { display: flex; flex-direction: column }`)).toEqual([]);
  });

  it("only where both are shown (display: none at some widths)", () => {
    const f = spacing(`<div class="a"><span>Total</span><span class="wide">42</span></div>`, `.wide { display: none } @media (min-width: 768px) { .wide { display: inline } }`, [400, 800]);
    expect(f.map((x) => x.width)).toEqual([800]);
  });

  it("is inconclusive when generated content may separate them", () => {
    const f = spacing(`<div class="a"><span class="sep">Total</span><span>42</span></div>`, `.sep::after { content: "" }`);
    expect(f).toHaveLength(1);
    expect(f[0].inconclusive).toBe(true);
    expect(f[0].message).toMatch(/may run together as "Total42" in #a: t\.css:2 \.sep::after adds content Cadesa doesn't model$/);
  });
});

describe("contrast against the nearest painted background", () => {
  it("shows translucent text over its background (rgba, Bootstrap's .text-muted)", () => {
    const f = findings(`<p class="muted">Muted text</p>`, `.muted { color: rgba(0, 0, 0, 0.5) }`).filter((x) => x.check === "contrast");
    expect(f.map((x) => x.message)).toEqual([expect.stringMatching(/^#muted text #00000080 \(50% opaque, shows as #7f7f7f\) on #ffffff is 4\.00:1/)]);
  });

  it("blends a translucent background into the one below it", () => {
    const f = findings(`<div class="card"><div class="head"><p class="t">Header</p></div></div>`, `.card { background: #777777 } .head { background: rgba(255, 255, 255, 0.5) } .t { color: #ffffff; margin: 0 }`).filter((x) => x.check === "contrast");
    expect(f[0].message).toMatch(/^#t text #ffffff on #bbbbbb is 1\.\d+:1; WCAG AA needs 4\.5:1 \(background: .*head\.background \(50% opaque\) over .*card\.background\)/);
  });

  it("checks inline runs in a color or on a background of their own (text-danger, badges) against what's behind them", () => {
    const f = findings(
      `<p class="status">Line 3 is <span class="late">late</span>, <span class="badge">new</span> and <span class="ok">fine</span></p>`,
      `p { margin: 0 } .late { color: #ff6b6b } .badge { background-color: #ffc107; color: #ffffff } .ok { color: #000000 }`,
    ).filter((x) => x.check === "contrast");
    expect(f.map((x) => [x.message.replace(/;.*$/, ""), x.inconclusive, x.path])).toEqual([
      [`"late" (<span> in #status) text #ff6b6b on #ffffff is 2.78:1`, undefined, "t.html:1"],
      [`"new" (<span> in #status) text #ffffff on #ffc107 is 1.63:1`, undefined, "t.html:1"],
    ]);
  });

  it("stays conclusive with transitions, cursors and outlines, which change no color", () => {
    const f = findings(`<button class="btn" type="button">Export</button>`, `body { background: #f4f6f9 } .btn { color: #6c757d; background-color: transparent; border: 1px solid #6c757d; padding: 6px 12px; font: inherit; cursor: pointer; transition: color .15s; outline: 0; -webkit-appearance: button; user-select: none }`).filter((x) => x.check === "contrast");
    expect(f).toHaveLength(1);
    expect(f[0].inconclusive).toBeUndefined();
  });
});

describe("the cascade on Bootstrap-like markup", () => {
  it("leaves out inline text hidden at some widths, and measures it where it shows", () => {
    const t = pageOf(`<h1 class="title">Shipments<span class="wide"> this week</span></h1>`, `h1 { margin: 0; font-size: 24px } .wide { display: none !important } @media (min-width: 768px) { .wide { display: inline !important } }`);
    const m = modelOf(loadSource("t.yaml", t.yaml));
    const box = (w: number) => [...walk(render(m, t.fixtureAt(w), [w])[0].boxes)].find((b) => b.id === "title")!;
    expect(box(400).text).toBe("Shipments");
    expect(box(800).text).toBe("Shipments this week");
    // display: inline where it shows is no change of style: the text box stays exact.
    expect(t.lifted.unlifted.filter((u) => u.className && /inline runs/.test(u.reason))).toEqual([]);
  });

  it("takes text-align back to start below a breakpoint (text-md-end), and ignores flex alignment on a block container", () => {
    const t = pageOf(
      `<div class="menu"><p class="count">248 products</p></div>`,
      `.menu { align-items: center; justify-content: space-between } p { margin: 0 } @media (min-width: 768px) { .count { text-align: right } }`,
    );
    expect(t.yaml).toMatch(/textAlign: start/);
    expect(t.lifted.unlifted.filter((u) => u.kind !== "none" && u.kind !== "state")).toEqual([]);
  });

  it("resolves inherit on a property that doesn't inherit (Bootstrap's .navbar > .container { flex-wrap: inherit })", () => {
    const t = pageOf(`<nav class="bar"><div class="inner"><a href="#">One</a><a href="#">Two</a></div></nav>`, `.bar { display: flex; flex-wrap: nowrap } .bar > .inner { display: flex; flex-wrap: inherit }`);
    expect(t.yaml).toMatch(/inner: \{ layout: \{ pattern: cluster, align: stretch, wrap: false \} \}/);
  });
});

describe("lone buttons on their line, and transforms (fixtures/css/inline.html, checked by conformance:css)", () => {
  const page = "fixtures/css/inline.html";
  const t = liftCssPage(page, readFileSync(page, "utf8"), [{ file: "fixtures/css/inline.css", text: readFileSync("fixtures/css/inline.css", "utf8") }]);
  const m = modelOf(loadSource("i.yaml", t.yaml));
  const l = render(m, t.fixtureAt(400), [400])[0];
  const imp = tailwindImpact(t, [l])[0];
  // Uncertain in size (not just moved by the cases above it).
  const unsure = new Set(imp.uncertain.filter((u) => u.effects.some((e) => e !== "position")).map((u) => u.id));

  it("keeps a button exact when its box contains the line's strut, not when a set height is shorter than the line", () => {
    expect(unsure.has("same-slot")).toBe(false);
    expect(unsure.has("tall-slot")).toBe(false);
    // Chromium: the slot is 40px tall (8 + a 24px line + 8), not 8 + 20 + 8.
    expect(unsure.has("short-slot")).toBe(true);
    expect(unsure.has("tight-slot")).toBe(true);
  });

  it("marks a transformed box, and keeps a tap-target finding on it inconclusive", () => {
    expect(imp.uncertain.find((u) => u.id === "nudged")?.reasons.find((r) => !r.startsWith("moved by"))).toMatch(/transform: translateY\(6px\): transform is not modelled/);
    // Two elements of a tag on one source line: each gets its own records.
    expect(unsure.has("plain")).toBe(false);
    const tap = check([l], [imp]).filter((x) => x.check === "tap-target" && x.id === "nudged");
    expect(tap.length).toBe(1);
    expect(tap[0].inconclusive).toBe(true);
  });
});

const BS = ["fixtures/bootstrap/bootstrap.css", "fixtures/bootstrap/app.css"].map((file) => ({ file, text: readFileSync(file, "utf8") }));

describe("an Angular + Bootstrap app shell (navbar collapse, d-none / d-lg-flex, table-responsive, text-truncate)", () => {
  const page = "fixtures/bootstrap/shell.html";
  const t = liftCssPage(page, readFileSync(page, "utf8"), BS);
  const m = modelOf(loadSource("s.yaml", t.yaml));
  const widths = [375, 800, 1280];
  const layouts = widths.map((w) => render(m, t.fixtureAt(w), [w])[0]);
  const ids = (w: number) => new Set([...walk(layouts[widths.indexOf(w)].boxes)].map((b) => b.id));
  const f = check(layouts, tailwindImpact(t, layouts), t);

  it("lifts a valid source", () => {
    expect(validate(loadSource("s.yaml", t.yaml)).diagnostics).toEqual([]);
  });

  it("lays out the collapsed menu, the sidebar and d-lg-flex only from 992px, the toggler and d-lg-none below", () => {
    for (const id of ["collapse", "navbar-nav", "navbar-text", "col-lg-2", "d-none"]) {
      expect(ids(375).has(id), id).toBe(false);
      expect(ids(800).has(id), id).toBe(false);
      expect(ids(1280).has(id), id).toBe(true);
    }
    for (const id of ["navbar-toggler", "btn"]) {
      expect(ids(375).has(id), id).toBe(true);
      expect(ids(1280).has(id), id).toBe(false);
    }
  });

  it("reports nothing about content hidden at a width, nor the table scrolling in .table-responsive", () => {
    expect(f.filter((x) => x.check === "layout")).toEqual([]);
    expect(f.some((x) => /collapse|navbar-nav|nav-link-2|table/.test(x.id) && x.width < 992 && x.check !== "contrast")).toBe(false);
  });

  it("finds the run-together total, the truncated customer name and the translucent navbar links, conclusively", () => {
    const by = (check: string, id: string) => f.filter((x) => x.check === check && x.id === id);
    expect(by("spacing", "kpi-total").map((x) => x.width)).toEqual(widths);
    expect(by("clipped", "customer-name").map((x) => [x.width, x.inconclusive])).toEqual([
      [375, undefined],
      [800, undefined],
      [1280, undefined],
    ]);
    expect(by("contrast", "navbar-text").map((x) => [x.width, x.inconclusive])).toEqual([[1280, undefined]]);
    expect(by("contrast", "navbar-text")[0].message).toMatch(/55% opaque/);
  });
});
