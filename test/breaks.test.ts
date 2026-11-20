/**
 * Lines that break inside words: word-break: break-all and line-break: anywhere (each with its own
 * table of break opportunities, measured in Chromium by scripts/gen-breaks.ts), and keep-all,
 * which breaks the measured characters as ordinary text does. Chromium's boxes come from
 * conformance:css (fixtures/css/breaks.html).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.js";
import { layoutText, metricsFor, pieces } from "../src/engine/text.js";
import { loadSource } from "../src/load.js";
import { modelOf } from "../src/project.js";
import { run } from "./lift-page.js";

describe("breaks inside words", () => {
  it("breaks between letters with break-all, but not before closing punctuation", () => {
    expect(pieces("AVATAR", "all")).toEqual(["A", "V", "A", "T", "A", "R"]);
    expect(pieces("ok, go", "all")).toEqual(["o", "k, ", "g", "o"]);
    expect(pieces("ok, go")).toEqual(["ok, ", "go"]);
    // line-break: anywhere breaks before punctuation too.
    expect(pieces("ok,", "anywhere")).toEqual(["o", "k", ","]);
  });

  it("fills each line to its end with break-all", () => {
    const m = metricsFor("Inter")!;
    const t = layoutText(m, "STOREROOMKEY LEDGER", 16, 400, 60, { breaks: "all" });
    expect(t.lines.length).toBeGreaterThan(2);
    for (const l of t.lines.slice(0, -1)) expect(l.width).toBeLessThanOrEqual(60 + 1 / 64);
    expect(t.lines.map((l) => l.text).join("").replace(/ /g, "")).toBe("STOREROOMKEYLEDGER");
  });

  it("compiles breaks to word-break and line-break", () => {
    const css = compile(modelOf(loadSource("t.yaml", `tokens: { color: { ink: "#111111" } }\ntext:\n  a: { size: 16px, weight: 400, lineHeight: 1.5, color: ink, breaks: all }\n  b: { size: 16px, weight: 400, lineHeight: 1.5, color: ink, breaks: anywhere }\nstyles:\n  x: { text: a }\n  y: { text: b }\n`)));
    expect(css).toContain("word-break: break-all");
    expect(css).toContain("line-break: anywhere");
  });

  it("lifts word-break and line-break, and keep-all as ordinary text", () => {
    const r = run(`<p class="a">LDGR-2024-0098-STOREROOM AVATARWAVE</p><p class="b">shelf (top), crates</p><p class="c">well-known words</p>`, `.a { word-break: break-all; width: 120px } .b { line-break: anywhere; width: 60px } .c { word-break: keep-all; width: 70px }`);
    expect(r.t.yaml).toMatch(/breaks: all/);
    expect(r.t.yaml).toMatch(/breaks: anywhere/);
    expect(r.exact()).toBe(true);
  });

  it("breaks lines with inline boxes or letter-spacing of their own inside words, flagged only within the kerning across the break of their width", () => {
    const m = metricsFor("Inter")!;
    const text = "Codes LDGR2024STOREROOMWAVE and AVATARTYPOGRAPHY0098";
    const spans = [{ from: 32, to: 52, open: 7, close: 7, weight: 600 }];
    // Away from the line's width: exact, every line full but the last.
    const a = layoutText(m, text, 16, 400, 203, { breaks: "all", items: [32, 52], spans });
    expect(a.approximate).toBeUndefined();
    for (const l of a.lines.slice(0, -1)) expect(l.width).toBeLessThanOrEqual(203 + 1 / 64);
    // Letter-spaced: flagged where a line's width is within the letter-spacing of the room.
    const widths = Array.from({ length: 200 }, (_, i) => 120 + i);
    const flagged = widths.filter((w) => layoutText(m, text, 16, 400, w, { breaks: "all", letterSpacing: 1 }).approximate);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.length).toBeLessThan(widths.length);
  });
});
