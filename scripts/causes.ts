/**
 * Why boxes are ≈: lift pages with their CSS (as `--css` does), lay them out at every width, and rank
 * the causes of every box the engine marks uncertain by how many boxes (box × width) each one
 * reaches. A box with several causes counts once for each.
 *
 *   npx tsx scripts/causes.ts --css a.css,b.css --fixtures p1.html,p2.html [--widths 320-1440/10] [--top 30]
 */
import { parseArgs } from "node:util";
import { cssPageFile, parseWidths, tailwindImpact } from "../src/commands.js";
import { walk } from "../src/engine/layout.js";
import { loadSource } from "../src/load.js";
import { modelOf, render } from "../src/project.js";

const { values } = parseArgs({
  options: {
    css: { type: "string" },
    fixtures: { type: "string" },
    widths: { type: "string", default: "320-1440/10" },
    top: { type: "string", default: "30" },
    examples: { type: "boolean", default: false },
  },
});
const widths = parseWidths(values.widths!);
const counts = new Map<string, number>();
const example = new Map<string, string>();
let total = 0;
let exact = 0;

/** The underlying cause of a reason: without "moved by #x:" and line numbers, numbers generalised. */
function cause(r: string): string {
  let s = r.replace(/^(moved|resized) by #[\w-]+: /, "");
  const dep = /^geometry depends on #[\w-]+, which the engine can't guarantee \((.*)\)$/s.exec(s);
  if (dep) s = dep[1];
  s = s.replace(/^\S+\.(?:html|css)(?::\d+)? /, "");
  s = s.replace(/\(\S+\.(?:html|css):\d+\)/g, "");
  s = s.replace(/#[\w-]+/g, "#…").replace(/-?\d+(\.\d+)?(px|%|rem|em)?/g, "N$2");
  return s.replace(/\s+/g, " ").trim().slice(0, 220);
}

for (const page of values.fixtures!.split(",")) {
  const t = cssPageFile(page, values.css!);
  const model = modelOf(loadSource(`${page} (lifted)`, t.yaml));
  const layouts = widths.map((w) => render(model, t.fixtureAt(w), [w])[0]);
  const impacts = tailwindImpact(t, layouts);
  layouts.forEach((l, i) => {
    const unc = new Map(impacts[i].uncertain.map((u) => [u.id, u]));
    for (const b of walk(l.boxes)) {
      if (b.anonymous) continue;
      total++;
      const reasons = new Set<string>();
      for (const a of b.assumptions) reasons.add(cause(a));
      const direct = new Set<string>();
      for (const r of unc.get(b.id)?.reasons ?? []) {
        reasons.add(cause(r));
        if (!/^(moved|resized) by/.test(r)) direct.add(cause(r));
      }
      for (const a of b.assumptions) if (!/^geometry depends/.test(a)) direct.add(cause(a));
      if (!reasons.size) exact++;
      for (const r of reasons) {
        counts.set(r, (counts.get(r) ?? 0) + 1);
        if (direct.has(r)) example.set(r, [...new Set([...(example.get(r) ?? "").split(" ").filter(Boolean), `${page.replace(/^.*\//, "")}#${b.id}`])].slice(0, 6).join(" "));
      }
    }
  });
}
console.log(`${total} boxes (box × width): ${exact} exact, ${total - exact} ≈\n`);
for (const [r, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, Number(values.top))) {
  console.log(`${String(n).padStart(6)}  ${r}`);
  if (values.examples) console.log(`        e.g. ${example.get(r)}`);
}
