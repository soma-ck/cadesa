/**
 * Discovery benchmark: give an agent a realistic change request on a six-section page and count,
 * in Chromium, the latent defects and collateral changes that ship. Nobody tells the agent where
 * the page breaks.
 *
 *   npm run build:ts && npx tsx bench/discovery/run.ts [--tasks a,b] [--arms css,cadesa] [--trials 5]
 *     [--max-turns 30] [--run-budget 2] [--budget 45] [--model sonnet]
 *   npx tsx bench/discovery/run.ts --verify     # prove each task is fair (no model calls)
 *
 * Protocol (identical for both arms; see bench/RESULTS.md, run 3):
 *   - Same page, same starting pixels: the CSS arm starts from the CSS that the Cadesa arm's source
 *     compiles to.
 *   - One headless `claude -p` run per trial, one submission, at most --max-turns turns.
 *   - Both arms: `node preview.mjs <widths>` screenshots at any widths. Cadesa arm additionally:
 *     `./cadesa check | render | whatif | explain | critique | validate`.
 *   - The prompt states the definition of done (the defect classes below) but not where it fails.
 *   - The judge measures the shipped page in Chromium at every 20px from 320 to 1440px.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright";
import { compile } from "../../src/compile.js";
import { CadesaError, formatDiagnostic } from "../../src/diagnostics.js";
import { loadSource } from "../../src/load.js";
import { findChrome } from "../../src/metrics.js";
import { modelOf } from "../../src/project.js";
import { collateral, hidden, KINDS, SHIPPED, summarize, sweep, type Collateral, type DefectSummary, type Snapshot } from "./judge.js";
import { fourthPlanHtml, TASKS, type DiscoveryTask } from "./tasks.js";

const { values } = parseArgs({
  options: {
    tasks: { type: "string" },
    arms: { type: "string", default: "css,cadesa" },
    trials: { type: "string", default: "5" },
    model: { type: "string", default: "sonnet" },
    "max-turns": { type: "string", default: "30" },
    "run-budget": { type: "string", default: "2" },
    budget: { type: "string", default: "45" },
    ledger: { type: "string", default: "bench/results/discovery-ledger.json" },
    label: { type: "string", default: "" },
    out: { type: "string", default: "bench/results" },
    verify: { type: "boolean", default: false },
  },
});

type Arm = "css" | "cadesa";
const REPO = resolve(".");
const CLI = join(REPO, "lib", "cli.js");
const SOURCE = readFileSync("bench/discovery/page.cadesa.yaml", "utf8");
const MAX_TURNS = Number(values["max-turns"]);
const tasks: DiscoveryTask[] = values.tasks
  ? values.tasks.split(",").map((id) => TASKS.find((t) => t.id === id) ?? (() => { throw new Error(`unknown task ${id}`); })())
  : TASKS;

const compileYaml = (yaml: string) => compile(modelOf(loadSource("page.cadesa.yaml", yaml)));
const htmlOf = (task: DiscoveryTask) => (task.html === "fourth-plan" ? fourthPlanHtml() : readFileSync(task.html, "utf8"));

/** A directory the judge can serve: page.html + page.css + font + images. */
function pageDir(html: string, css: string, prefix = "cadesa-disc-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "page.html"), html);
  writeFileSync(join(dir, "page.css"), css);
  cpSync(join(REPO, "fonts", "InterVariable-latin.woff2"), join(dir, "InterVariable-latin.woff2"));
  cpSync(join(REPO, "examples", "landing", "assets"), join(dir, "assets"), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------- agent workspace

const PREVIEW = (arm: Arm) => `// node preview.mjs 320,768,1280  →  full-page and per-section screenshots of page.html
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from ${JSON.stringify(join(REPO, "node_modules", "playwright", "index.mjs"))};
const widths = (process.argv[2] ?? "390,1280").split(",").map(Number).filter((w) => w >= 200 && w <= 2000);
if (!widths.length) { console.error("usage: node preview.mjs <comma-separated widths>"); process.exit(1); }
${arm === "cadesa" ? `execFileSync("node", [${JSON.stringify(CLI)}, "build", "page.cadesa.yaml", "--out", "page.css"], { stdio: "inherit" });\n` : ""}const browser = await chromium.launch(${JSON.stringify({ executablePath: findChrome() })});
const written = [];
for (const width of widths) {
  mkdirSync(\`shots/\${width}\`, { recursive: true });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(new URL("page.html", import.meta.url).href);
  await page.evaluate("document.fonts.ready");
  await page.screenshot({ path: \`shots/\${width}/full.png\`, fullPage: true });
  written.push(\`shots/\${width}/full.png\`);
  for (const name of ["nav", "hero", "trips", "pricing", "closing", "footer"]) {
    const el = page.locator(\`body > [data-fixture="\${name}"]\`);
    await el.screenshot({ path: \`shots/\${width}/\${name}.png\` });
    written.push(\`shots/\${width}/\${name}.png\`);
  }
  await page.close();
}
await browser.close();
console.log("wrote " + written.join(", ") + "\\nRead the PNGs to see them (full.png is the whole page, scaled down when it is tall; the per-section shots are sharper).");
`;

function workspace(task: DiscoveryTask, arm: Arm): string {
  const dir = pageDir(htmlOf(task), compileYaml(SOURCE), `cadesa-disc-${task.id}-${arm}-`);
  if (arm === "cadesa") {
    writeFileSync(join(dir, "page.cadesa.yaml"), SOURCE);
    writeFileSync(join(dir, "cadesa"), `#!/bin/sh\nexec node ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  }
  writeFileSync(join(dir, "preview.mjs"), PREVIEW(arm));
  return dir;
}

export function prompt(task: DiscoveryTask, arm: Arm): string {
  const file = arm === "css" ? "page.css" : "page.cadesa.yaml";
  const what =
    arm === "css"
      ? "page.css styles it"
      : "page.cadesa.yaml styles it: it is a Cadesa source, a small YAML styling language that compiles to page.css (never edit page.css directly)";
  const cadesaTools = `
- \`./cadesa check page.html --source page.cadesa.yaml --widths <widths>\` reports overflow, tap targets, contrast and line length at those widths, without a browser.
- \`./cadesa render page.html --source page.cadesa.yaml --widths <widths> [--lines]\` lists every box (x, y, w×h), and with --lines every wrapped text line.
- \`./cadesa whatif page.html --source page.cadesa.yaml --widths <widths> --set <yaml.path>=<value> [--set ...]\` predicts what an edit changes at each width, without writing it.
- \`./cadesa explain page.html --source page.cadesa.yaml --id <data-fixture id> --widths <widths>\` shows where each value comes from.
- \`./cadesa critique page.html --source page.cadesa.yaml\` reports design signals (type scale, hierarchy, grouping).
- \`./cadesa validate page.cadesa.yaml\` checks the source. An invalid source ships nothing.
Every --widths option takes any comma-separated list of widths. Run \`./cadesa --help\` for details.`;
  return `You are a front-end developer working on a marketing page. page.html is the page; ${what}.

Request: ${task.request}

Definition of done: the page must work at every viewport width from 320px to 1440px.
- Nothing overflows horizontally: no element sticks out of its container or the screen, and no text runs past the edge of its box.
- No text spills out of a fixed-height box.
- Every link and button is at least 24×24px (44×44px is better).
- No line of text is longer than 80 characters.
- Elements don't overlap, and no content is hidden.
- Sections the request doesn't concern keep their current layout.

Rules:
- Edit only ${file}. Don't change page.html.
- You have a budget of ${MAX_TURNS} turns (tool calls), so verify efficiently. When you're done, reply with a short summary of what you changed.

Tools:
- \`node preview.mjs <widths>\` ${arm === "cadesa" ? "compiles page.cadesa.yaml, then " : ""}writes screenshots of page.html at the given comma-separated viewport widths (any widths, e.g. \`node preview.mjs 320,768,1280\`): shots/<width>/full.png and one per section (nav, hero, trips, pricing, closing, footer). Read the PNGs to see them.${arm === "cadesa" ? cadesaTools : ""}
`;
}

interface AgentRun {
  turns: number;
  toolCalls: number;
  tools: string[];
  costUsd: number;
  ms: number;
  stop: string;
  reply: string;
}

function runClaude(dir: string, arm: Arm, text: string): AgentRun {
  const allowed = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(node preview.mjs:*)", ...(arm === "cadesa" ? ["Bash(./cadesa:*)"] : [])];
  const t0 = Date.now();
  const r = spawnSync(
    "claude",
    ["-p", text, "--output-format", "stream-json", "--verbose", "--model", values.model!, "--max-turns", String(MAX_TURNS), "--max-budget-usd", values["run-budget"]!, "--permission-mode", "acceptEdits", "--allowedTools", ...allowed, "--strict-mcp-config", "--no-session-persistence"],
    { cwd: dir, encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 256 * 1024 * 1024 },
  );
  const tools: string[] = [];
  let result: Record<string, unknown> | undefined;
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    let j: Record<string, any>;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type === "assistant")
      for (const c of j.message?.content ?? [])
        if (c.type === "tool_use") tools.push(c.name === "Bash" ? `Bash: ${String(c.input?.command ?? "").slice(0, 160)}` : `${c.name}${c.input?.file_path ? `: ${String(c.input.file_path).split("/").pop()}` : ""}`);
    if (j.type === "result") result = j;
  }
  if (!result) return { turns: 0, toolCalls: tools.length, tools, costUsd: 0, ms: Date.now() - t0, stop: "crashed", reply: `claude failed: ${(r.stderr || String(r.error)).slice(0, 400)}` };
  return {
    turns: Number(result.num_turns ?? 0),
    toolCalls: tools.length,
    tools,
    costUsd: Number(result.total_cost_usd ?? 0),
    ms: Number(result.duration_ms ?? Date.now() - t0),
    stop: String(result.subtype ?? ""),
    reply: String(result.result ?? "").slice(0, 1200),
  };
}

// ---------------------------------------------------------------- judging

interface Verdict {
  goal: { ok: boolean; detail: string };
  defects: DefectSummary;
  shipped: number;
  collateral: Collateral;
  invalid?: string;
}

function judge(task: DiscoveryTask, start: Snapshot[], now: Snapshot[], invalid?: string): Verdict {
  const extra = new Map<number, ReturnType<typeof hidden>>();
  for (let i = 0; i < now.length; i++) extra.set(now[i].width, hidden([start[i]], [now[i]]));
  const defects = summarize(now, extra);
  const goal = invalid ? { ok: false, detail: `invalid source: ${invalid.slice(0, 300)}` } : task.goal(start, now);
  return { goal, defects, shipped: SHIPPED(defects), collateral: collateral(start, now, task.untouched(start)), invalid };
}

const fmtWhere = (s: DefectSummary) =>
  Object.entries(s.where)
    .map(([k, ws]) => `${k} @${ws.length > 3 ? `${ws[0]}–${ws[ws.length - 1]} (${ws.length} widths)` : ws.join(",")}`)
    .join("; ") || "none";

const browser: Browser = await chromium.launch({ executablePath: findChrome() });

// ---------------------------------------------------------------- --verify

if (values.verify) {
  let bad = 0;
  for (const task of tasks) {
    const html = htmlOf(task);
    const startCss = compileYaml(SOURCE);
    const start = await sweep(browser, pageDir(html, startCss));
    const v0 = judge(task, start, start);
    const sol = judge(task, start, await sweep(browser, pageDir(html, compileYaml(task.solution(SOURCE)))));
    const naive: [string, Verdict][] = [];
    if (task.naive.cadesa) naive.push(["naive (Cadesa source)", judge(task, start, await sweep(browser, pageDir(html, compileYaml(task.naive.cadesa(SOURCE)))))]);
    if (task.naive.css) naive.push(["naive (CSS)", judge(task, start, await sweep(browser, pageDir(html, task.naive.css(startCss))))]);
    const solOk = sol.goal.ok && sol.shipped === 0 && sol.collateral.elements === 0;
    const teeth = naive.length > 0 && naive.every(([, v]) => !(v.goal.ok && v.shipped === 0 && v.collateral.elements === 0));
    if (!solOk || !teeth) bad++;
    const line = (name: string, v: Verdict) =>
      `    ${name.padEnd(22)} goal ${v.goal.ok ? "met" : "NOT met"} · ${v.shipped} defects (${v.defects.byKind["tap-44"] ?? 0} tap-44) · collateral ${v.collateral.elements} boxes in [${v.collateral.sections.join(", ")}]\n      ${fmtWhere(v.defects)}${v.goal.ok ? "" : `\n      ${v.goal.detail}`}${v.collateral.examples.length ? `\n      ${v.collateral.examples.slice(0, 3).join("; ")}` : ""}`;
    console.log(`${solOk && teeth ? "✓" : "✖"} ${task.id}   untouched sections: [${task.untouched(start).join(", ")}]`);
    console.log(line("start", v0));
    console.log(line("known-good solution", sol));
    for (const [n, v] of naive) console.log(line(n, v));
  }
  await browser.close();
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------- run

if (!existsSync(CLI)) throw new Error("run `npm run build:ts` first (the Cadesa arm uses lib/cli.js)");

interface Ledger { spent: number; runs: { at: string; label: string; task: string; arm: Arm; costUsd: number }[] }
const ledger: Ledger = existsSync(values.ledger!) ? JSON.parse(readFileSync(values.ledger!, "utf8")) : { spent: 0, runs: [] };
const budget = Number(values.budget);
const runBudget = Number(values["run-budget"]);

interface TrialResult extends Verdict, AgentRun {
  task: string;
  arm: Arm;
  trial: number;
  solved: boolean;
  workspace: string;
}

const results: TrialResult[] = [];
const arms = values.arms!.split(",") as Arm[];
const starts = new Map<string, Snapshot[]>();
let stoppedForBudget = false;
const outFile = join(values.out!, `discovery-${new Date().toISOString().replace(/[:.]/g, "-")}${values.label ? `-${values.label}` : ""}.json`);
mkdirSync(values.out!, { recursive: true });
const save = () =>
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        benchmark: "discovery",
        label: values.label,
        model: values.model,
        maxTurns: MAX_TURNS,
        runBudgetUsd: runBudget,
        claude: spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim(),
        stoppedForBudget,
        results,
      },
      null,
      2,
    ) + "\n",
  );

outer: for (let trial = 1; trial <= Number(values.trials); trial++)
  for (const task of tasks)
    for (const arm of arms) {
      if (ledger.spent + runBudget > budget) {
        stoppedForBudget = true;
        console.log(`stopping: $${ledger.spent.toFixed(2)} spent; another run could exceed the $${budget} cap`);
        break outer;
      }
      const html = htmlOf(task);
      if (!starts.has(task.id)) starts.set(task.id, await sweep(browser, pageDir(html, compileYaml(SOURCE))));
      const start = starts.get(task.id)!;
      const dir = workspace(task, arm);
      const run = runClaude(dir, arm, prompt(task, arm));
      ledger.spent += run.costUsd;
      ledger.runs.push({ at: new Date().toISOString(), label: values.label!, task: task.id, arm, costUsd: run.costUsd });
      writeFileSync(values.ledger!, JSON.stringify(ledger, null, 2) + "\n");

      // What ships: the agent's CSS (the Cadesa arm's source, compiled now) with the original page.html.
      let css = readFileSync(join(dir, "page.css"), "utf8");
      let invalid: string | undefined;
      if (arm === "cadesa") {
        try {
          css = compileYaml(readFileSync(join(dir, "page.cadesa.yaml"), "utf8"));
        } catch (e) {
          invalid = e instanceof CadesaError ? e.diagnostics.map(formatDiagnostic).join("\n") : String(e);
          css = compileYaml(SOURCE);
        }
      }
      const htmlEdited = readFileSync(join(dir, "page.html"), "utf8") !== html;
      const now = await sweep(browser, pageDir(html, css));
      const v = judge(task, start, now, invalid);
      const solved = v.goal.ok && v.shipped === 0 && v.collateral.elements === 0;
      results.push({ task: task.id, arm, trial, solved, workspace: dir, ...v, ...run, ...(htmlEdited ? { reply: `[edited page.html; ignored] ${run.reply}` } : {}) });
      save();
      console.log(
        `${task.id.padEnd(12)} ${arm.padEnd(6)} #${trial}: ${solved ? "SOLVED" : "not solved"} · goal ${v.goal.ok ? "met" : "not met"} · ${v.shipped} defects${v.defects.byKind["tap-44"] ? ` (+${v.defects.byKind["tap-44"]} tap-44)` : ""} · collateral ${v.collateral.elements} · ${run.toolCalls} tool calls, ${run.turns} turns (${run.stop}) · $${run.costUsd.toFixed(2)} · ${(run.ms / 1000).toFixed(0)}s · total $${ledger.spent.toFixed(2)}\n    ${fmtWhere(v.defects)}`,
      );
    }
await browser.close();
save();

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`\n${"task".padEnd(12)} ${"arm".padEnd(7)} solved  goal   defects/trial  trials-with-defects  collateral/trial  tool-calls  cost/trial  time`);
for (const task of tasks)
  for (const arm of arms) {
    const rs = results.filter((r) => r.task === task.id && r.arm === arm);
    if (!rs.length) continue;
    console.log(
      `${task.id.padEnd(12)} ${arm.padEnd(7)} ${`${rs.filter((r) => r.solved).length}/${rs.length}`.padEnd(7)} ${`${rs.filter((r) => r.goal.ok).length}/${rs.length}`.padEnd(6)} ${mean(rs.map((r) => r.shipped)).toFixed(1).padEnd(14)} ${`${rs.filter((r) => r.shipped > 0).length}/${rs.length}`.padEnd(20)} ${mean(rs.map((r) => r.collateral.elements)).toFixed(1).padEnd(17)} ${mean(rs.map((r) => r.toolCalls)).toFixed(1).padEnd(11)} $${mean(rs.map((r) => r.costUsd)).toFixed(2).padEnd(10)} ${mean(rs.map((r) => r.ms / 1000)).toFixed(0)}s`,
    );
  }
console.log(`\nkinds: ${KINDS.join(", ")}\nwrote ${outFile}\nspent so far (ledger): $${ledger.spent.toFixed(2)}`);
