/**
 * Each box's own cause of ≈ (not the ones it inherits from boxes that move it), at some widths:
 *
 *   npx tsx scripts/own-causes.ts --css a.css,b.css --fixture page.html [--widths 400,800]
 */
import { parseArgs } from "node:util";
import { cssPageFile, tailwindImpact } from "../src/commands.js";
import { walk } from "../src/engine/layout.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";

const { values } = parseArgs({ options: { css: { type: "string" }, fixture: { type: "string" }, widths: { type: "string", default: "400,800" } } });
const t = cssPageFile(values.fixture!, values.css!, 800);
const m = modelOf(loadSource(values.fixture!, t.yaml));
for (const w of values.widths!.split(",").map(Number)) {
  const l = render(m, t.fixtureAt(w), [w])[0];
  const imp = tailwindImpact(t, [l])[0];
  console.log(`@${w}`);
  for (const b of walk(l.boxes)) {
    const u = imp.uncertain.find((x) => x.id === b.id);
    const own = [...(u?.reasons ?? []), ...b.assumptions].filter((r) => !/^(moved|resized|stretched) (by|with)|^geometry depends on/.test(r));
    if (own.length) console.log(`  #${b.id}: ${own[0].slice(0, 200)}`);
  }
}
