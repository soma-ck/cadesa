import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp.js";

const page = { source: "settings.cascade.yaml", fixture: "fixtures/settings.html" };
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
      "cascadio_build",
      "cascadio_check",
      "cascadio_css",
      "cascadio_explain",
      "cascadio_lift",
      "cascadio_render",
      "cascadio_validate",
      "cascadio_whatif",
    ]);
    expect(tools.find((t) => t.name === "cascadio_whatif")!.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toContain("cascadio_whatif");
  });

  it("whatif predicts the mobile padding change and an unchanged desktop", async () => {
    const r = await call("cascadio_whatif", { ...page, changes: { "styles.settings-panel.when.narrow.padding": "panel" } });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("padding 16px → 32px");
    expect(r.text).toContain("1280px\n  ✓ unchanged");
  });

  it("returns structured JSON on request", async () => {
    const r = await call("cascadio_render", { ...page, widths: [390], format: "json" });
    const data = JSON.parse(r.text);
    expect(data.layouts[0].boxes[0].id).toBe("panel");
  });

  it("evaluates unsaved source text and reports diagnostics as tool errors", async () => {
    const text = readFileSync("settings.cascade.yaml", "utf8").replace("gap: section }", "gap: sectoin }");
    const r = await call("cascadio_validate", { source: "settings.cascade.yaml", sourceText: text });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/settings\.cascade\.yaml:\d+:\d+ error styles\.settings-panel\.layout\.gap/);
    expect(r.text).toContain('did you mean "section"?');
  });

  it("explains and checks", async () => {
    const e = await call("cascadio_explain", { ...page, id: "save", widths: [390] });
    expect(e.text).toContain("width       fill");
    const c = await call("cascadio_check", page);
    expect(c.text).toBe("✓ no findings at 390, 1280px\n");
    const missing = await call("cascadio_explain", { ...page, id: "nope" });
    expect(missing).toEqual({ text: 'no element with data-fixture="nope" in fixtures/settings.html', isError: true });
  });

  it("returns the compiled CSS without writing", async () => {
    const r = await call("cascadio_css", { source: "settings.cascade.yaml" });
    expect(r.text).toBe(readFileSync("dist/settings.css", "utf8"));
  });

  it("lifts CSS and renders it with uncertainty marks", async () => {
    const l = await call("cascadio_lift", { css: "fixtures/legacy.css", fixture: "fixtures/legacy.html", widths: [390] });
    expect(l.text).toContain("49 of 54 declarations lifted");
    expect(l.text).toContain("✓ exact (5): #name #bio #actions #follow #message");
    const r = await call("cascadio_render", { css: "fixtures/legacy.css", fixture: "fixtures/legacy.html", widths: [390] });
    expect(r.text).toMatch(/#meta +p +16,228 +≈358×18/);
  });
});
