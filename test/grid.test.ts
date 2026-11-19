/**
 * CSS Grid: templates, placement and track sizing (src/engine/grid.ts), and atomic inlines in
 * text. The fixtures are checked against Chromium at every width by conformance:css
 * (fixtures/css/grid.html, fixtures/css/icons.html); the numbers here are Chromium's.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandTracks, parseArea, parseAreas, parseLinePair, parseTrackList, place, sizeTracks, trackSize } from "../src/engine/grid.js";
import { run } from "./lift-page.js";

const geo = (b: { x: number; y: number; w: number; h: number }) => [b.x, b.y, b.w, b.h].map((n) => +n.toFixed(3));
const fixture = (name: string, widths: number[]) => {
  const html = readFileSync(`fixtures/css/${name}.html`, "utf8").replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, "");
  return run(html, readFileSync(`fixtures/css/${name}.css`, "utf8"), widths, { bare: true });
};

describe("grid templates", () => {
  it("reads track sizes", () => {
    expect(trackSize("1fr")).toEqual({ min: "auto", max: { fr: 1 } });
    expect(trackSize("minmax(120px, 1fr)")).toEqual({ min: { len: 120 }, max: { fr: 1 } });
    expect(trackSize("fit-content(160px)")).toEqual({ min: "auto", max: "max-content", fit: 160 });
    expect(trackSize("25%")).toEqual({ min: { len: { pct: 25 } }, max: { len: { pct: 25 } } });
    expect(trackSize("minmax(1fr, 2fr)")).toBeUndefined();
  });

  it("reads track lists with line names and repeat()", () => {
    const l = parseTrackList("[full-start] 16px [content-start] repeat(2, 1fr) [content-end] 16px [full-end]")!;
    expect(l.tracks.length).toBe(4);
    expect(l.names).toEqual([["full-start"], ["content-start"], [], ["content-end"], ["full-end"]]);
    expect(parseTrackList("subgrid")).toBeUndefined();
  });

  it("repeats auto-fill tracks as many times as they fit", () => {
    const l = parseTrackList("repeat(auto-fill, 100px)")!;
    expect(expandTracks(l, 430, 10).tracks.length).toBe(4);
    expect(expandTracks(l, 420, 10).tracks.length).toBe(3);
    expect(expandTracks(l, 50, 10).tracks.length).toBe(1);
  });

  it("reads areas and lines", () => {
    expect(parseAreas(["head head", "side main"])!.areas.get("head")).toEqual({ r0: 0, r1: 1, c0: 0, c1: 2 });
    expect(parseAreas(["a b", "b a"])).toBeUndefined();
    expect(parseLinePair("1 / -1")).toEqual({ start: { n: 1 }, end: { n: -1 } });
    expect(parseLinePair("span 2")).toEqual({ start: { span: 2 }, end: { auto: true } });
    expect(parseArea("1 / 1")).toEqual({ row: { start: { n: 1 }, end: { auto: true } }, column: { start: { n: 1 }, end: { auto: true } } });
  });
});

describe("grid placement", () => {
  const auto = { start: { auto: true as const }, end: { auto: true as const } };
  const ex = { cols: 3, rows: 0, colNames: [[], [], [], []], rowNames: [[]] };
  it("auto-places items row by row, around items placed on lines", () => {
    const r = place(ex, [{ row: auto, column: { start: { n: 2 }, end: { auto: true } } }, { row: auto, column: auto }, { row: auto, column: auto }], false);
    expect("areas" in r && r.areas.map((a) => [a.r0, a.c0])).toEqual([[0, 1], [0, 2], [1, 0]]);
  });
  it("stacks items on one cell (grid-area: 1 / 1)", () => {
    const one = parseArea("1 / 1")!;
    const r = place({ ...ex, cols: 1, colNames: [[], []] }, [one, one], false);
    expect("areas" in r && r.areas).toEqual([{ r0: 0, r1: 1, c0: 0, c1: 1 }, { r0: 0, r1: 1, c0: 0, c1: 1 }]);
  });
  it("fills earlier holes when dense", () => {
    const wide = { row: auto, column: { start: { span: 2 }, end: { auto: true as const } } };
    const r = place(ex, [{ row: auto, column: auto }, wide, wide, { row: auto, column: auto }], true);
    expect("areas" in r && r.areas.map((a) => [a.r0, a.c0])).toEqual([[0, 0], [0, 1], [1, 0], [1, 2]]);
  });
});

describe("grid track sizing", () => {
  const item = (a: number, b: number, min: number, max: number) => ({ a, b, minContent: min, maxContent: max, minimum: min });
  it("gives a 1fr auto 1fr bar equal outer columns around its content", () => {
    expect(sizeTracks([trackSize("1fr")!, trackSize("auto")!, trackSize("1fr")!], [item(0, 1, 30, 40), item(1, 2, 60, 150), item(2, 3, 30, 40)], 10, 500, true)).toEqual([165, 150, 165]);
  });
  it("sizes min-content, max-content and fit-content() columns", () => {
    const ts = ["min-content", "max-content", "fit-content(100px)"].map((t) => trackSize(t)!);
    expect(sizeTracks(ts, [item(0, 1, 50, 200), item(1, 2, 50, 200), item(2, 3, 50, 200)], 0, 1000, false)).toEqual([50, 200, 100]);
  });
  it("grows tracks for an item spanning them", () => {
    const ts = ["auto", "auto"].map((t) => trackSize(t)!);
    expect(sizeTracks(ts, [item(0, 2, 100, 100)], 0, "max-content", false)).toEqual([50, 50]);
  });
});

describe("the grid fixture", () => {
  const r = fixture("grid", [360, 1000]);
  it("is exact", () => {
    expect(r.exact(360)).toBe(true);
    expect(r.exact(1000)).toBe(true);
  });
  it("centers the title between equal columns and stacks the hero's layers in one cell", () => {
    const [back, title, menu] = ["bar-back", "bar-title", "bar-menu"].map((id) => r.box(id, 1000));
    expect(back.x).toBe(16);
    expect(menu.x + menu.w).toBe(1000 - 16);
    // 1fr auto 1fr: the outer columns are equal, so the title is centered.
    expect(title.x + title.w / 2).toBeCloseTo(500, 1);
    expect(r.box("hero-copy", 1000).y).toBeGreaterThan(r.box("hero-art", 1000).y);
    expect(r.box("hero-badge", 1000).y).toBe(r.box("hero-art", 1000).y + 8);
  });
});

describe("atomic inlines and zero-size text", () => {
  const r = fixture("icons", [400, 800]);
  it("is exact", () => {
    expect(r.exact(400)).toBe(true);
    expect(r.exact(800)).toBe(true);
  });
  it("puts a hidden label's line height in the box and no width (font-size: 0)", () => {
    expect(geo(r.box("toolbar-button", 400))).toEqual([16, geo(r.box("toolbar-button", 400))[1], 42, 34]);
  });
});

describe("hidden inputs", () => {
  it("lays out no box for <input type=hidden> (display: none in Chromium's stylesheet)", () => {
    const r = run(`<form class="f"><input type="hidden" name="token"><p class="p">After</p></form>`, `p { margin: 0 }`, [400]);
    expect(r.box("p").y).toBe(0);
    expect(r.exact()).toBe(true);
  });
});

describe("icon fonts and initial values", () => {
  it("collects the characters a font's text uses beyond the measured set (icon codepoints), for --measure", async () => {
    const { fontUses } = await import("../src/fonts.js");
    const r = run(`<p class="i"></p>`, `.i::before { content: "\\f0ac"; font-family: "Icons" } .i { font-family: "Icons" }`, [400]);
    const u = fontUses(r.layouts).find((x) => x.family === "Icons")!;
    expect(u.chars).toBe("");
  });
  it("never makes a box approximate for a property at its initial value", async () => {
    const { isInitial } = await import("../src/lift/page.js");
    expect(isInitial("font-variant", "normal")).toBe(true);
    expect(isInitial("font-variant", "small-caps")).toBe(false);
    expect(isInitial("min-width", "0")).toBe(false);
    const r = run(`<p class="t">Plain words</p>`, `.t { font-variant: normal; text-transform: none; float: none; filter: none; font-feature-settings: normal }`, [400]);
    expect(r.exact()).toBe(true);
  });
});
