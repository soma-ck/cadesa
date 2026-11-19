/** The coverage line counts the elements a browser shows that Cadesa didn't lay out. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCmd } from "../src/commands.js";
import type { Coverage } from "../src/report.js";
import { formatCoverage } from "../src/report.js";

const dir = mkdtempSync(join(tmpdir(), "cadesa-laidout-"));
const page = join(dir, "p.html");
const css = join(dir, "p.css");
writeFileSync(
  page,
  `<!doctype html>
<html>
<body>
<main class="page">
<p class="lead">Some <b>bold</b> text</p>
<table class="t"><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>
<div class="pop"><p>Floating</p><p>Panel</p></div>
<div class="gone"><p>Hidden</p></div>
<select><option>One</option><option>Two</option></select>
</main>
</body>
</html>
`,
);
writeFileSync(css, `body { margin: 0; font-family: Inter; font-size: 16px; line-height: 24px; background: #fff; color: #222 }\np { margin: 0 }\n.t { width: 200px }\n.t tr + tr { visibility: collapse }\n.pop { position: absolute; top: 0 }\n.gone { display: none }\n`);

describe("elements not laid out", () => {
  it("counts table contents and out-of-flow elements, not inline text, form internals or hidden ones", () => {
    const r = checkCmd({ fixture: page, css, widths: [400] });
    const nl = (r.data as { coverage: Coverage }).coverage.notLaidOut!;
    // tbody, 2 tr, 4 td inside the table, which is one box (a collapsed row isn't modelled); the
    // absolute panel is laid out in the window.
    expect(nl.causes).toEqual([{ cause: "inside a table, laid out as one box", count: 7 }]);
    expect(nl.count).toBe(7);
    expect(r.text).toMatch(/! 7 of \d+ elements not laid out: inside a table, laid out as one box \(×7\);/);
  });

  it("says so first when most of the page isn't laid out", () => {
    const c: Coverage = { widths: 1, boxes: 45, exact: 45, approximate: 0, reasons: [], notLaidOut: { count: 715, total: 760, width: 400, causes: [{ cause: "out of flow: position absolute or fixed, or a float", count: 715 }] } };
    const text = formatCoverage(c);
    expect(text).toContain("! 715 of 760 elements not laid out");
    expect(text).toContain("→ most of this page's elements aren't laid out");
  });
});
