import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { walk } from "../src/engine/layout.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";
import { parseMediaQuery, parseTailwindCss, unescapeIdent } from "../src/tailwind/css.js";
import { liftTailwind, longhands, stateAt, statesFor } from "../src/tailwind/lift.js";
import { parseColor, hexOf, simplify, substitute } from "../src/tailwind/values.js";

const CSS_FILE = "fixtures/tailwind/compiled.css";
const CSS = readFileSync(CSS_FILE, "utf8");
const page = (body: string, bodyClass = "") => `<!doctype html><html><head></head><body class="${bodyClass}">\n${body}\n</body></html>`;
const tw = (html: string, css = CSS) => liftTailwind("page.html", html, CSS_FILE, css);
type Data = { tokens: Record<string, Record<string, string>>; text: Record<string, Record<string, unknown>>; styles: Record<string, Record<string, unknown>>; breakpoints?: Record<string, string> };
const data = (t: ReturnType<typeof tw>) => t.lifted.data as unknown as Data;
const boxAt = (t: ReturnType<typeof tw>, width: number) => {
  const model = modelOf(loadSource("t", t.yaml));
  const l = render(model, t.fixtureAt(width), [width])[0];
  return { layout: l, byId: new Map([...walk(l.boxes)].map((b) => [b.id, b])) };
};

describe("breakpoints: mobile-first → desktop-first", () => {
  it("turns min-width thresholds into max-width states just below each one", () => {
    const names = new Map([[640, "sm"], [768, "md"], [1024, "lg"]]);
    const st = statesFor([768, 1024, 640, 768], names);
    expect(st.map((s) => [s.lo, s.hi, s.name, s.raw])).toEqual([
      [1024, Infinity, undefined, undefined],
      [768, 1024, "below-lg", "63.99rem"],
      [640, 768, "below-md", "47.99rem"],
      [0, 640, "below-sm", "39.99rem"],
    ]);
    expect(st[1].key).toBeCloseTo(1023.84);
    expect(stateAt(st, 767).name).toBe("below-md");
    expect(stateAt(st, 768).name).toBe("below-lg");
    expect(stateAt(st, 1440).key).toBe(Infinity);
  });

  it("reads v4 range media queries and the variants it can't model", () => {
    expect(parseMediaQuery("(width >= 48rem)").widths).toEqual([{ op: "ge", px: 768, raw: "48rem" }]);
    expect(parseMediaQuery("(width < 40rem)").widths).toEqual([{ op: "lt", px: 640, raw: "40rem" }]);
    expect(parseMediaQuery("(min-width: 1024px)").widths).toEqual([{ op: "ge", px: 1024, raw: "1024px" }]);
    expect(parseMediaQuery("(hover: hover)").env).toBe(true);
    expect(parseMediaQuery("(prefers-color-scheme: dark)")).toMatchObject({ env: false, dark: true });
    expect(parseMediaQuery("(orientation: portrait)").env).toEqual({ unknown: "@media (orientation: portrait)" });
  });

  it("emits one when override per range, named after the Tailwind breakpoint", () => {
    const t = tw(page(`<div class="mx-auto max-w-7xl px-6 lg:px-8"><p class="text-sm/6">Hello</p></div>`));
    const d = data(t);
    expect(d.breakpoints).toEqual({ "below-lg": "63.99rem" });
    expect(d.styles.div).toMatchObject({ padding: { inline: "spacing-8" }, maxWidth: "container-7xl", when: { "below-lg": { padding: { inline: "spacing-6" } } } });
    expect(d.tokens.size["container-7xl"]).toBe("1280px");
  });
});

describe("utility mapping", () => {
  it("resolves theme variables, calc() and oklch() colors", () => {
    const css = parseTailwindCss(CSS_FILE, CSS);
    expect(css.preflight).toBe(true);
    expect(css.byClass.get("md:block")?.[0].media[0].widths[0].px).toBe(768);
    expect(unescapeIdent("sm\\:text-4xl\\/tight")).toBe("sm:text-4xl/tight");
    const look = (n: string) => css.theme.get(n);
    expect(simplify(substitute("calc(var(--spacing) * 3.5)", look))).toBe("14px");
    expect(hexOf(parseColor(substitute("var(--color-indigo-600)", look))!)).toBe("#4f39f6");
    expect(hexOf(parseColor("color-mix(in oklab, oklch(51.1% 0.262 276.966) 10%, transparent)")!)).toMatch(/^#[0-9a-f]{6}1a$/);
  });

  it("expands shorthands and logical properties", () => {
    expect(longhands("padding-inline", "24px")).toEqual([["padding-left", "24px"], ["padding-right", "24px"]]);
    expect(longhands("border-block-end-width", "1px")).toEqual([["border-bottom-width", "1px"]]);
    expect(longhands("gap", "8px 16px")).toEqual([["row-gap", "8px"], ["column-gap", "16px"]]);
    expect(longhands("border-radius", "calc(infinity * 1px)")).toEqual([["border-radius", "calc(infinity * 1px)"]]);
  });

  it("gives text boxes their full inherited text style", () => {
    const t = tw(page(`<div class="text-sm/6 font-semibold tracking-wide text-indigo-600 uppercase"><p>Release 2.0</p></div>`, "text-gray-900"));
    const d = data(t);
    const role = d.text[(d.styles.div.slots as Record<string, { text: string }>).p.text];
    expect(role).toMatchObject({ font: "sans", size: "14px", weight: 600, color: "indigo-600", transform: "uppercase" });
    expect(role.lineHeight).toBeCloseTo(24 / 14, 5);
    expect(role.letterSpacing).toBeCloseTo(0.025, 6);
    expect(d.tokens.font.sans).toMatch(/^"Inter"/);
  });

  it("maps block flow to a stack, flex-col to a stack and flex-wrap rows to clusters", () => {
    const t = tw(page(`<section><div class="flex flex-col gap-4"><p>a</p><p>b</p></div><div class="flex flex-wrap gap-x-4"><a>x</a><a>y</a></div></section>`));
    const s = data(t).styles.section;
    expect(s.layout).toEqual({ pattern: "stack" });
    const slots = s.slots as Record<string, { layout?: unknown }>;
    expect(slots.div.layout).toEqual({ pattern: "stack", gap: "spacing-4" });
    expect(slots["div-2"].layout).toMatchObject({ pattern: "cluster", gap: "spacing-4" });
  });

  it("emulates grid-cols-<n> exactly where the column count can't change, and checks every width", () => {
    const t = tw(page(`<div class="mx-auto max-w-7xl px-6 lg:px-8"><div class="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3"><p>a</p><p>b</p><p>c</p></div></div>`));
    for (const [w, cols] of [[390, 1], [700, 2], [900, 2], [1100, 3], [1440, 3]] as const) {
      const { layout, byId } = boxAt(t, w);
      const xs = new Set(["p", "p-2", "p-3"].map((id) => Math.round(byId.get(id)!.x)));
      expect(xs.size, `${w}px`).toBe(cols);
      expect(t.dynamic(layout)).toEqual([]);
    }
  });

  it("lays out responsive display: none only where the element is shown", () => {
    const t = tw(page(`<nav class="flex items-center gap-x-8"><a class="text-sm/6">Logo</a><a class="hidden text-sm/6 md:block">Docs</a></nav>`));
    expect(boxAt(t, 390).byId.has("a-2")).toBe(false);
    expect(boxAt(t, 1280).byId.has("a-2")).toBe(true);
    expect(t.responsive).toEqual(["a-2"]);
  });

  it("records what it can't model, with a kind, against the element", () => {
    const t = tw(page(`<div class="flex items-center justify-between"><a class="text-sm/6 hover:text-gray-900">a</a><p class="rounded-full bg-indigo-600/10 text-xs/5">b</p></div><p class="text-lg/8 dark:bg-black">c</p>`), CSS + "\n@layer utilities { @media (prefers-color-scheme: dark) { .dark\\:bg-black { background-color: #000; } } }\n");
    const u = t.lifted.unlifted;
    expect(u.find((x) => x.decl?.startsWith("hover:text-gray-900"))?.kind).toBe("state");
    expect(u.find((x) => x.decl?.startsWith("justify-between"))).toMatchObject({ kind: "visual", className: "ca-div__a" });
    expect(u.find((x) => x.decl === "dark:bg-black")?.kind).toBe("none");
  });

  it("flags a non-wrapping flex row only at widths where it would wrap", () => {
    const t = tw(page(`<div class="flex gap-x-4"><span class="text-base/6">Northwind warehouse dashboard</span><span class="text-base/6">Operators actually open it</span></div>`));
    expect(t.dynamic(boxAt(t, 1280).layout)).toEqual([]);
    expect(t.dynamic(boxAt(t, 320).layout).map((u) => u.kind)).toEqual(["geometry"]);
  });

  it("adds generated classes and ids without touching the original markup", () => {
    const html = page(`<main class="px-6"><h1 data-fixture="title" class="text-lg/7">Hi</h1></main>`);
    const t = tw(html);
    expect(t.html).toContain(`<main data-fixture="main" class="px-6 ca-main">`);
    expect(t.html).toContain(`<h1 data-fixture="title" class="text-lg/7 ca-main__title">`);
    expect(t.html.replace(/ data-fixture="main"| ca-main__title| ca-main/g, "")).toBe(html);
  });
});
