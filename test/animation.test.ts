/**
 * Animations are predicted at their start (t=0), where `--verify` holds them. Chromium's boxes come
 * from conformance:css (fixtures/css/animated.html).
 */
import { describe, expect, it } from "vitest";
import { longhands } from "../src/lift/page.js";
import { run } from "./lift-page.js";

const KF = `@keyframes rise { from { transform: translateY(12px) } to { transform: none } }
@keyframes slide { 0% { translate: -10px 4px } }
@keyframes wide { from { width: 50px } }
.a { height: 20px; margin: 0 0 10px }`;

describe("animations at their start", () => {
  it("splits the animation shorthand into its longhands, one item per animation", () => {
    expect(Object.fromEntries(longhands("animation", "rise .5s cubic-bezier(.2, .7, .2, 1) .1s both, slide 1s infinite reverse"))).toEqual({
      "animation-name": "rise, slide",
      "animation-duration": ".5s, 1s",
      "animation-timing-function": "cubic-bezier(.2, .7, .2, 1), ease",
      "animation-delay": ".1s, 0s",
      "animation-iteration-count": "1, infinite",
      "animation-direction": "normal, reverse",
      "animation-fill-mode": "both, none",
      "animation-play-state": "running, running",
    });
  });

  it("draws the starting keyframe when the animation runs from t=0 or fills backwards", () => {
    const r = run(
      `<div class="s0 a"></div><div class="s1 a"></div><div class="s2 a"></div><div class="s3 a"></div><div class="s4 a"></div><div class="s5 a"></div><div class="s6 a"></div>`,
      `${KF}
.s0 { animation: rise 1s }
.s1 { animation: rise 1s .5s }
.s2 { animation: rise 1s .5s backwards }
.s3 { animation: rise 1s reverse }
.s4 { animation: rise 1s paused; animation-delay: .2s; animation-fill-mode: both }
.s5 { transform: translateX(8px); animation: rise 1s, slide 1s }
.s6 { animation: var(--anim, rise .5s ease-out both) }`,
    );
    const y = (id: string) => r.box(id).y;
    expect(r.exact()).toBe(true);
    expect([y("s0"), y("s1"), y("s2"), y("s3"), y("s4"), y("s6")]).toEqual([12, 30, 72, 90, 132, 192]);
    // Both animations' properties apply; the keyframe's transform replaces the box's own.
    expect([r.box("s5").x, r.box("s5").y]).toEqual([-10, 150 + 12 + 4]);
  });

  it("leaves a start it doesn't model approximate", () => {
    const r = run(`<div class="n a"></div><div class="w a"></div><div class="st a"></div>`, `${KF}\n.n { animation: rise 1s -.5s }\n.w { animation: wide 1s }\n.st { animation: rise 1s steps(4, start) }`);
    expect(r.approx("n")).toMatch(/negative animation-delay/);
    expect(r.approx("w")).toMatch(/set width/);
    expect(r.approx("st")).toMatch(/jumps at the start/);
  });
});
