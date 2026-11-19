/**
 * Findings on a page checked with its own CSS (--css, --tailwind) point at the page: the element's
 * line, tag, classes and text, and the stylesheet rule (file:line, selector) behind the property,
 * following var() to where the variable is set. The Cadesa path stays in `path`.
 */
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/check.js";
import { checkCmd, parseWidths } from "../src/commands.js";
import { pageForBrowser, probeOf } from "../src/verify.js";

const BS = "fixtures/bootstrap/bootstrap.css,fixtures/bootstrap/app.css";
const findings = (fixture: string, css: string, widths = "390") => {
  const r = checkCmd({ fixture, css, widths: parseWidths(widths) });
  return { r, f: (r.data as { findings: Finding[] }).findings };
};

describe("source pointers on --css pages", () => {
  it("names the element and the rule behind a contrast finding, through custom properties", () => {
    const { r, f } = findings("fixtures/bootstrap/dashboard.html", BS);
    const delta = f.find((x) => x.check === "contrast" && x.element?.line === 55)!;
    expect(delta.element).toEqual({ file: "fixtures/bootstrap/dashboard.html", line: 55, tag: "span", classes: ["stat-delta", "text-success"], text: "+4.2% on last week" });
    // The message names the element, not a generated id; the Cadesa path is kept for tools.
    expect(delta.message).toMatch(/^<span\.stat-delta\.text-success> text #198754 on #f4f6f9/);
    expect(delta.path).toBe("text.stat-delta.color");
    const color = delta.source!.find((s) => s.what === "color")!.rules;
    expect(color[0]).toMatchObject({ property: "color", selector: ".text-success", file: "fixtures/bootstrap/bootstrap.css", line: 8503, origin: "stylesheet" });
    expect(color).toContainEqual(expect.objectContaining({ property: "--bs-success-rgb", selector: ":root", value: "25, 135, 84" }));
    const bg = delta.source!.find((s) => s.what.startsWith("background"))!.rules;
    expect(bg).toContainEqual(expect.objectContaining({ property: "--bs-body-bg", file: "fixtures/bootstrap/app.css", line: 8, value: "#f4f6f9" }));
    expect(r.text).toContain("elements: fixtures/bootstrap/dashboard.html:55 <span class=\"stat-delta text-success\"> \"+4.2% on last week\"");
    expect(r.text).toMatch(/· on 2 elements/);
    expect(r.text).toContain("fixtures/bootstrap/bootstrap.css:8503 .text-success { color: rgba(var(--bs-success-rgb), var(--bs-text-opacity)); --bs-text-opacity: 1 }");
    expect(r.text).not.toMatch(/edit: (styles|text)\./);
  });

  it("names the variable a button's colour comes from", () => {
    const { f } = findings("fixtures/bootstrap/orders.html", BS);
    const prev = f.find((x) => x.element?.text === "Previous")!;
    expect(prev.element).toMatchObject({ line: 63, tag: "button", classes: ["btn", "btn-sm", "btn-outline-secondary"] });
    expect(prev.source![0].rules.map((r) => `${r.selector} ${r.property}`)).toEqual([".btn color", ".btn-outline-secondary --bs-btn-color"]);
  });

  it("points a tap target at the width and height that size it", () => {
    const { r, f } = findings("fixtures/css/panel.html", "fixtures/css/panel.css");
    const tap = f.find((x) => x.check === "tap-target")!;
    expect(tap.element).toMatchObject({ file: "fixtures/css/panel.html", line: 21, tag: "button", classes: ["icon-button"], text: "×" });
    expect(tap.source).toEqual([
      {
        what: "size",
        rules: [
          { property: "width", value: "32px", selector: ".icon-button", file: "fixtures/css/panel.css", line: 48, origin: "stylesheet" },
          { property: "height", value: "32px", selector: ".icon-button", file: "fixtures/css/panel.css", line: 48, origin: "stylesheet" },
        ],
      },
    ]);
    expect(r.text).toContain("size: fixtures/css/panel.css:48 .icon-button { width: 32px; height: 32px }");
  });

  it("points an overflow at the child's rule", () => {
    const { r, f } = findings("fixtures/verify/page.html", "fixtures/verify/page.css", "400");
    const over = f.find((x) => /overflows/.test(x.message))!;
    expect(over.message).toBe("<div.wide> overflows <div.box> by 100px at 400px");
    expect(over.source).toEqual([{ what: "set on <div.wide>", rules: [expect.objectContaining({ property: "width", value: "400px", selector: ".wide", line: 52 })] }]);
    expect(r.text).toContain("set on <div.wide>: fixtures/verify/page.css:52 .wide { width: 400px }");
  });

  it("keeps the YAML path for a Cadesa source", () => {
    const r = checkCmd({ source: "settings.cadesa.yaml", fixture: "fixtures/settings-long.html", widths: [390] });
    for (const f of (r.data as { findings: Finding[] }).findings) expect(f.element).toBeUndefined();
  });
});

describe("verify: reading findings and serving the page", () => {
  it("knows what to measure for each kind of finding", () => {
    const f = (check: Finding["check"], message: string, id = "a") => ({ check, message, id, width: 400, severity: "warning" }) as Finding;
    expect(probeOf(f("tap-target", "x"))).toEqual({ kind: "tap", id: "a" });
    expect(probeOf(f("layout", "#kid overflows #a by 3px at 400px"))).toEqual({ kind: "overflow", id: "a", child: "kid" });
    expect(probeOf(f("layout", '"Pneumono" in #a can\'t wrap and overflows by 3px at 400px'))).toEqual({ kind: "wrap", id: "a" });
    expect(probeOf(f("layout", "content of #a needs 60px but its height is 44px at 400px"))).toEqual({ kind: "height", id: "a" });
    expect(probeOf(f("layout", "#a has loose text"))).toBeUndefined();
  });

  it("serves the page with the given stylesheets where it links them, and no scripts", () => {
    const html = `<html><head><link rel="stylesheet" href="https://cdn.example/dist/bootstrap.min.css?v=3"><link rel="icon" href="x.ico"></head><body><script>alert(1)</script><p>x</p></body></html>`;
    const out = pageForBrowser(html, "site/page.html", ["vendor/bootstrap.min.css", "site/app.css"]);
    expect(out).toContain('<link rel="stylesheet" href="../vendor/bootstrap.min.css">');
    expect(out).toContain('<head><link rel="stylesheet" href="app.css">');
    expect(out).toContain('<link rel="icon" href="x.ico">');
    expect(out).not.toContain("<script");
  });
});
