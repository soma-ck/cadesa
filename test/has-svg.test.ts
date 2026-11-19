/** :has() on a page with svg icons: the icons' insides aren't laid out, but they can still rule a match out. */
import { describe, expect, it } from "vitest";
import { liftCssPage } from "../src/lift/css-page.js";

const page = (svg: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="a.css"></head><body><main>${svg}<p class="t">Hello world</p></main></body></html>`;
const css = `body{margin:0;font:16px/24px Inter}\n:is(html:has([data-x]),body:has([data-x])){overflow:hidden}\n.t{margin:0}`;
const undecided = (html: string) => liftCssPage("p.html", html, [{ file: "a.css", text: css }]).lifted.unlifted.filter((u) => /may match/.test(u.reason));

describe(":has() past svg icons", () => {
  it("is decided when nothing inside the svg has what the selector needs", () => {
    expect(undecided(page('<svg width="16" height="16"><path d="M0 0h16v16z"/></svg>'))).toEqual([]);
  });
  it("stays undecided when something inside the svg could match", () => {
    expect(undecided(page('<svg width="16" height="16"><g data-x="1"><path d="M0 0h16v16z"/></g></svg>')).length).toBeGreaterThan(0);
  });
});

describe("page-level values that move nothing, and env()", () => {
  it("color-scheme on <html> leaves the page exact; env() resolves as in a desktop window", async () => {
    const { resolveEnv } = await import("../src/tailwind/values.js");
    expect(resolveEnv("calc(env(safe-area-inset-top, 20px) + 10px)")).toBe("calc(0px + 10px)");
    expect(resolveEnv("env(titlebar-area-height, 4px)")).toBe("4px");
    const t = liftCssPage(
      "p.html",
      '<!doctype html><html style="color-scheme: dark"><head><link rel="stylesheet" href="a.css"></head><body><div class="bar"></div><p class="t">Hi</p></body></html>',
      [{ file: "a.css", text: ":root{--top:env(safe-area-inset-top,0px)}\nbody{margin:0;font:16px/24px Inter}\n.bar{height:calc(var(--top) + 10px)}\n.t{margin:0}" }],
    );
    expect(t.lifted.unlifted.filter((u) => u.kind === "geometry" || u.kind === "text")).toEqual([]);
  });
});
