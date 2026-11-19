/** What check --verify measures for each kind of finding, and why it measures nothing for the rest. */
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/check.js";
import { probeOf, unmeasured } from "../src/verify.js";

const f = (check: Finding["check"], id: string, message: string) => ({ check, id, message, width: 400, severity: "warning", path: "" }) as Finding;

describe("probeOf", () => {
  it("measures each field-case finding", () => {
    expect(probeOf(f("layout", "card", "#text-1 overflows #card by 12px at 400px"))).toEqual({ kind: "overflow", id: "card", child: "text-1" });
    expect(probeOf(f("layout", "t", '"nonconformances" in #t can\'t wrap and overflows by 29.94px at 320px'))).toEqual({ kind: "wrap", id: "t" });
    expect(probeOf(f("layout", "t", "the text of #t doesn't wrap (white-space: nowrap) and overflows it by 4px at 320px"))).toEqual({ kind: "wrap", id: "t" });
    expect(probeOf(f("clipped", "t", "the text of #t is cut off at 320px: \"x\" needs 90px, the box shows 80px (overflow: hidden)"))).toEqual({ kind: "clip", id: "t", axis: "x" });
    expect(probeOf(f("layout", "b", "content of #b needs 30px but its height is 20px at 320px (2 lines)"))).toEqual({ kind: "height", id: "b" });
  });

  it("measures text cut off by its parent on the parent, which is what clips it", () => {
    expect(probeOf(f("clipped", "k", "the text of #k is cut off by #box at 320px: it ends 8px past #box's edge (overflow: hidden on #box)"))).toEqual({ kind: "clip", id: "box", axis: "x" });
  });

  it("says why the rest isn't measured", () => {
    const role = f("layout", "x", "#x contains text but has no text role; add text: <role> so it can be measured");
    expect(probeOf(role)).toBeUndefined();
    expect(unmeasured(role)).toBe("about what Cadesa can lay out, not about the page: nothing to measure");
    expect(unmeasured(f("spacing", "x", '"Total" and "42" run together'))).toMatch(/markup and the CSS/);
  });
});
