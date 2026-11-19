/** whatif runs check before and after the edit, and says when an added CSS rule didn't apply. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/check.js";
import { lastInCascade, whatifCmd } from "../src/commands.js";
import { compareFindings } from "../src/whatif-check.js";

const dir = mkdtempSync(join(tmpdir(), "cadesa-whatif-"));
const page = join(dir, "w.html");
const css = join(dir, "w.css");
writeFileSync(
  page,
  `<!doctype html>
<html>
<head><link rel="stylesheet" href="w.css"></head>
<body>
<div class="bar">
<button class="x">Go</button>
<button class="y">Stop</button>
</div>
<div class="row"><p class="col">A card with some text</p></div>
</body>
</html>
`,
);
writeFileSync(
  css,
  `body { margin: 0; font-family: Inter; font-size: 16px; line-height: 24px; background: #fff; color: #222 }
.bar { display: flex; gap: 8px; padding: 8px; align-items: flex-start }
.x { width: 60px; height: 20px; padding: 0; border: 0; font-size: 12px; line-height: 16px; background: #eee; color: #222 }
.bar .y { width: 60px; height: 20px; padding: 0; border: 0; font-size: 12px; line-height: 16px; background: #eee; color: #222 }
.row { margin: 0 -12px }
.col { margin: 0; padding: 0 12px }
`,
);

const f = (o: Partial<Finding>): Finding => ({ check: "tap-target", width: 400, severity: "error", id: "x", path: "", message: "#x is 60×20px; WCAG 2.5.8 needs at least 24×24px", ...o }) as Finding;

describe("compareFindings", () => {
  it("tells fixed, still there (with the old numbers) and new apart, across widths", () => {
    const before = [f({}), f({ width: 800 }), f({ id: "y", message: "#y is 60×20px; WCAG 2.5.8 needs at least 24×24px" })];
    const after = [
      f({ message: "#x is 60×23.98px; WCAG 2.5.8 needs at least 24×24px" }),
      f({ width: 800, message: "#x is 60×23.98px; WCAG 2.5.8 needs at least 24×24px" }),
      f({ id: "z", check: "contrast", message: "#z text #999 on #fff is 2.85:1; WCAG AA needs 4.5:1" }),
    ];
    const c = compareFindings(before, after);
    expect(c.map((x) => [x.status, x.finding.id, x.widths])).toEqual([
      ["new", "z", [400]],
      ["still", "x", [400, 800]],
      ["fixed", "y", [400]],
    ]);
    expect(c[1].was?.message).toMatch(/60×20px/);
  });
});

describe("whatif --add-css", () => {
  it("says a finding is still there when the fix falls short", () => {
    const r = whatifCmd({ fixture: page, css, widths: [400], changes: [], addCss: ".x { height: 23.98px }" });
    expect(r.text).toMatch(/check, before → after the edit: \d+ fixed, \d+ still there/);
    expect(r.text).toMatch(/still +\[tap-target\] <button\.x> is 60×23\.9\dpx; WCAG 2\.5\.8 needs at least 24×24px/);
    expect(r.text).toMatch(/before the edit: <button\.x> is 60×20px/);
  });

  it("says a finding is fixed", () => {
    const r = whatifCmd({ fixture: page, css, widths: [400], changes: [], addCss: ".x { height: 24px }" });
    expect(r.text).toMatch(/✓ fixed +\[tap-target\] <button\.x> is 60×20px/);
    const data = r.data as { findings: { status: string; id: string }[] };
    expect(data.findings.some((x) => x.status === "fixed" && x.id === "x")).toBe(true);
  });

  it("reports a rule that loses to a more specific one, and one that matches nothing", () => {
    const r = whatifCmd({ fixture: page, css, widths: [400], changes: [], addCss: ".y { height: 44px } .nope { color: red }" });
    expect(r.text).toContain("✖ your rule didn't apply: .bar .y { … } at w.css:4 is more specific (0,2,0 vs your 0,1,0)");
    expect(r.text).toContain(".y { height: 44px } loses height on <button.y>");
    expect(r.text).toContain("✖ your rule didn't apply: .nope { color: red } matches no element on the page");
  });

  it("says nothing about a rule that applies", () => {
    const r = whatifCmd({ fixture: page, css, widths: [400], changes: [], addCss: ".bar .y { height: 44px }" });
    expect(r.text).not.toContain("didn't apply");
  });

  it("shows a removed declaration as its initial value, not unset", () => {
    const edited = join(dir, "w.new.css");
    writeFileSync(edited, `body { margin: 0; font-family: Inter; font-size: 16px; line-height: 24px; background: #fff; color: #222 }\n.bar { display: flex; gap: 8px; padding: 8px; align-items: flex-start }\n.row { }\n`);
    const r = whatifCmd({ fixture: page, css, widths: [400], changes: [], after: edited });
    expect(r.text).toMatch(/margin 0px -12px → 0px/);
    expect(r.text).not.toMatch(/→ unset/);
  });
});

describe("lastInCascade", () => {
  it("is the file the page links last, whatever the --css order", () => {
    const html = '<link rel="stylesheet" href="css/app.css"><link rel="stylesheet" href="vendor/theme.css">';
    expect(lastInCascade(html, ["theme.css", "app.css"])).toBe(0);
    expect(lastInCascade(html, ["app.css", "theme.css"])).toBe(1);
  });
  it("is the last given file when the page links none of them", () => {
    expect(lastInCascade("<p>x</p>", ["a.css", "b.css"])).toBe(1);
  });
});
