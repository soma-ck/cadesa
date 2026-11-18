import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp.js";

const page = { source: "settings.cadesa.yaml", fixture: "fixtures/settings.html" };
let client: Client;

beforeAll(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0].text, isError: !!r.isError };
};

describe("MCP server", () => {
  it("lists the tools with read-only hints and teaches the language in its instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cadesa_build",
      "cadesa_check",
      "cadesa_critique",
      "cadesa_css",
      "cadesa_explain",
      "cadesa_fonts",
      "cadesa_lift",
      "cadesa_metrics",
      "cadesa_render",
      "cadesa_validate",
      "cadesa_whatif",
    ]);
    expect(tools.find((t) => t.name === "cadesa_whatif")!.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toContain("cadesa_whatif");
  });

  it("whatif predicts the mobile padding change and an unchanged desktop", async () => {
    const r = await call("cadesa_whatif", { ...page, changes: { "styles.settings-panel.when.narrow.padding": "panel" } });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("padding 16px → 32px");
    expect(r.text).toContain("1280px\n  ✓ unchanged");
  });

  it("takes a Tailwind page with its compiled CSS", async () => {
    const tw = { fixture: "fixtures/tailwind/blog.html", tailwind: "fixtures/tailwind/compiled.css" };
    const r = await call("cadesa_render", { ...tw, widths: [1280] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("#article");
    const w = await call("cadesa_whatif", { ...tw, widths: [1280], changes: { "styles.div.slots.div-2.layout.gap": "spacing-4" } });
    expect(w.isError).toBe(false);
    expect(w.text).toMatch(/#article-2/);
    const l = await call("cadesa_lift", { css: "fixtures/tailwind/compiled.css", tailwind: "fixtures/tailwind/blog.html", widths: [390] });
    expect(l.text).toContain("styles:");
  });

  it("returns structured JSON on request", async () => {
    const r = await call("cadesa_render", { ...page, widths: [390], format: "json" });
    const data = JSON.parse(r.text);
    expect(data.layouts[0].boxes[0].id).toBe("panel");
  });

  it("evaluates unsaved source text and reports diagnostics as tool errors", async () => {
    const text = readFileSync("settings.cadesa.yaml", "utf8").replace("gap: section }", "gap: sectoin }");
    const r = await call("cadesa_validate", { source: "settings.cadesa.yaml", sourceText: text });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/settings\.cadesa\.yaml:\d+:\d+ error styles\.settings-panel\.layout\.gap/);
    expect(r.text).toContain('did you mean "section"?');
  });

  it("explains and checks", async () => {
    const e = await call("cadesa_explain", { ...page, id: "save", widths: [390] });
    expect(e.text).toContain("width       fill");
    const c = await call("cadesa_check", page);
    expect(c.text).toMatch(/^coverage: 6 boxes × 57 widths · 100% exact/);
    expect(c.text).toContain("✓ no findings at 57 widths from 320 to 1440px\n");
    const missing = await call("cadesa_explain", { ...page, id: "nope" });
    expect(missing).toEqual({ text: 'no element with data-fixture="nope" in fixtures/settings.html', isError: true });
  });

  it("finds the page's fonts and the metrics that measure them", async () => {
    const r = await call("cadesa_fonts", { source: "fixtures/fonts/fonts.cadesa.yaml", fixture: "fixtures/fonts/fonts.html" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Roboto · 300, 400, 450, 500, 600, 650, 700 · 12 text boxes");
    expect(r.text).toContain("✓ metrics: bundled with Cadesa, measured from Google Fonts Roboto (latin subset, wght axis), SIL OFL 1.1");
    expect(r.text).toContain("✓ every font the text uses has metrics");
  });

  it("returns the compiled CSS without writing", async () => {
    const r = await call("cadesa_css", { source: "settings.cadesa.yaml" });
    expect(r.text).toBe(readFileSync("dist/settings.css", "utf8"));
  });

  it("lifts CSS and renders it with uncertainty marks", async () => {
    const l = await call("cadesa_lift", { css: "fixtures/legacy.css", fixture: "fixtures/legacy.html", widths: [390] });
    expect(l.text).toContain("55 of 56 declarations lifted");
    expect(l.text).toContain("✓ exact (7): #card #name #bio #actions #follow #message #meta");
    const r = await call("cadesa_render", { css: "fixtures/legacy.css", fixture: "fixtures/legacy.html", widths: [390] });
    expect(r.text).toMatch(/#meta +p +16,241 +358×18/);
  });
});
