import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { check, contrast } from "../src/check.js";
import { compile } from "../src/compile.js";
import { explain } from "../src/explain.js";
import { CadesaError } from "../src/diagnostics.js";
import { walk, type Box, type Layout } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { layoutText, metricsFor, pieces } from "../src/engine/text.js";
import { loadSource } from "../src/load.js";
import { modelOf, render, whatif } from "../src/project.js";
import { validate } from "../src/validate.js";

const SOURCE_FILE = "settings.cadesa.yaml";
const FIXTURE_FILE = "fixtures/settings.html";
const sourceText = readFileSync(SOURCE_FILE, "utf8");
const fixture = parseFixture(FIXTURE_FILE);
const src = (text = sourceText) => loadSource(SOURCE_FILE, text);
const box = (l: Layout, id: string): Box => [...walk(l.boxes)].find((b) => b.id === id)!;
const diagnosticsOf = (text: string) => validate(src(text)).diagnostics;

describe("validation", () => {
  it("rejects a misspelled token with its YAML path, line, expected values and a suggestion", () => {
    const [d, ...rest] = diagnosticsOf(sourceText.replace("gap: section }", "gap: sectoin }"));
    expect(rest).toEqual([]);
    expect(d.path).toBe("styles.settings-panel.layout.gap");
    expect(d.file).toBe(SOURCE_FILE);
    expect(d.line).toBe(sourceText.split("\n").findIndex((l) => l.includes("gap: section }")) + 1);
    expect(d.message).toBe('unknown space token "sectoin"');
    expect(d.expected).toBe("one of section, panel, compact, control, control-inline");
    expect(d.suggestion).toBe('"section"');
  });

  it("rejects unknown keys at the key's own location", () => {
    const [d] = diagnosticsOf(sourceText.replace("    padding: panel\n", "    paddin: panel\n"));
    expect(d.path).toBe("styles.settings-panel.paddin");
    expect(d.message).toBe('unknown key "paddin"');
    expect(d.suggestion).toBe('"padding"');
  });

  it("rejects invalid identifiers, unsupported values, unknown breakpoints and unknown slots", () => {
    const ds = diagnosticsOf(
      sourceText
        .replace("section-title:", "Section_Title:")
        .replace("pattern: cluster", "pattern: grid")
        .replace("      narrow:\n", "      narorw:\n"),
    );
    const paths = ds.map((d) => d.path);
    expect(paths).toContain("text.Section_Title");
    expect(paths).toContain("styles.settings-panel.slots.actions.layout.pattern");
    expect(paths).toContain("styles.settings-panel.when.narorw");
    expect(ds.find((d) => d.path.endsWith("narorw"))!.suggestion).toBe('"narrow"');

    const [slot] = diagnosticsOf(sourceText.replace("          primary: { width: fill }", "          primray: { width: fill }"));
    expect(slot.path).toBe("styles.settings-panel.when.narrow.slots.primray");
    expect(slot.suggestion).toBe('"primary"');
  });

  it("does not emit CSS when the source is invalid", () => {
    expect(() => modelOf(src(sourceText.replace("color: ink }", "color: inc }")))).toThrow(CadesaError);
  });
});

describe("compiler", () => {
  it("emits byte-identical CSS for identical input", () => {
    const a = compile(modelOf(src()));
    const b = compile(modelOf(src(sourceText)));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("matches the golden stylesheet", async () => {
    await expect(compile(modelOf(src()))).toMatchFileSnapshot("golden/settings.css");
  });

  it("follows the class contract and puts breakpoint overrides after base rules", () => {
    const css = compile(modelOf(src()));
    expect(css).toContain(".ca-settings-panel {");
    expect(css).toContain(".ca-settings-panel .ca-settings-panel__title {");
    const media = css.indexOf("@media (max-width: 36rem)");
    expect(media).toBeGreaterThan(css.lastIndexOf(".ca-settings-panel .ca-settings-panel__secondary {", media));
    expect(css.slice(media)).toContain("padding: var(--ca-space-compact)");
  });
});

describe("fixture", () => {
  it("links the stylesheet the build writes, and nothing else", () => {
    expect(fixture.stylesheets).toHaveLength(1);
    expect(resolve(dirname(FIXTURE_FILE), fixture.stylesheets[0])).toBe(resolve("dist/settings.css"));
  });
});

describe("engine", () => {
  const [mobile, desktop] = render(modelOf(src()), fixture, [390, 1280]);

  it("lays the actions out horizontally at 1280px", () => {
    const save = box(desktop, "save");
    const cancel = box(desktop, "cancel");
    expect(desktop.active).toEqual([]);
    expect(save.y).toBe(cancel.y);
    expect(cancel.x).toBeGreaterThan(save.x + save.w);
  });

  it("stacks the actions at 390px, full width", () => {
    const save = box(mobile, "save");
    const cancel = box(mobile, "cancel");
    expect(mobile.active).toEqual(["narrow"]);
    expect(save.x).toBe(cancel.x);
    expect(cancel.y).toBe(save.y + save.h + 12);
    expect(save.w).toBe(box(mobile, "actions").w);
  });

  it("explains every value back to an editable YAML path", () => {
    const padding = box(mobile, "panel").props.padding!;
    expect(padding.value).toEqual({ block: 16, inline: 16 });
    expect(padding.steps.map((s) => s.path)).toEqual([
      "tokens.space.compact",
      "breakpoints.narrow",
      "styles.settings-panel.when.narrow.padding",
    ]);
    expect(box(desktop, "panel").props.padding!.steps.at(-1)!.path).toBe("styles.settings-panel.padding");
  });

  it("reports no issues for the fixture", () => {
    expect([...mobile.issues, ...desktop.issues]).toEqual([]);
  });

  it("reports slots the fixture uses but the source does not declare", () => {
    const bad = parseFixture("bad.html", '<section class="ca-settings-panel"><h2 class="ca-settings-panel__titel">x</h2></section>');
    const [l] = render(modelOf(src()), bad, [390]);
    expect(l.issues[0].message).toContain('slot "titel"');
    expect(l.issues[0].suggestion).toBe('"title"');
  });
});

describe("whatif", () => {
  it("changing only when.narrow.padding moves mobile and leaves desktop untouched", () => {
    const r = whatif(src(), fixture, [390, 1280], [{ path: "styles.settings-panel.when.narrow.padding", value: "panel" }]);
    const [mobile, desktop] = r.widths;

    const panel = mobile.elements.find((e) => e.id === "panel")!;
    const padding = panel.props.find((p) => p.prop === "padding")!;
    expect(padding.from!.value).toEqual({ block: 16, inline: 16 });
    expect(padding.to!.value).toEqual({ block: 32, inline: 32 });
    expect(padding.to!.steps.at(-1)!.path).toBe("styles.settings-panel.when.narrow.padding");
    expect(mobile.elements.find((e) => e.id === "title")!.geometry).toEqual([
      { key: "x", from: 16, to: 32 },
      { key: "y", from: 16, to: 32 },
      { key: "w", from: 358, to: 326 },
    ]);

    expect(desktop.elements).toEqual([]);
    expect(r.changes).toEqual([{ path: "styles.settings-panel.when.narrow.padding", from: "compact", to: "panel" }]);
  });

  it("flags a new overflow before the edit is written", () => {
    const r = whatif(src(), fixture, [390, 1280], [{ path: "styles.settings-panel.when.narrow.slots.primary.width", value: "panel" }]);
    const fresh = r.widths[0].issuesAfter;
    expect(fresh).toHaveLength(1);
    expect(fresh[0].message).toBe("#save overflows #actions by 282px at 390px");
    expect(fresh[0].path).toBe("styles.settings-panel.when.narrow.slots.primary.width");
    expect(r.widths[1].elements).toEqual([]);
  });

  it("validates the edited source like any other", () => {
    expect(() =>
      whatif(src(), fixture, [390], [{ path: "styles.settings-panel.when.narrow.padding", value: "pannel" }]),
    ).toThrow(/did you mean "panel"/);
  });

  it("never writes to disk", () => {
    whatif(src(), fixture, [390], [{ path: "styles.settings-panel.padding", value: "compact" }]);
    expect(readFileSync(SOURCE_FILE, "utf8")).toBe(sourceText);
  });
});

describe("text", () => {
  const inter = metricsFor("Inter, system-ui, sans-serif")!;
  const long = parseFixture("fixtures/settings-long.html");

  it("finds break opportunities after spaces, between hyphenated words, and around dashes", () => {
    expect(pieces("a well-known fix — done")).toEqual(["a ", "well-", "known ", "fix ", "— ", "done"]);
    expect(pieces("pages 10-20")).toEqual(["pages ", "10-20"]);
    expect(pieces("a—b")).toEqual(["a", "—", "b"]);
  });

  it("measures with kerning and interpolates variable weights", () => {
    const av = inter.measure("AV", 100, 400)!;
    expect(av).toBeLessThan(inter.measure("A", 100, 400)! + inter.measure("V", 100, 400)!);
    const w = (weight: number) => inter.measure("Settings", 16, weight)!;
    expect(w(650)).toBeGreaterThan(w(600));
    expect(w(650)).toBeLessThan(w(700));
    expect(metricsFor("Georgia, serif")).toBeUndefined();
    expect(inter.measure("日本", 16, 400)).toBeUndefined();
  });

  it("breaks lines greedily and never splits a word", () => {
    const t = layoutText(inter, "Save notification preferences", 15, 600, 130);
    expect(t.lines.map((l) => l.text)).toEqual(["Save notification", "preferences"]);
    expect(t.lines.every((l) => l.width <= 130)).toBe(true);
    expect(t.minContent).toBe(inter.measure("preferences", 15, 600));
    expect(t.widestPiece).toBe("preferences");
  });

  it("wraps the long-copy fixture (line counts verified against Chromium by npm run conformance)", () => {
    const [m, d] = render(modelOf(src()), long, [390, 1280]);
    expect(box(m, "title").lines!.length).toBe(2);
    expect(box(m, "description").lines!.length).toBe(5);
    expect(box(m, "description").h).toBe(5 * 24);
    expect(box(d, "description").lines!.length).toBe(3);
    expect([...m.issues, ...d.issues]).toEqual([]);
  });

  it("sizes cluster items to their text (max-content + padding)", () => {
    const [, desktop] = render(modelOf(src()), fixture, [390, 1280]);
    const save = box(desktop, "save");
    expect(save.w).toBeCloseTo(inter.measure("Save changes", 15, 600)! + 40, 6);
    expect(box(desktop, "cancel").x).toBeCloseTo(save.x + save.w + 12, 6);
  });

  it("falls back to a flagged one-line assumption for fonts without metrics", () => {
    const r = whatif(src(), long, [390], [{ path: "tokens.font.ui", value: "Georgia, serif" }]);
    const [l] = render(modelOf(loadSource(SOURCE_FILE, sourceText.replace('"Inter, system-ui, sans-serif"', '"Georgia, serif"'))), long, [390]);
    expect(box(l, "description").assumptions[0]).toMatch(/Georgia.*no Cadesa metrics/);
    expect(box(l, "description").h).toBe(24);
    expect(r.widths[0].elements.find((e) => e.id === "description")!.geometry.find((g) => g.key === "h")).toEqual({
      key: "h",
      from: 120,
      to: 24,
    });
  });

  it("warns when text needs more room than a fixed height", () => {
    const r = whatif(src(), fixture, [1280], [{ path: "text.label-inverse.size", value: "3rem" }]);
    expect(r.widths[0].issuesAfter.map((i) => i.message)).toContain("content of #save needs 60px but its height is 44px at 1280px (1 lines)");
  });

  it("warns when an unbreakable word overflows", () => {
    const html = '<section class="ca-settings-panel"><p class="ca-settings-panel__description" data-fixture="d">Pneumonoultramicroscopicsilicovolcanoconiosis</p></section>';
    const [l] = render(modelOf(src()), parseFixture("w.html", html), [320]);
    expect(l.issues[0].message).toMatch(/^"Pneumono\w+" in #d can't wrap and overflows by [\d.]+px at 320px$/);
  });
});

describe("padding axes", () => {
  it("compiles { block, inline } padding and treats a missing axis as 0", () => {
    const css = compile(modelOf(src()));
    expect(css).toContain("padding: 0 var(--ca-space-control-inline);");
    const [l] = render(modelOf(src()), fixture, [1280]);
    expect(box(l, "save").props.padding!.value).toEqual({ block: 0, inline: 20 });
  });
});

describe("explain and check", () => {
  it("explains a value and lists the overrides that would change it at other widths", () => {
    const model = modelOf(src());
    const [, desktop] = render(model, fixture, [390, 1280]);
    const e = explain(model, desktop, "panel")!;
    const padding = e.props.find((p) => p.prop === "padding")!;
    expect(padding.value).toBe("32px");
    expect(padding.chain.at(-1)!.path).toBe("styles.settings-panel.padding");
    expect(padding.overrides).toEqual([
      {
        breakpoint: "narrow",
        query: "max-width: 36rem (576px)",
        active: false,
        value: "compact (16px)",
        path: "styles.settings-panel.when.narrow.padding",
      },
    ]);
  });

  it("passes the shipped fixtures", () => {
    for (const f of [fixture, parseFixture("fixtures/settings-long.html")])
      expect(check(render(modelOf(src()), f, [320, 390, 768, 1280]))).toEqual([]);
  });

  it("flags low contrast with the text role color to edit", () => {
    const findings = check(render(modelOf(src(sourceText.replace('muted: "#555964"', 'muted: "#aab0bb"'))), fixture, [1280]));
    const f = findings.find((x) => x.check === "contrast")!;
    expect(f.id).toBe("description");
    expect(f.path).toBe("text.body-muted.color");
    expect(f.message).toMatch(/is 2\.\d\d:1; WCAG AA needs 4.5:1/);
  });

  it("flags small tap targets with the size to edit", () => {
    const findings = check(render(modelOf(src(sourceText.replace("control: 2.75rem", "control: 2rem"))), fixture, [1280]));
    expect(findings.filter((f) => f.check === "tap-target").map((f) => [f.id, f.severity, f.path])).toEqual([
      ["save", "warning", "styles.settings-panel.slots.primary.height"],
      ["cancel", "warning", "styles.settings-panel.slots.secondary.height"],
    ]);
  });

  it("computes WCAG contrast ratios", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#fff", "#fff")).toBe(1);
  });
});
