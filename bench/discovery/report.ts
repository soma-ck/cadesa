/**
 * Summarize a discovery results file as a Markdown table, plus how each arm looked at the page.
 *
 *   npx tsx bench/discovery/report.ts bench/results/discovery-<stamp>.json
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: report.ts <results.json>");
const { results } = JSON.parse(readFileSync(file, "utf8")) as { results: any[] };

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const tasks = [...new Set(results.map((r) => r.task))];
const arms = ["css", "cadesa"];

/** Distinct widths an agent looked at, through screenshots or Cadesa commands. */
function widthsSeen(tools: string[]) {
  const shots = new Set<number>(), engine = new Set<number>();
  for (const t of tools) {
    const m = t.match(/preview\.mjs\s+([\d,]+)/);
    if (m) m[1].split(",").map(Number).forEach((w) => shots.add(w));
    const c = t.match(/\.\/cadesa\s+(check|render|whatif|explain)[^|;&]*--widths\s+([\d,]+)/);
    if (c) c[2].split(",").map(Number).forEach((w) => engine.add(w));
  }
  return { shots: shots.size, engine: engine.size };
}

console.log("| task | arm | solved | goal met | defects shipped (mean) | trials shipping a defect | collateral boxes (mean) | trials with collateral | tool calls | cost / trial | time / trial |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const task of tasks)
  for (const arm of arms) {
    const rs = results.filter((r) => r.task === task && r.arm === arm);
    if (!rs.length) continue;
    const n = rs.length;
    console.log(
      `| ${task} | ${arm} | ${rs.filter((r) => r.solved).length}/${n} | ${rs.filter((r) => r.goal.ok).length}/${n} | ${mean(rs.map((r) => r.shipped)).toFixed(1)} | ${rs.filter((r) => r.shipped > 0).length}/${n} | ${mean(rs.map((r) => r.collateral.elements)).toFixed(1)} | ${rs.filter((r) => r.collateral.elements > 0).length}/${n} | ${mean(rs.map((r) => r.toolCalls)).toFixed(1)} | $${mean(rs.map((r) => r.costUsd)).toFixed(2)} | ${mean(rs.map((r) => r.ms / 1000)).toFixed(0)}s |`,
    );
  }
for (const arm of arms) {
  const rs = results.filter((r) => r.arm === arm);
  console.log(
    `| **all** | ${arm} | ${rs.filter((r) => r.solved).length}/${rs.length} | ${rs.filter((r) => r.goal.ok).length}/${rs.length} | ${mean(rs.map((r) => r.shipped)).toFixed(2)} | ${rs.filter((r) => r.shipped > 0).length}/${rs.length} | ${mean(rs.map((r) => r.collateral.elements)).toFixed(1)} | ${rs.filter((r) => r.collateral.elements > 0).length}/${rs.length} | ${mean(rs.map((r) => r.toolCalls)).toFixed(1)} | $${mean(rs.map((r) => r.costUsd)).toFixed(2)} | ${mean(rs.map((r) => r.ms / 1000)).toFixed(0)}s |`,
  );
}
console.log(`\ntotal cost in this file: $${sum(results.map((r) => r.costUsd)).toFixed(2)} over ${results.length} runs`);

console.log("\nHow agents looked (mean per trial): distinct widths screenshotted · distinct widths given to Cadesa commands · runs using check / whatif / critique / screenshots");
for (const task of tasks)
  for (const arm of arms) {
    const rs = results.filter((r) => r.task === task && r.arm === arm);
    if (!rs.length) continue;
    const seen = rs.map((r) => widthsSeen(r.tools));
    const uses = (re: RegExp) => rs.filter((r) => r.tools.some((t: string) => re.test(t))).length;
    console.log(
      `  ${task.padEnd(12)} ${arm.padEnd(7)} shots ${mean(seen.map((s) => s.shots)).toFixed(1)} · engine ${mean(seen.map((s) => s.engine)).toFixed(1)} · check ${uses(/cadesa check/)}/${rs.length} · whatif ${uses(/cadesa whatif/)}/${rs.length} · critique ${uses(/cadesa critique/)}/${rs.length} · screenshots ${uses(/preview\.mjs/)}/${rs.length}`,
    );
  }

console.log("\nEvery defect and collateral change shipped:");
for (const r of results)
  if (!r.solved)
    console.log(
      `  ${r.task} ${r.arm} #${r.trial}: ${Object.entries(r.defects.where as Record<string, number[]>)
        .map(([k, ws]) => `${k} @${ws.length > 4 ? `${ws.length} widths (${ws[0]}–${ws[ws.length - 1]})` : ws.join(",")}`)
        .join("; ") || "no defects"}${r.collateral.elements ? ` · collateral ${r.collateral.elements} boxes in ${r.collateral.sections.join(", ")} (e.g. ${r.collateral.examples[0]})` : ""}${r.goal.ok ? "" : ` · goal not met: ${r.goal.detail}`}`,
    );
