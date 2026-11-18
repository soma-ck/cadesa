import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.js";
import { CascadioError } from "../src/diagnostics.js";
import { walk, type Box, type Layout } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { loadSource } from "../src/load.js";
import { modelOf, render, whatif } from "../src/project.js";
import { validate } from "../src/validate.js";

const SOURCE_FILE = "settings.cascade.yaml";
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
    expect(d.expected).toBe("one of section, panel, compact, control");
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
    expect(() => modelOf(src(sourceText.replace("color: ink }", "color: inc }")))).toThrow(CascadioError);
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
    expect(padding.value).toBe(16);
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
    expect(padding.from!.value).toBe(16);
    expect(padding.to!.value).toBe(32);
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
