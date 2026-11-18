import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.js";
import { walk, type Layout } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { lift } from "../src/lift/lift.js";
import { loadSource } from "../src/load.js";
import { modelOf, render, whatif } from "../src/project.js";

const SRC = "examples/pricing/pricing.cadesa.yaml";
const text = readFileSync(SRC, "utf8");
const model = modelOf(loadSource(SRC, text));
const fixture = parseFixture("examples/pricing/pricing.html");
const box = (l: Layout, id: string) => [...walk(l.boxes)].find((b) => b.id === id)!;

describe("nested components", () => {
  const [phone, desktop] = render(model, fixture, [390, 1280]);

  it("lays out a component inside another component's slot", () => {
    expect([...phone.issues, ...desktop.issues]).toEqual([]);
    const team = box(desktop, "team");
    expect(team.component).toBe("plan-card");
    expect(team.sourcePath).toBe("styles.plan-card");
    expect(box(desktop, "team-f2").sourcePath).toBe("styles.plan-card.slots.feature");
  });

  it("places nested roots with the parent slot's layout, and applies their own breakpoints", () => {
    const [s, t, e] = ["starter", "team", "enterprise"].map((id) => box(desktop, id));
    expect(s.y).toBe(t.y);
    expect(t.x).toBeCloseTo(s.x + s.w + 16, 6);
    expect(e.y).toBe(s.y);
    const ps = ["starter", "team", "enterprise"].map((id) => box(phone, id));
    expect(ps.every((b) => b.w === box(phone, "plans").w)).toBe(true); // width: fill at narrow
    expect(ps[1].y).toBeCloseTo(ps[0].y + ps[0].h + 16, 6);
  });

  it("emits every reset before any component rule, so nested roots win over their parent's reset", () => {
    const css = compile(model);
    const lastReset = css.lastIndexOf(":where(*) {");
    expect(lastReset).toBeLessThan(css.indexOf(".ca-plan-card {"));
    expect(lastReset).toBeLessThan(css.indexOf(".ca-pricing {"));
  });

  it("whatif reaches nested components through shared tokens", () => {
    const r = whatif(loadSource(SRC, text), fixture, [1280], [{ path: "tokens.size.card", value: "16rem" }]);
    const ids = r.widths[0].elements.map((e) => e.id);
    expect(ids).toContain("team");
    expect(ids).toContain("team-f1");
    expect(ids).not.toContain("title");
  });

  it("rejects an element that is both a slot and a component root", () => {
    const html = '<section class="ca-pricing"><div class="ca-pricing__plans ca-plan-card" data-fixture="x"></div></section>';
    const [l] = render(model, parseFixture("x.html", html), [390]);
    expect(l.issues[0].message).toMatch(/both \.ca-pricing__plans and the root of \.ca-plan-card/);
  });

  it("round-trips through lift with identical layout", () => {
    const relifted = modelOf(loadSource("x", lift("pricing.css", compile(model)).yaml));
    const g = (ls: Layout[]) => ls.map((l) => [...walk(l.boxes)].map((b) => [b.id, b.x, b.y, b.w, b.h].join()));
    const widths = [320, 390, 640, 641, 768, 960, 1280];
    expect(g(render(relifted, fixture, widths))).toEqual(g(render(model, fixture, widths)));
  });
});

describe("alignment, text alignment, decoration", () => {
  it("stretches cluster items to equal height when align: stretch", () => {
    const [d] = render(model, fixture, [1280]);
    const hs = ["starter", "team", "enterprise"].map((id) => box(d, id));
    expect(new Set(hs.map((b) => b.h)).size).toBe(1);
    expect(new Set(hs.map((b) => b.y)).size).toBe(1);
  });

  it("compiles align, textAlign, decoration and vertical centering for fixed-height text", () => {
    const css = compile(model);
    expect(css).toContain("align-items: stretch;\n  gap: var(--ca-space-gutter);");
    const cta = css.slice(css.indexOf(".ca-plan-card .ca-plan-card__cta {"));
    expect(cta.slice(0, cta.indexOf("}"))).toMatch(/align-content: center;[\s\S]*text-decoration: none;\n  text-align: center;/);
    expect(css).toContain("list-style: none;");
  });

  it("rejects align on a stack", () => {
    const bad = text.replace("layout: { pattern: stack, gap: card }", "layout: { pattern: stack, gap: card, align: center }");
    expect(() => modelOf(loadSource(SRC, bad))).toThrow(/align doesn't apply to a stack/);
  });

  it("lifts align-items, text-align and text-decoration back", () => {
    const l = lift("x.css", compile(model));
    expect(l.unlifted).toEqual([]);
    expect(l.yaml).toContain("align: stretch");
    expect(l.yaml).toContain("textAlign: center");
    expect(l.yaml).toContain("decoration: none");
  });
});

describe("diagnostics for CSS habits", () => {
  const settings = readFileSync("settings.cadesa.yaml", "utf8");
  const err = (y: string) => {
    try {
      modelOf(loadSource("s.yaml", y));
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  it("points width: 100% at fill", () => {
    expect(err(settings.replace("secondary: { width: fill }", "secondary: { width: 100% }"))).toMatch(/width "100%" is spelled fill[\s\S]*did you mean "fill"/);
  });
  it("explains that literals must be declared as tokens", () => {
    expect(err(settings.replace("padding: compact", "padding: 12px"))).toMatch(/"12px" is a literal; values are token names[\s\S]*tokens\.space\.<name>: 12px/);
  });
  it("lays out maxWidth inside a cluster as the browser does: 100% wide, capped, auto margins taking the line's free space", () => {
    const m = modelOf(loadSource("s.yaml", settings.replace("primary: { text: label-inverse,", "primary: { maxWidth: panel, text: label-inverse,")));
    const [l] = render(m, parseFixture("fixtures/settings.html"), [1280]);
    expect(l.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});
