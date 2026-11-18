import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { matchWeight, metricsFor } from "../src/engine/text.js";
import { CHARS, metricsFileName, writeMetrics, type MetricsFile } from "../src/metrics.js";

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
    expect(m.measure("ab", 10, 400)).toBeCloseTo(2 * 0.54 * 10, 9);
    expect(m.measure("ab", 10, 650)).toBeCloseTo(2 * 0.57 * 10, 9); // 650 → the 700 face
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

  it("ignores a metrics file whose family doesn't match", () => {
    const dir = mkdtempSync(join(tmpdir(), "cadesa-"));
    writeFileSync(join(dir, metricsFileName("Other")), JSON.stringify({ ...fake([400]), family: "Brand Sans" }));
    process.env.CADESA_METRICS = dir;
    expect(metricsFor("Other")).toBeUndefined();
  });
});
