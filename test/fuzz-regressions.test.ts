/**
 * Regressions found by the differential fuzzer (scripts/fuzz.ts): one minimal case per divergence,
 * in fixtures/fuzz/<name>/ with Chromium's boxes recorded in chromium.json. Every box the engine
 * reports as exact (no error, no assumption) must match Chromium within 0.5px; boxes a case lists
 * as `flagged` must be flagged. The boxes were recorded with the stylesheet the compiler made then
 * (cssSha256): a compiler change that alters it must be re-verified in Chromium:
 *
 *   npm run fuzz -- --replay fixtures/fuzz --record
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.js";
import { layout, walk } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { loadSource } from "../src/load.js";
import { validate } from "../src/validate.js";

const ROOT = "fixtures/fuzz";
const cases = readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, "chromium.json")));

type Rect = { x: number; y: number; w: number; h: number };

describe("fuzzer regressions", () => {
  it("has cases", () => expect(cases.length).toBeGreaterThan(20));

  for (const name of cases) {
    const dir = join(ROOT, name);
    const meta = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as { note?: string; widths: number[]; flagged?: string[] };
    it(`${name}${meta.note ? `: ${meta.note}` : ""}`, () => {
      const { model, diagnostics } = validate(loadSource(join(dir, "source.cadesa.yaml"), readFileSync(join(dir, "source.cadesa.yaml"), "utf8")));
      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const css = compile(model!);
      const fixture = parseFixture(join(dir, "fixture.html"));
      const { cssSha256, ...chromium } = JSON.parse(readFileSync(join(dir, "chromium.json"), "utf8")) as { cssSha256: string } & Record<string, Record<string, Rect>>;
      expect(createHash("sha256").update(css.replace(/^\/\*.*?\*\/\n/, "")).digest("hex"), "the stylesheet changed since Chromium's boxes were recorded").toBe(cssSha256);
      for (const width of meta.widths) {
        const l = layout(model!, fixture, width);
        const off: string[] = [];
        let compared = 0;
        for (const b of walk(l.boxes)) {
          const flagged = b.assumptions.length > 0 || l.issues.some((i) => i.severity === "error" && i.id === b.id);
          if (meta.flagged?.includes(b.id)) {
            if (!flagged) off.push(`#${b.id} at ${width}px should be flagged`);
            continue;
          }
          if (flagged) continue;
          const c = chromium[width][b.id];
          compared++;
          for (const k of ["x", "y", "w", "h"] as const)
            if (!(Math.abs(b[k] - c[k]) <= 0.5)) off.push(`#${b.id} at ${width}px: ${k} ${b[k]} (engine) vs ${c[k]} (Chromium)`);
        }
        expect(off).toEqual([]);
        if (!meta.flagged?.length) expect(compared).toBeGreaterThan(0);
      }
    });
  }
});
