/**
 * Regressions from field report #2: places where the engine said "fine" and Chromium disagreed.
 * Each is also verified in Chromium by: npm run conformance:field2
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { compile } from "../src/compile.js";
import { critique } from "../src/critique.js";
import { walk, type Layout } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";

const SRC = "fixtures/field2.cadesa.yaml";
const text = readFileSync(SRC, "utf8");
const model = modelOf(loadSource(SRC, text));
const fixture = parseFixture("fixtures/field2.html");
const box = (l: Layout, id: string) => [...walk(l.boxes)].find((b) => b.id === id)!;
const [phone, desktop] = render(model, fixture, [390, 1280]);

describe("field report #2 regressions", () => {
  it("1. aspect slots size images even when <img> has width/height attributes", () => {
    const css = compile(model);
    expect(css).toMatch(/\.ca-faq__cover \{\n  width: 100%;\n  aspect-ratio: 4 \/ 3;\n  height: auto;/);
    expect(box(desktop, "cover-1").w).toBe(box(desktop, "cover-2").w);
  });

  it("2. never breaks a line at U+202F or U+00A0, and keeps them through whitespace collapsing", () => {
    const words = box(phone, "words");
    expect(words.lines!.map((l) => l.text)).toEqual(["4 000 000+", "mots"]);
    expect(box(phone, "french").lines![0].text).toBe("100 % en");
    expect(phone.issues.map((i) => i.message)).toContain('"4 000 000+" in #words can\'t wrap and overflows by 13.85px at 390px');
  });

  it("3. a layer stretched by its parent re-centers its children", () => {
    const copy = box(desktop, "copy");
    const frame = box(desktop, "frame");
    expect(copy.h).toBe(box(desktop, "art").h);
    expect(frame.y - copy.y).toBeCloseTo((copy.h - frame.h) / 2, 9);
  });

  it("4. block children and <br> start new lines instead of joining words", () => {
    const answer = box(phone, "answer");
    expect(answer.lines!.map((l) => l.text)).toEqual([
      "Des outils professionnels.",
      "Développer une pratique quotidienne",
      "d’écriture.",
      "Première ligne",
      "Deuxième ligne",
    ]);
    expect(phone.issues.some((i) => /professionnels\.Développer/.test(i.message))).toBe(false);
  });

  it("5. contrast is checked against every gradient stop of a backdrop", () => {
    const pale = modelOf(loadSource(SRC, text.replace('band: "linear-gradient(90deg, #3730a3, #0f766e)"', 'band: "linear-gradient(90deg, #3730a3, #ccfbf1)"')));
    const f = check(render(pale, fixture, [1280])).find((x) => x.check === "contrast" && x.id === "words")!;
    expect(f.severity).toBe("error");
    expect(f.message).toMatch(/on #ccfbf1 is 1\.\d+:1.*gradient stop #ccfbf1/);
  });

  it("6. text over a layer image is reported as inconclusive, not passed", () => {
    const f = check([desktop]).find((x) => x.id === "title")!;
    expect(f.inconclusive).toBe(true);
    expect(f.message).toMatch(/sits over the image #art/);
  });

  it("7. critique reports a cluster that wraps even at the widest width", () => {
    const tight = modelOf(loadSource(SRC, text.replace("stat: 9rem", "stat: 30rem")));
    const c = critique(tight, fixture, render(tight, fixture, [390, 1280]));
    expect(c.find((x) => x.check === "wrap")!.message).toMatch(/^#stats wraps into 2 rows even at 1280px/);
  });
});

describe("benchmark gap: long words that must break", () => {
  it("wrap: anywhere breaks a word only when it can't fit on a line of its own", () => {
    const contact = box(phone, "contact");
    expect(contact.lines!.map((l) => l.text)).toEqual(["bookings@kvitfjor", "dpaddlingselskap", "et.example"]);
    expect(phone.issues.some((i) => i.id === "contact")).toBe(false);
    const mail = box(phone, "mail");
    expect(mail.lines![0].text).toBe("Write to"); // the whole word moves down before anything breaks
  });

  it("compiles to overflow-wrap: anywhere and lifts back", async () => {
    const { lift } = await import("../src/lift/lift.js");
    expect(compile(model)).toContain("overflow-wrap: anywhere;");
    const r = lift("t.css", ".c__a { font: 500 16px/24px Inter; color: #111; overflow-wrap: anywhere }");
    expect((r.data.text as Record<string, { wrap?: string }>).a.wrap).toBe("anywhere");
  });
});
