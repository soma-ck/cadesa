/** --css <dir>: a directory of stylesheets, read in name order (what capture writes). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCmd, cssList, InputError, renderCmd, whatifCmd } from "../src/commands.js";

const dir = mkdtempSync(join(tmpdir(), "cadesa-cssdir-"));
const css = join(dir, "css");
mkdirSync(css);
writeFileSync(join(css, "10-app.css"), ".box { padding: 8px; color: #999; background: #fff }\n");
writeFileSync(join(css, "2-base.css"), "body { margin: 0; font-family: Inter; font-size: 16px; line-height: 24px; background: #fff } .box { padding: 4px }\n");
writeFileSync(join(css, "notes.txt"), "not a stylesheet\n");
const page = join(dir, "page.html");
writeFileSync(page, `<!doctype html>\n<html>\n<head><link rel="stylesheet" href="css/2-base.css"><link rel="stylesheet" href="css/10-app.css"></head>\n<body>\n<p class="box">Muted text</p>\n</body>\n</html>\n`);

describe("--css <dir>", () => {
  it("lists the directory's stylesheets in name order, numbers by value", () => {
    expect(cssList(css)).toEqual([join(css, "2-base.css"), join(css, "10-app.css")]);
    expect(cssList(`${join(css, "2-base.css")}, ${join(css, "10-app.css")}`)).toEqual([join(css, "2-base.css"), join(css, "10-app.css")]);
  });

  it("says when a directory has no stylesheets", () => {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(() => cssList(empty)).toThrow(InputError);
  });

  it("works for check, render and whatif", () => {
    const c = checkCmd({ fixture: page, css, widths: [400] });
    expect(c.text).toMatch(/\[contrast\] <p\.box> text #999/);
    expect(c.text).toContain("10-app.css:1 .box { color: #999 }");
    const r = renderCmd({ fixture: page, css, widths: [400] });
    expect(r.text).toContain("padding 8px");
    const w = whatifCmd({ fixture: page, css, widths: [400], changes: [], addCss: ".box { color: #333 }" });
    expect(w.text).toMatch(/✓ fixed +\[contrast\]/);
  });
});
