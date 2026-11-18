import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { compile } from "../src/compile.js";
import { walk, type Layout } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { impact } from "../src/lift/impact.js";
import { kindOf, lift } from "../src/lift/lift.js";
import { classify, locate, match } from "../src/lift/selectors.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";
import { validate } from "../src/validate.js";

const geometry = (ls: Layout[]) =>
  ls.map((l) => [...walk(l.boxes)].map((b) => [b.id, +b.x.toFixed(4), +b.y.toFixed(4), +b.w.toFixed(4), +b.h.toFixed(4), b.lines?.length]));

describe("lift(build(source)) round trip", () => {
  const source = loadSource("settings.cadesa.yaml", readFileSync("settings.cadesa.yaml", "utf8"));
  const original = modelOf(source);
  const lifted = lift("dist/settings.css", compile(original));
  const relifted = modelOf(loadSource("lifted.cadesa.yaml", lifted.yaml));
  const widths = Array.from({ length: 49 }, (_, i) => 280 + i * 20);

  it("lifts every declaration Cadesa emits", () => {
    expect(lifted.unlifted).toEqual([]);
    expect(lifted.stats.unlifted).toBe(0);
    expect(lifted.prefix).toBe("ca-");
  });

  it("recovers token names from custom properties, and the intent from the comment", () => {
    expect(lifted.data.tokens).toEqual(validate(source).model && (source.data as Record<string, unknown>).tokens);
    expect((lifted.data.styles as Record<string, { intent: string }>)["settings-panel"].intent).toBe(
      "Give the heading and save action the strongest visual hierarchy.",
    );
  });

  for (const f of ["fixtures/settings.html", "fixtures/settings-long.html"])
    it(`lays out ${f} identically at 49 widths`, () => {
      const fx = parseFixture(f);
      expect(geometry(render(relifted, fx, widths))).toEqual(geometry(render(original, fx, widths)));
    });

  it("compiles back to CSS that lifts to the same source (fixed point)", () => {
    expect(lift("x.css", compile(relifted)).yaml.replace(/^#.*\n/, "")).toBe(lifted.yaml.replace(/^#.*\n/, ""));
  });
});

describe("lift of hand-written CSS", () => {
  const r = lift("fixtures/legacy.css", readFileSync("fixtures/legacy.css", "utf8"));
  const fixture = parseFixture("fixtures/legacy.html");
  const model = modelOf(loadSource("legacy (lifted)", r.yaml));
  const layouts = render(model, fixture, [390, 768, 1280]);
  const [narrow, mid, wide] = impact(r, fixture, layouts);

  it("produces a valid source with no prefix, inferred tokens and var() names", () => {
    expect(validate(loadSource("x", r.yaml)).diagnostics).toEqual([]);
    expect(r.prefix).toBe("");
    const tokens = r.data.tokens as Record<string, Record<string, string>>;
    expect(tokens.space.gap).toBe("16px");
    expect(tokens.color.brand).toBe("#2f5bea");
    expect(tokens.radius["px-0"]).toBe("0px");
    expect(compile(model)).toContain(".profile-card .profile-card__name {");
  });

  it("reports what it could not lift, classified by what it can affect", () => {
    expect(r.unlifted.map((u) => [u.line, u.kind])).toEqual([
      // cursor: no effect on boxes or contrast.
      [50, "none"],
      [50, "none"],
      [59, "state"],
      [78, "geometry"],
      [106, "geometry"],
    ]);
    expect(r.stats).toMatchObject({ declarations: 54, unlifted: 5, components: 1, breakpoints: 1 });
  });

  it("marks only the boxes an unlifted rule or browser default can move", () => {
    expect(narrow.exact).toEqual(["name", "bio", "actions", "follow", "message"]);
    expect(narrow.uncertain.map((u) => u.id)).toEqual(["card", "meta", "badge"]);
    expect(narrow.uncertain.find((u) => u.id === "meta")!.reasons[0]).toMatch(/<p> keeps the browser's default margin/);
    expect(narrow.uncertain.find((u) => u.id === "badge")!.reasons).toContain(
      "fixtures/legacy.css:78 position: absolute: position: absolute takes the box out of normal flow",
    );
    expect(narrow.noEffect).toEqual(["fixtures/legacy.css:59 background: #1d4ed8: interactive state; the default state is unaffected"]);
    expect(mid.exact).toEqual(narrow.exact);
  });

  it("scopes a min-width rule to the widths it applies at", () => {
    expect(wide.exact).toEqual([]);
    expect(wide.uncertain.find((u) => u.id === "name")!.reasons[0]).toMatch(/legacy\.css:106 max-width: 560px/);
  });

  it("keeps contrast conclusive when only geometry is uncertain", () => {
    const html = '<article class="profile-card"><p class="profile-card__meta" data-fixture="m">x</p></article>';
    const css = ".profile-card{display:flex;flex-direction:column;background:#fff}.profile-card__meta{font:400 13px/18px Inter;color:#bbbbbb}";
    const rr = lift("t.css", css);
    const fx = parseFixture("t.html", html);
    const ls = render(modelOf(loadSource("t", rr.yaml)), fx, [390]);
    const [f] = check(ls, impact(rr, fx, ls)).filter((x) => x.check === "contrast");
    expect(f.inconclusive).toBeFalsy();
    expect(f.severity).toBe("error");
  });
});

describe("lift details", () => {
  const one = (css: string) => lift("t.css", css);
  const style = (r: ReturnType<typeof lift>, c: string) => (r.data.styles as Record<string, Record<string, unknown>>)[c];

  it("resolves the cascade by specificity, then source order", () => {
    const r = one(".c .c__a{padding:8px} .c__a{padding:4px} .c{display:flex;flex-direction:column}");
    expect((style(r, "c").slots as Record<string, Record<string, unknown>>).a.padding).toBe("px-8");
  });

  it("merges a media query with the base rules before diffing", () => {
    const r = one(".c{display:flex;flex-wrap:wrap;align-items:center;gap:8px} @media (max-width: 40em){.c{flex-direction:column;align-items:stretch}}");
    expect(style(r, "c").layout).toEqual({ pattern: "cluster", gap: "px-8" });
    expect(style(r, "c").when).toEqual({ "max-40em": { layout: { pattern: "stack", gap: "px-8" } } });
    expect(r.unlifted).toEqual([]);
  });

  it("flags flex settings Cadesa can't express, and lifts the ones it can", () => {
    const r = one(".c{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap}");
    expect(r.unlifted.map((u) => u.decl)).toEqual([]);
    expect(style(r, "c").layout).toEqual({ pattern: "cluster", align: "end", justify: "between" });
    expect(one(".c{display:flex;flex-wrap:wrap;justify-content:stretch}").unlifted.map((u) => u.decl)).toEqual(["justify-content: stretch"]);
    expect(one(".c{display:flex;flex-wrap:wrap;align-items:baseline}").unlifted.map((u) => u.decl)).toEqual(["align-items: baseline"]);
  });

  it("converts rgb() and px line heights, and lifts asymmetric padding per side", () => {
    const r = one(".c__t{font-size:16px;line-height:24px;color:rgb(17, 24, 39)} .c__p{padding:1px 2px 3px 2px}");
    expect(r.data.text).toEqual({ t: { size: "16px", weight: 400, lineHeight: 1.5, color: "hex-111827" } });
    expect(r.unlifted).toEqual([]);
    expect((style(r, "c") as { slots: Record<string, unknown> }).slots.p).toEqual({ padding: { top: "px-1", bottom: "px-3", inline: "px-2" } });
  });

  it("classifies properties by what they can affect", () => {
    expect(["color", "box-shadow", "cursor", "transform", "letter-spacing", "margin-top", "min-width", "transition", "text-overflow", "border-top-left-radius", "-webkit-appearance"].map(kindOf)).toEqual([
      "paint",
      "paint",
      "none",
      "visual",
      "text",
      "geometry",
      "geometry",
      "none",
      "none",
      "none",
      "paint",
    ]);
  });
});

describe("selectors", () => {
  it("classifies BEM roots, slots and resets", () => {
    expect(classify(".card")).toEqual({ kind: "root", block: "card" });
    expect(classify(".card__title")).toEqual({ kind: "slot", block: "card", element: "title" });
    expect(classify(".card > .card__title")).toEqual({ kind: "slot", block: "card", element: "title" });
    expect(classify(".card :where(*)")).toEqual({ kind: "reset", block: "card" });
    expect(classify(".other .card__title").kind).toBe("other");
    expect(classify(".card:hover").kind).toBe("other");
  });

  it("matches simple selectors against fixture nodes, flagging interactive states", () => {
    const fx = parseFixture("t.html", '<ul class="list"><li class="item" id="a">1</li><li class="item">2</li></ul>');
    const nodes = locate(fx.body);
    const li = nodes.filter((n) => n.node.tag === "li");
    expect(match(".list > .item:first-child", li[0]).matches).toBe(true);
    expect(match(".list > .item:first-child", li[1]).matches).toBe(false);
    expect(match("#a", li[0]).matches).toBe(true);
    expect(match("li:nth-child(2n)", li[1]).matches).toBe(true);
    expect(match(".item:hover", li[0])).toEqual({ matches: true, state: true, pseudoElement: false });
    expect(match(".item::before", li[0]).pseudoElement).toBe(true);
    expect(match("section .item", li[0]).matches).toBe(false);
  });
});

describe("lift of expressive CSS", () => {
  const one = (css: string) => lift("t.css", css);
  const style = (r: ReturnType<typeof lift>, c: string) => (r.data.styles as Record<string, Record<string, unknown>>)[c];
  const slots = (r: ReturnType<typeof lift>, c: string) => style(r, c).slots as Record<string, Record<string, unknown>>;

  it("lifts an auto-fill grid, aspect-ratio images, gradients and shadows", () => {
    const r = one(`
      .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 24px; align-items: start; }
      .gallery__photo { aspect-ratio: 4 / 3; object-fit: cover; height: auto; box-shadow: 0 4px 12px #0003; }
      .gallery__caption { background: linear-gradient(#0000, #000c); }`);
    expect(r.unlifted).toEqual([]);
    expect(style(r, "gallery").layout).toEqual({ pattern: "grid", min: "px-240", gap: "px-24", align: "start" });
    expect(slots(r, "gallery").photo).toEqual({ shadow: "shadow-1", aspect: "4:3", fit: "cover" });
    expect(slots(r, "gallery").caption).toEqual({ backdrop: "paint-1" });
  });

  it("lifts a layered hero (grid with every child in one cell)", () => {
    const r = one(`.hero { display: grid; align-items: end; } .hero > * { grid-area: 1 / 1; } .hero__art { aspect-ratio: 16 / 9 }`);
    expect(r.unlifted).toEqual([]);
    expect(style(r, "hero").layout).toEqual({ pattern: "layer", align: "end" });
  });

  it("lifts letter-spacing (em and px) and uppercase into the text role", () => {
    const r = one(`.c__a { font: 600 12px/16px Inter; color: #111; letter-spacing: 0.96px; text-transform: uppercase }`);
    expect(r.data.text).toEqual({ a: { font: "inter", size: "12px", weight: 600, lineHeight: 1.333333, color: "hex-111", letterSpacing: 0.08, transform: "uppercase" } });
  });

  it("maps max-width without auto margins to a left-aligned measure", () => {
    const r = one(`.c { display: flex; flex-direction: column } .c__p { max-width: 38rem }`);
    expect(slots(r, "c").p).toEqual({ measure: "px-608" });
  });

  it("takes the page background from :root, html or body", () => {
    expect(one(`body { margin: 0; background: #e9f0f1 } .c { padding: 8px }`).data.page).toEqual({ background: "hex-e9f0f1" });
  });

  it("still reports grids it can't express", () => {
    const r = one(`.c { display: grid; grid-template-columns: 1fr 2fr }`);
    expect(r.unlifted[0].reason).toMatch(/grid-template-columns: 1fr 2fr has no Cadesa pattern/);
  });
});
