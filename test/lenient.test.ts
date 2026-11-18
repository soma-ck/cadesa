import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.js";
import { loadSource } from "../src/load.js";
import { validate } from "../src/validate.js";

const v = (yaml: string) => validate(loadSource("t.cadesa.yaml", yaml));

describe("accepts what people naturally write", () => {
  // The shape a real agent wrote first (field report 3): no version, camelCase, numbers, px line heights.
  const natural = `
tokens:
  space: { rowGap: 8, panelPadding: 1.5rem }
  size: { labelCol: 120 }
  color: { ink: "#1F2933", muted: "rgb(82, 96, 109)", surface: white }
text:
  panelTitle: { size: 18, weight: bold, lineHeight: 24px, color: ink }
  rowLabel: { size: 14px, weight: "600", lineHeight: 150%, color: muted }
breakpoints:
  phone: 600
styles:
  jobPanel:
    layout: { pattern: stack, gap: rowGap }
    padding: panelPadding
    background: surface
    slots:
      title: { text: panelTitle }
      label: { text: rowLabel, width: labelCol }
`;

  it("validates without errors", () => {
    expect(v(natural).diagnostics).toEqual([]);
  });

  it("normalizes to the same model as the canonical spelling", () => {
    const m = v(natural).model!;
    expect(m.tokens.get("space.rowGap")!.raw).toBe("8px");
    expect(m.tokens.get("size.labelCol")!.px).toBe(120);
    expect(m.tokens.get("color.ink")!.raw).toBe("#1f2933");
    expect(m.tokens.get("color.muted")!.raw).toBe("#52606d");
    expect(m.tokens.get("color.surface")!.raw).toBe("#ffffff");
    const title = m.text.get("panelTitle")!;
    expect([title.size.raw, title.weight, title.lineHeight]).toEqual(["18px", 700, 1.333333]);
    expect(m.text.get("rowLabel")!.lineHeight).toBe(1.5);
    expect(m.breakpoints[0].length.px).toBe(600);
  });

  it("compiles camelCase names into valid class names and custom properties", () => {
    const css = compile(v(natural).model!);
    expect(css).toContain(".ca-jobPanel .ca-jobPanel__title {");
    expect(css).toContain("--ca-space-rowGap: 8px;");
    expect(css).toContain("line-height: 1.333333;");
  });

  it("still rejects what is genuinely wrong or ambiguous", () => {
    const bad = (yaml: string) => v(yaml).diagnostics.map((d) => d.message);
    expect(bad("version: 2")).toEqual(["unsupported version"]);
    expect(bad("tokens: { space: { row_gap: 8 } }")[0]).toMatch(/invalid name "row_gap"/);
    expect(bad("tokens: { space: { s: -4 } }")[0]).toMatch(/invalid space length/);
    expect(bad("text: { t: { size: 16, weight: 400, lineHeight: normal, color: x } }")).toContain("invalid line height");
    expect(bad('tokens: { color: { c: "hsl(10 20% 30%)" } }')).toEqual(["invalid color"]);
  });
});
