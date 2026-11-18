import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { walk } from "../src/engine/layout.js";
import { parseFixture } from "../src/fixture.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";
import { wireframeSvg } from "../src/wireframe.js";

describe("render --svg wireframe", () => {
  const SRC = "examples/landing/landing.cadesa.yaml";
  const [l] = render(modelOf(loadSource(SRC, readFileSync(SRC, "utf8"))), parseFixture("examples/landing/landing.html"), [768]);
  const svg = wireframeSvg(l);

  it("draws one outline per box and one bar per predicted line, at the page's width", () => {
    const boxes = [...walk(l.boxes)];
    const lines = boxes.reduce((n, b) => n + (b.lines?.length ?? 0), 0);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 ')).toBe(true);
    // 1 background rect + one outline per box + one bar per line
    expect((svg.match(/<rect /g) ?? []).length).toBe(1 + boxes.length + lines);
    expect(svg).toContain(">#hero</text>");
  });

  it("marks boxes with issues in red", () => {
    const html = '<section class="ca-trips"><p class="ca-trips__intro" data-fixture="w">Supercalifragilisticexpialidociousnessless</p></section>';
    const [bad] = render(modelOf(loadSource(SRC, readFileSync(SRC, "utf8"))), parseFixture("x.html", html), [320]);
    expect(bad.issues.length).toBeGreaterThan(0);
    expect(wireframeSvg(bad)).toContain('stroke="#e5484d"');
  });
});
