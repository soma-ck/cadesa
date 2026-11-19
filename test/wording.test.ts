/** On --css pages the report speaks CSS: a page without a background is white, and no Cadesa paths. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCmd, renderCmd } from "../src/commands.js";

const dir = mkdtempSync(join(tmpdir(), "cadesa-wording-"));
const page = join(dir, "p.html");
const css = join(dir, "p.css");
writeFileSync(page, `<!doctype html>\n<html>\n<body>\n<p class="ok">Readable text</p>\n<p class="faint">Too light</p>\n<div class="box"><div class="wide">Wide</div></div>\n</body>\n</html>\n`);
writeFileSync(css, `body { margin: 0; font-family: Inter; font-size: 16px; line-height: 24px; color: #222 }\np { margin: 0 }\n.faint { color: #aaa }\n.box { width: 100px }\n.wide { width: 200px }\n`);

describe("a page with no background", () => {
  const r = checkCmd({ fixture: page, css, widths: [400] });
  it("is judged on white, as a browser paints it, and says so", () => {
    expect(r.text).toMatch(/✖ \[contrast\] <p\.faint> text #aaaaaa on #ffffff is 2\.32:1/);
    expect(r.text).toContain("background: browser default: none set, so the page is white { background-color: #ffffff }");
    expect(r.text).not.toMatch(/\[contrast\] <p\.ok>/);
  });
  it("is not inconclusive, and gives no Cadesa advice", () => {
    expect(r.text).not.toContain("inconclusive");
    expect(r.text).not.toContain("page.background");
    expect(r.text).not.toMatch(/edit: (styles|text|page)\./);
  });
});

describe("render on a --css page", () => {
  it("names no path in the generated Cadesa source", () => {
    const r = renderCmd({ fixture: page, css, widths: [400] });
    expect(r.text).toContain("overflows");
    expect(r.text).not.toMatch(/edit: /);
  });
});
