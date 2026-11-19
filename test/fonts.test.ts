import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fontsCmd } from "../src/commands.js";
import { walk } from "../src/engine/layout.js";
import { clearMetricsCache, matchWeight, metricsFor } from "../src/engine/text.js";
import { fontFileInfo } from "../src/fontfile.js";
import { fontReport, fontUses, googleFamilies, googleWeights, pageFontSources } from "../src/fonts.js";
import { loadSourceFile } from "../src/load.js";
import { parseFixture } from "../src/fixture.js";
import { run } from "./lift-page.js";
import { CHARS, metricsFileName, readMetrics, writeMetrics, type MetricsFile } from "../src/metrics.js";
import { modelOf, render } from "../src/project.js";

const fake = (weights: number[], kind: "static" | "variable" = "static"): MetricsFile => ({
  family: "Brand Sans",
  source: "test",
  generatedWith: "test",
  units: 10000,
  kind,
  weights,
  chars: CHARS,
  advances: Object.fromEntries(weights.map((w) => [w, [...CHARS].map(() => 5000 + w)])),
  kerning: Object.fromEntries(weights.map((w) => [w, {}])),
});

describe("custom font metrics", () => {
  const saved = process.env.CADESA_METRICS;
  afterEach(() => {
    process.env.CADESA_METRICS = saved;
  });

  it("matches static faces like CSS Fonts 4 §5.2", () => {
    expect(matchWeight([400, 700], 650)).toBe(700);
    expect(matchWeight([400, 700], 600)).toBe(700);
    expect(matchWeight([400, 700], 500)).toBe(400);
    expect(matchWeight([300, 600], 450)).toBe(300);
    expect(matchWeight([300, 500], 450)).toBe(500);
    expect(matchWeight([400, 700], 300)).toBe(400);
    expect(matchWeight([400, 700], 900)).toBe(700);
  });

  it("finds metrics on $CADESA_METRICS and measures the matched face", () => {
    const dir = mkdtempSync(join(tmpdir(), "cadesa-"));
    writeMetrics(fake([400]), dir);
    writeMetrics(fake([700]), dir); // a second static face merges into the same family file
    process.env.CADESA_METRICS = dir;
    const m = metricsFor('"Brand Sans", sans-serif')!;
    expect(m.file).toBe(join(dir, metricsFileName("Brand Sans")));
    // Glyph advances are rounded to 1/65536 px, as Chromium positions them.
    expect(m.measure("ab", 10, 400)).toBe(2 * (Math.round(0.54 * 10 * 65536) / 65536));
    expect(m.measure("ab", 10, 650)).toBe(2 * (Math.round(0.57 * 10 * 65536) / 65536)); // 650 → the 700 face
    expect(m.weightIssue(650)).toBeUndefined();
  });

  it("refuses to guess a synthesized bold", () => {
    const dir = mkdtempSync(join(tmpdir(), "cadesa-"));
    const f = fake([400]);
    f.family = "Only Regular";
    writeMetrics(f, dir);
    process.env.CADESA_METRICS = dir;
    expect(metricsFor("Only Regular")!.weightIssue(700)).toMatch(/synthesized from the 400 face/);
  });

  it("measures text as approximate in a font whose contextual forms weren't all measured", () => {
    const dir = mkdtempSync(join(tmpdir(), "cadesa-"));
    writeMetrics({ ...fake([400]), family: "Hand Script", contextualIncomplete: true }, dir);
    writeMetrics({ ...fake([400]), family: "Plain Script" }, dir);
    process.env.CADESA_METRICS = dir;
    expect(metricsFor("Hand Script")!.info.contextualIncomplete).toBe(true);
    const r = run(`<p id="b" style="font-family: 'Plain Script'">Printed note</p><p id="a" style="font-family: 'Hand Script'">Handwritten note</p>`, `p { margin: 0 }`);
    expect(r.approx("a")).toMatch(/shapes more runs in context/);
    expect(r.approx("b")).toBeUndefined();
  });

  it("ignores a metrics file whose family doesn't match", () => {
    const dir = mkdtempSync(join(tmpdir(), "cadesa-"));
    writeFileSync(join(dir, metricsFileName("Other")), JSON.stringify({ ...fake([400]), family: "Brand Sans" }));
    process.env.CADESA_METRICS = dir;
    expect(metricsFor("Other")).toBeUndefined();
  });
});

describe("tables measured by an older Cadesa", () => {
  const saved = process.env.CADESA_METRICS;
  afterEach(() => {
    process.env.CADESA_METRICS = saved;
    clearMetricsCache();
  });
  const face = { ascent: 1900, descent: 500, lineGap: 0, xHeight: 1100, avgChar: 1100, maxChar: 4000 };
  const complete = (weights: number[]): MetricsFile => ({ ...fake(weights), vertical: { size: 2048, byWeight: Object.fromEntries(weights.map((w) => [w, face])) } });

  it("says what a table lacks, face by face", () => {
    const dir = mkdtempSync(join(tmpdir(), "cadesa-"));
    process.env.CADESA_METRICS = dir;
    writeMetrics({ ...fake([400, 700]), family: "Old Sans" }, dir);
    writeMetrics({ ...complete([400]), family: "Half Sans", vertical: { size: 2048, byWeight: { 400: { ...face, avgChar: undefined, maxChar: undefined } } } }, dir);
    writeMetrics({ ...complete([400, 700]), family: "New Sans" }, dir);
    clearMetricsCache();
    expect(metricsFor("Old Sans")!.outdated).toBe("vertical metrics and character widths");
    expect(metricsFor("Half Sans")!.outdated).toBe("average and maximum character widths");
    expect(metricsFor("New Sans")!.outdated).toBeUndefined();
  });

  it("keeps a face measured again complete, and flags the faces still from the older table", () => {
    const dir = mkdtempSync(join(tmpdir(), "cadesa-"));
    process.env.CADESA_METRICS = dir;
    writeMetrics(fake([400, 700]), dir);
    writeMetrics(complete([400]), dir);
    const m = readMetrics(join(dir, metricsFileName("Brand Sans")));
    expect(m.weights).toEqual([400, 700]);
    expect(Object.keys(m.vertical!.byWeight)).toEqual(["400"]);
    clearMetricsCache();
    expect(metricsFor("Brand Sans")!.outdated).toBe("vertical metrics and character widths for weight 700");
    writeMetrics(complete([700]), dir);
    clearMetricsCache();
    expect(metricsFor("Brand Sans")!.outdated).toBeUndefined();
  });

  it("names the command that measures it again where a box needs what it lacks", () => {
    const dir = mkdtempSync(join(tmpdir(), "cadesa-"));
    process.env.CADESA_METRICS = dir;
    writeMetrics({ ...fake([400, 700]), family: "Old Sans" }, dir);
    clearMetricsCache();
    const r = run(`<p><input data-fixture="i"></p>`, `body { font-family: "Old Sans" } input { font: inherit }`);
    expect(r.approx("i")).toMatch(/re-measure: cadesa fonts … --measure/);
    const report = fontReport([{ family: "Old Sans", stack: '"Old Sans"', weights: [400], sizes: [16], boxes: ["p"] }], { faces: [], google: [], declared: [], stylesheets: [] });
    expect(report[0].remeasure).toMatch(/older Cadesa and has no vertical metrics/);
  });
});

describe("metrics from other fonts", () => {
  const saved = process.env.CADESA_METRICS;
  afterEach(() => {
    process.env.CADESA_METRICS = saved;
    clearMetricsCache();
  });
  const dirWith = (...ms: MetricsFile[]) => {
    const dir = mkdtempSync(join(tmpdir(), "cadesa-"));
    for (const m of ms) writeMetrics(m, dir);
    process.env.CADESA_METRICS = dir;
    return dir;
  };

  it("reads units per em and variation axes from WOFF2 files", () => {
    expect(fontFileInfo(readFileSync("fonts/InterVariable-latin.woff2"))).toEqual({
      unitsPerEm: 2048,
      axes: [{ tag: "wght", min: 100, default: 400, max: 900 }],
    });
    expect(fontFileInfo(readFileSync("fixtures/fonts/fonts/lato/Lato-Regular.woff2"))).toEqual({ unitsPerEm: 2000, axes: [] });
    expect(fontFileInfo(Buffer.from("not a font"))).toBeUndefined();
  });

  it("scales advances like FreeType when the units per em isn't a power of two", () => {
    // Lato's "A" is 1360 of 2000 units; Chromium draws it 8.160064697265625px wide at 12px
    // (FreeType's 16.16 x_scale), not 8.16.
    const m = { ...fake([400]), family: "Upm Sans", units: 1_000_000, upm: 2000 };
    m.advances = { 400: [...CHARS].map((c) => (c === "A" ? 680_000 : 500_000)) };
    dirWith(m);
    expect(metricsFor("Upm Sans")!.measure("A", 12, 400)).toBe(8.160064697265625);
  });

  it("adds what ligature runs add, except in letter-spaced text", () => {
    const m = { ...fake([400]), family: "Liga Sans", units: 1_000_000, upm: 1000 };
    m.advances = { 400: [...CHARS].map(() => 500_000) };
    m.contextual = { 400: { ffi: -400_000 } };
    dirWith(m);
    const f = metricsFor("Liga Sans")!;
    expect(f.measure("ffi", 10, 400)).toBe(11); // 3 × 5px, less the ligature's 4px
    expect(f.measure("office", 10, 400)).toBe(26);
    expect(f.measure("ffi", 10, 400, true)).toBe(15);
  });

  it("reads gzipped tables, and merges static faces that cover different characters", () => {
    const dir = mkdtempSync(join(tmpdir(), "cadesa-"));
    const regular = fake([400]);
    const bold = { ...fake([700]), chars: CHARS.replace("é", ""), missing: "é" };
    bold.advances = { 700: [...bold.chars].map(() => 5700) };
    writeMetrics(regular, dir, { gzip: true });
    const file = writeMetrics(bold, dir, { gzip: true });
    expect(file.endsWith(".metrics.json.gz")).toBe(true);
    const merged = readMetrics(file);
    expect(merged.weights).toEqual([400, 700]);
    expect(merged.chars).toBe(CHARS.replace("é", ""));
    expect(merged.advances[400].length).toBe(merged.chars.length);
    process.env.CADESA_METRICS = dir;
    expect(metricsFor("Brand Sans")!.unsupported("café")).toEqual(["é"]);
  });

  it("parses Google Fonts URLs", () => {
    const url = "https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,400;0,700;1,400&family=Open+Sans:wght@300..800&display=swap";
    expect(googleFamilies(url)).toEqual(["Roboto", "Open Sans"]);
    expect(googleWeights(url, "Roboto")).toEqual(["400", "700"]);
    expect(googleWeights(url, "Open Sans")).toEqual(["300 800"]);
    expect(googleFamilies("//fonts.googleapis.com/css?family=Lato:400,700|Inter")).toEqual(["Lato", "Inter"]);
    expect(googleWeights("//fonts.googleapis.com/css?family=Lato:400,700italic|Inter", "Lato")).toEqual(["400", "700"]);
  });

  it("bundles metrics for popular Google Fonts, measured from the files the fixture loads", () => {
    for (const f of ["Roboto", "Open Sans", "Montserrat", "Lato", "Poppins", "Source Sans 3", "Nunito", "Raleway"]) {
      const m = metricsFor(`"${f}", sans-serif`)!;
      expect(m.info.bundled).toBe(true);
      expect(m.info.files!.every((x) => x.url?.startsWith("https://fonts.gstatic.com/") && /^[0-9a-f]{64}$/.test(x.sha256!))).toBe(true);
    }
    const model = modelOf(loadSourceFile("fixtures/fonts/fonts.cadesa.yaml"));
    const layouts = render(model, parseFixture("fixtures/fonts/fonts.html"), [390, 1280]);
    for (const l of layouts) for (const b of walk(l.boxes)) expect(b.assumptions).toEqual([]);
    const report = fontReport(fontUses(layouts), pageFontSources("fixtures/fonts/fonts.html"));
    expect(report.map((r) => [r.family, r.status, r.sameFiles])).toEqual([
      ["Roboto", "measured", true],
      ["Lato", "measured", true],
    ]);
  });

  it("finds where each font comes from", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cadesa-page-"));
    mkdirSync(join(dir, "css"));
    writeFileSync(
      join(dir, "css", "app.css"),
      [
        '@import url("https://fonts.googleapis.com/css2?family=Montserrat:wght@600");',
        '@font-face { font-family: "Brand Sans"; font-weight: 400; src: local("Brand"), url("../f/brand.woff2") format("woff2"); }',
        ".card { display: flex; flex-direction: column; gap: 8px; padding: 16px; }",
        ".card__title { margin: 0; font: 600 20px/28px Montserrat, sans-serif; color: #111; }",
        '.card__body { margin: 0; font: 400 15px/22px "Brand Sans", sans-serif; color: #333; }',
        ".card__meta { margin: 0; font: 400 12px/16px Poppins, sans-serif; color: #666; }",
        ".card__hint { margin: 0; font: 400 13px/18px system-ui, sans-serif; color: #666; }",
        ".unused { font-family: Georgia, serif; }",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "page.html"),
      [
        '<link rel="stylesheet" href="css/app.css" />',
        '<section class="card" data-fixture="card">',
        '<h2 class="card__title" data-fixture="title">Settings</h2>',
        '<p class="card__body" data-fixture="body">Body text</p>',
        '<p class="card__meta" data-fixture="meta">Meta</p>',
        '<p class="card__hint" data-fixture="hint">Hint</p>',
        "</section>",
      ].join("\n"),
    );
    process.env.CADESA_METRICS = mkdtempSync(join(tmpdir(), "cadesa-empty-"));
    const r = await fontsCmd({ fixture: join(dir, "page.html"), css: join(dir, "css", "app.css"), widths: [390] });
    const fonts = (r.data as { fonts: { family: string; status: string; boxes: number }[] }).fonts;
    expect(fonts.map((f) => [f.family, f.status, f.boxes])).toEqual([
      ["Montserrat", "measured", 1], // bundled
      ["Brand Sans", "file", 1],
      ["Poppins", "measured", 1], // bundled; the page doesn't load it, though
      ["system-ui", "system", 1],
      ["Georgia", "system", 0],
    ]);
    expect(r.text).toContain(`400: ${join(dir, "f", "brand.woff2")} (file not found)`);
    expect(r.text).toContain("the operating system's UI font");
    expect(r.text).toContain("--measure");
    expect(existsSync(join(dir, ".cadesa"))).toBe(false);
  });
});
