/** Regressions from a field report on 0.1.8: multi-line values, renamed stylesheets, inline-run verify, grouping. */
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/check.js";
import { cssValue } from "../src/lift/css.js";
import { liftCssPage } from "../src/lift/css-page.js";
import { loadSource } from "../src/load.js";
import { modelOf } from "../src/project.js";
import { formatCheck } from "../src/report.js";
import { pageForBrowser, probeOf } from "../src/verify.js";

const html = (links: string[]) =>
  `<!doctype html><html><head>${links.map((h) => `<link rel="stylesheet" href="${h}">`).join("")}</head><body><p class="box">Hello</p></body></html>`;

describe("CSS values over several lines", () => {
  it("reads them as one line, keeping quoted text", () => {
    expect(cssValue('\n    system-ui,\n    -apple-system,\n    "Segoe  UI"')).toBe('system-ui, -apple-system, "Segoe  UI"');
  });

  it("lifts unminified CSS to a valid source", () => {
    const css = `body { margin: 0; font-family:\n    system-ui,\n    -apple-system,\n    "Segoe UI";\n  line-height: 1.5 }\n.box {\n  padding:\n    8px\n    16px;\n}`;
    const t = liftCssPage("t.html", html(["t.css"]), [{ file: "t.css", text: css }]);
    expect(() => modelOf(loadSource("t", t.yaml))).not.toThrow();
    expect(t.yaml.split("\n").filter((l) => l.trim() && !/^\s*(#|[\w-]+:|[{}\]]|- )/.test(l) && !/^\s+["\w-]/.test(l))).toEqual([]);
  });
});

describe("stylesheets given under other names", () => {
  it("uses them where the page links the originals, in order, and says so", () => {
    const t = liftCssPage("t.html", html(["css/01-base.css", "css/02-app.css"]), [
      { file: "base-flat.css", text: ".box { padding: 4px }" },
      { file: "app-flat.css", text: ".box { padding: 8px }" },
    ]);
    expect(t.notes).toEqual([
      "used base-flat.css where the page links css/01-base.css (no --css file has that name; given in the same order)",
      "used app-flat.css where the page links css/02-app.css (no --css file has that name; given in the same order)",
    ]);
    expect(t.lifted.unlifted.some((u) => /isn't among the --css files/.test(u.reason))).toBe(false);
  });

  it("names a linked stylesheet that wasn't given", () => {
    const t = liftCssPage("t.html", html(["css/01-base.css", "css/02-app.css"]), [{ file: "css/02-app.css", text: ".box { padding: 8px }" }]);
    expect(t.notes).toEqual([]);
    const u = t.lifted.unlifted.find((x) => /isn't among the --css files/.test(x.reason))!;
    expect(JSON.stringify(u)).toContain("css/01-base.css");
  });

  it("serves them to Chromium in the linked places", () => {
    const out = pageForBrowser(html(["css/01-base.css", "css/02-app.css"]), "t.html", ["base-flat.css", "app-flat.css"]);
    expect(out.match(/href="[^"]*"/g)).toEqual(['href="base-flat.css"', 'href="app-flat.css"']);
  });
});

describe("--verify on inline runs", () => {
  it("finds a link inside a text box by its tag and text", () => {
    const f = { check: "contrast", id: "card-meta", width: 400, severity: "error", message: '"Apply now" (<a> in <p.meta>) text #0d6efd on #f4f6f9 is 4.16:1; WCAG AA needs 4.5:1' } as Finding;
    expect(probeOf(f)).toEqual({ kind: "contrast", id: "card-meta", run: { tag: "a", text: "Apply now" } });
  });
});

describe("check output", () => {
  it("lists one issue on several elements once", () => {
    const rule = { what: "color", rules: [{ file: "app.css", line: 3, selector: ".step", decls: "color: #999" }] };
    const mk = (n: number): Finding =>
      ({
        check: "contrast",
        id: `step-${n}`,
        width: 400,
        severity: "error",
        message: `<span.step> text #999999 on #ffffff is 2.85:1; WCAG AA needs 4.5:1`,
        element: { file: "p.html", line: 10 + n, tag: "span", classes: ["step"], text: `${n}` },
        source: [rule],
      }) as unknown as Finding;
    const text = formatCheck([1, 2, 3, 4, 5, 6].map(mk), [400]);
    expect(text).toContain("· on 6 elements");
    expect(text).toContain("1 error, 0 warnings");
    expect(text.match(/p\.html:1\d/g)).toHaveLength(6);
  });
});
