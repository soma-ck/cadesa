/**
 * Words broken between characters (overflow-wrap: anywhere): where each fragment ends, as Chromium
 * breaks them (recorded with a random tester against Chromium 153; see layoutText's fitsFrag).
 */
import { describe, expect, it } from "vitest";
import { layoutText, metricsFor } from "../src/engine/text.js";

const starts = (family: string, size: number, weight: number, width: number, text: string) => {
  const l = layoutText(metricsFor(family)!, text, size, weight, width, { wrapAnywhere: true });
  return { at: l.lines.slice(1).map((x) => x.at), approximate: l.approximate };
};

describe("a word broken between characters close to the line's width", () => {
  it("fits a fragment by its width kerned to what follows, and on its own where the break isn't safe", () => {
    // "2.gLbk0T" fits kerned to the "a" after it (88.82px) but not on its own (90.28px in 89.97px): T goes down.
    expect(starts("Inter", 20, 400, 89.97, "29mw39xkKcbFp2.gLbk0Tai0wgaj")).toEqual({ at: [6, 13, 20] });
    // "grr" fits on its own (30.40px in 30.69px) but not kerned to the next "r" (30.74px).
    expect(starts("Inter", 22, 400, 30.69, "Id: r.wqij-3c/al-3F4LkLmed2F-grrraPnlKcVPPmlAyVWlau").at).toContain(31);
  });

  it("counts a layout unit of slack, as a line does", () => {
    // "sc7vPicd/vv2a" is 76.1525px: within 76.15px rounded down to a layout unit, plus one.
    expect(starts("Lato", 12, 400, 76.15, "sc7vPicd/vv2aaVr")).toEqual({ at: [13] });
  });

  it("flags a fragment the font kerns at both ends and inside that fits only in the word's shaping", () => {
    // "VA" in "AVATAR" (Inter 300, 28px): 33.41px in its shaping, 35.79px on its own, in 34px.
    const r = starts("Inter", 28, 300, 34, "AVATAR");
    expect(r.at).toEqual([1, 3, 4, 5]);
    expect(r.approximate).toMatch(/kerns at both ends/);
  });
});
