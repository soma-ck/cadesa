/** Shared by tests: lift a page with plain CSS, lay it out at some widths and check it. */
import { check } from "../src/check.js";
import { tailwindImpact } from "../src/commands.js";
import { walk, type Box, type Layout } from "../src/engine/layout.js";
import { liftCssPage } from "../src/lift/css-page.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";

const FONT = `body { margin: 0; font: 16px/1.5 Inter, sans-serif; color: #111111; background: #ffffff }`;

/** Lift `body` with `css` (after a zero-margin Inter body unless `bare`), lay it out and check it. */
export function run(body: string, css: string, widths = [400], opts: { bare?: boolean; head?: string; height?: number } = {}) {
  const t = liftCssPage("t.html", `<!doctype html><html><head>${opts.head ?? ""}<link rel="stylesheet" href="t.css"></head><body>${body}</body></html>`, [{ file: "t.css", text: opts.bare ? css : `${FONT}\n${css}` }], undefined, { height: opts.height });
  const m = modelOf(loadSource("t.html (lifted)", t.yaml));
  const layouts = widths.map((w) => render(m, t.fixtureAt(w), [w])[0]);
  const impacts = tailwindImpact(t, layouts);
  const findings = check(layouts, impacts, t);
  const box = (id: string, w = widths[0]): Box => [...walk(layouts[widths.indexOf(w)].boxes)].find((b) => b.id === id)!;
  const approx = (id: string, w = widths[0]) => {
    const i = impacts[widths.indexOf(w)].uncertain.find((u) => u.id === id);
    const b = box(id, w);
    return i ? i.reasons[0] : b?.assumptions[0];
  };
  const exact = (w = widths[0]) => [...walk(layouts[widths.indexOf(w)].boxes)].filter((b) => !b.anonymous).every((b) => !approx(b.id, w));
  return { t, m, layouts, impacts, findings, box, approx, exact, layout: (w = widths[0]): Layout => layouts[widths.indexOf(w)] };
}
