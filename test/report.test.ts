import { describe, expect, it } from "vitest";
import { clip, rootCause } from "../src/report.js";

describe("rootCause: one readable cause per ≈ reason", () => {
  const cases: [string, string][] = [
    ["/x/a.html:2 .page-module__x__screen (/x/a.css:2) → min-height: 100vh: min-height is not modelled", "min-height: 100vh: min-height isn't modelled"],
    ["/x/a.html:2 browser default (content-box) → box-sizing: content-box: Cadesa boxes are border-box", "box-sizing: content-box: Cadesa boxes are border-box"],
    [
      "resized by #x: /x/a.html:6 display: inline-block: an inline-level box in block flow sits on a line box (baseline, line height, whitespace); Cadesa lays out block boxes",
      "display: inline-block: an inline-level box in block flow sits on a line box",
    ],
    [
      "/x/has.html:1 /x/has.css:3 body:has(.app-shell) { overflow: hidden } on <body>: the selector body:has(.app-shell) may match; Cadesa can't decide it",
      "overflow: hidden: Cadesa can't decide whether body:has(.app-shell) matches",
    ],
    ['/x/row.html:1 style="height: 100vh" → height: 100vh: height must be a px or rem length', "height: 100vh: height must be a px or rem length"],
    [".zoomed (/x/page.css:40) → transform: scale(3): transform is not modelled", "transform: scale(3): transform isn't modelled"],
    ["/x/d.html:3 .detail-row (row-gap: 4px): the row wraps at 400px and its row gap differs from its column gap; a cluster has one gap", "row-gap: 4px: the row wraps and its row gap differs from its column gap"],
    ["/x/p.html:0 min-h-screen (min-height: 100vh) on <body>: page-level min-height is not modelled", "min-height: 100vh: page-level min-height isn't modelled"],
    ["/x/p.html:4 <select>: <select> without a width (w-*) takes its intrinsic width, which Cadesa doesn't know", "<select>: <select> without a width takes its intrinsic width, which Cadesa doesn't know"],
  ];
  for (const [raw, want] of cases) it(want, () => expect(rootCause(raw)).toBe(want));

  it("groups the same cause from different selectors", () => {
    expect(rootCause("/x/a.html:2 .a (/x/a.css:2) → min-height: 100vh: min-height is not modelled")).toBe(
      rootCause("/x/a.html:9 .b-very-long-module__name (/x/b.css:7) → min-height: 100vh: min-height is not modelled"),
    );
  });

  it("never ends mid-word", () => {
    const long = "/x/a.html:2 .a (/x/a.css:2) → width: 10px: " + "the quick brown fox jumps over the lazy dog ".repeat(4);
    const r = rootCause(long);
    expect(r.length).toBeLessThanOrEqual(100);
    expect(r).toMatch(/(?:fox|jumps|over|the|lazy|dog|quick|brown)…$/);
  });

  it("clip cuts at a word boundary", () => {
    expect(clip("min-height is not modelled anywhere", 20)).toBe("min-height is not…");
    expect(clip("short", 20)).toBe("short");
  });
});
