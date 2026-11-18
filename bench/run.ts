/**
 * Cadesa vs. plain CSS: how many attempts does an agent need to fix a mobile layout bug, and does
 * the fix break desktop?
 *
 *   npm run build:ts && npx tsx bench/run.ts [--tasks stack-actions,mobile-padding,button-overflow]
 *     [--arms css,cadesa] [--trials 3] [--rounds 4] [--model sonnet] [--out bench/results]
 *
 * Protocol (identical for both arms):
 *   - Same fixture, same starting pixels (the plain-CSS arm starts from the compiled CSS).
 *   - Each round is one headless `claude -p` run that may make ONE edit to the single editable file.
 *   - Both arms can screenshot the fixture at the mobile width and 1280px (`node preview.mjs`).
 *     The Cadesa arm can also run `./cadesa render | whatif | explain | check`.
 *   - After each round the harness measures the fixture in Chromium (never with Cadesa's engine)
 *     and judges: goal met at the mobile width? any box moved at 1280px vs. the start?
 *   - Not done → next round with the same factual feedback in both arms, up to --rounds.
 *
 * Requires the `claude` CLI (Claude Code) logged in. Each round spends model usage.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright";
import { compile } from "../src/compile.js";
import { CadesaError, formatDiagnostic } from "../src/diagnostics.js";
import { loadSource } from "../src/load.js";
import { findChrome } from "../src/metrics.js";
import { modelOf } from "../src/project.js";
import { DESKTOP, fmt, regression, TASKS, type Boxes, type Task } from "./tasks.js";

const { values } = parseArgs({
  options: {
    tasks: { type: "string", default: TASKS.map((t) => t.id).join(",") },
    arms: { type: "string", default: "css,cadesa" },
    trials: { type: "string", default: "3" },
    rounds: { type: "string", default: "4" },
    model: { type: "string", default: "sonnet" },
    "max-turns": { type: "string", default: "30" },
    out: { type: "string", default: "bench/results" },
  },
});

const REPO = resolve(".");
const CLI = join(REPO, "lib", "cli.js");
if (!existsSync(CLI)) throw new Error("run `npm run build:ts` first (the Cadesa arm uses lib/cli.js)");
const BASE = readFileSync(join(REPO, "settings.cadesa.yaml"), "utf8");
type Arm = "css" | "cadesa";

// ---------------------------------------------------------------- workspace

function workspace(task: Task, arm: Arm): string {
  const dir = mkdtempSync(join(tmpdir(), `cadesa-bench-${task.id}-${arm}-`));
  const start = task.breakSource(BASE);
  const css = compile(modelOf(loadSource("component.cadesa.yaml", start)));
  writeFileSync(join(dir, "component.css"), css);
  if (arm === "cadesa") writeFileSync(join(dir, "component.cadesa.yaml"), start);
  copyFileSync(join(REPO, "fonts", "InterVariable-latin.woff2"), join(dir, "InterVariable-latin.woff2"));
  const html = readFileSync(join(REPO, "fixtures", task.fixture), "utf8")
    .replace("../dist/settings.css", "component.css")
    .replace("../fonts/InterVariable-latin.woff2", "InterVariable-latin.woff2");
  writeFileSync(join(dir, "fixture.html"), html);
  writeFileSync(
    join(dir, "preview.mjs"),
    `// Screenshots of fixture.html at ${task.mobile}px and ${DESKTOP}px → shots/*.png
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from ${JSON.stringify(join(REPO, "node_modules", "playwright", "index.mjs"))};
${arm === "cadesa" ? `execFileSync("node", [${JSON.stringify(CLI)}, "build", "component.cadesa.yaml", "--out", "component.css"], { stdio: "inherit" });\n` : ""}mkdirSync("shots", { recursive: true });
const browser = await chromium.launch(${JSON.stringify({ executablePath: findChrome() })});
for (const width of [${task.mobile}, ${DESKTOP}]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(new URL("fixture.html", import.meta.url).href);
  await page.evaluate("document.fonts.ready");
  await page.screenshot({ path: \`shots/\${width}.png\`, fullPage: true });
}
await browser.close();
console.log("wrote shots/${task.mobile}.png and shots/${DESKTOP}.png; Read them to see the page");
`,
  );
  if (arm === "cadesa") {
    writeFileSync(join(dir, "cadesa"), `#!/bin/sh\nexec node ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  }
  return dir;
}

function prompt(task: Task, arm: Arm, round: number, feedback: string[]): string {
  const file = arm === "css" ? "component.css" : "component.cadesa.yaml";
  const tools =
    arm === "css"
      ? `- \`node preview.mjs\` writes screenshots of fixture.html at ${task.mobile}px and ${DESKTOP}px to shots/. Read the PNGs to see them.`
      : `- \`node preview.mjs\` compiles ${file} and writes screenshots at ${task.mobile}px and ${DESKTOP}px to shots/. Read the PNGs to see them.
- \`./cadesa render fixture.html --source ${file} --widths ${task.mobile},${DESKTOP}\` lists every box (x, y, w×h) without a browser.
- \`./cadesa whatif fixture.html --source ${file} --widths ${task.mobile},${DESKTOP} --set <yaml.path>=<value>\` predicts what an edit changes at each width, without writing it.
- \`./cadesa explain fixture.html --source ${file} --id <data-fixture id>\` shows where each value comes from.
- \`./cadesa check fixture.html --source ${file} --widths ${task.mobile},${DESKTOP}\` reports overflow and other issues.
${file} is a Cadesa source: a small YAML styling language that compiles to the CSS in component.css. Run \`./cadesa --help\` if needed.`;
  return `You are fixing a layout bug in a settings panel. fixture.html shows the component; ${file} styles it.

Problem: ${task.problem}

Rules:
- Edit only ${file}. Make ONE edit (one Edit call) this round, then stop and reply with one sentence describing it.
- The fixture's elements have data-fixture ids (panel, title, description, actions, save, cancel).

Tools you may use:
${tools}
${round > 1 ? `\nThis is round ${round}. After your previous edit, a check in a real browser found:\n${feedback.map((f) => `- ${f}`).join("\n")}\n` : ""}`;
}

function runClaude(dir: string, arm: Arm, text: string) {
  const allowed = ["Read", "Edit", "Bash(node preview.mjs)", ...(arm === "cadesa" ? ["Bash(./cadesa:*)"] : [])];
  const r = spawnSync(
    "claude",
    [
      "-p",
      text,
      "--output-format",
      "json",
      "--model",
      values.model!,
      "--max-turns",
      values["max-turns"]!,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ...allowed,
      "--strict-mcp-config",
      "--no-session-persistence",
    ],
    { cwd: dir, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  try {
    const j = JSON.parse(r.stdout);
    return { ok: !j.is_error, turns: j.num_turns as number, costUsd: j.total_cost_usd as number, ms: j.duration_ms as number, reply: String(j.result ?? "").slice(0, 400) };
  } catch {
    return { ok: false, turns: 0, costUsd: 0, ms: 0, reply: `claude failed: ${(r.stderr || r.stdout || String(r.error)).slice(0, 400)}` };
  }
}

// ---------------------------------------------------------------- measurement (Chromium)

function serve(dir: string): Promise<{ server: Server; port: number }> {
  const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".woff2": "font/woff2" };
  const server = createServer((req, res) => {
    const p = resolve(dir, "." + decodeURIComponent(new URL(req.url!, "http://x").pathname));
    if (!p.startsWith(dir) || !existsSync(p)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(p));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as { port: number }).port })));
}

async function measure(browser: Browser, port: number, width: number): Promise<Boxes> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/fixture.html`);
  await page.evaluate("document.fonts.ready");
  const boxes = (await page.evaluate(`Object.fromEntries([...document.querySelectorAll("[data-fixture]")].map((el) => {
    const r = el.getBoundingClientRect(); return [el.dataset.fixture, { x: r.x, y: r.y, w: r.width, h: r.height }];
  }))`)) as Boxes;
  await page.close();
  return boxes;
}

/** For the Cadesa arm, the editable file is YAML: compile it (the agent may not have). */
function compileIfNeeded(dir: string, arm: Arm): string | undefined {
  if (arm !== "cadesa") return undefined;
  try {
    const css = compile(modelOf(loadSource("component.cadesa.yaml", readFileSync(join(dir, "component.cadesa.yaml"), "utf8"))));
    writeFileSync(join(dir, "component.css"), css);
    return undefined;
  } catch (e) {
    return e instanceof CadesaError ? e.diagnostics.map(formatDiagnostic).join("\n") : String(e);
  }
}

// ---------------------------------------------------------------- run

interface RoundResult {
  round: number;
  goal: boolean;
  goalDetail: string;
  desktopChanges: string[];
  invalidSource?: string;
  turns: number;
  costUsd: number;
  ms: number;
  reply: string;
}

interface TrialResult {
  task: string;
  arm: Arm;
  trial: number;
  solved: boolean;
  attempts: number;
  desktopRegressionRounds: number;
  finalDesktopRegression: boolean;
  rounds: RoundResult[];
}

const browser = await chromium.launch({ executablePath: findChrome() });
const results: TrialResult[] = [];
const tasks = values.tasks!.split(",").map((id) => TASKS.find((t) => t.id === id) ?? Promise.reject(new Error(`unknown task ${id}`))) as Task[];
const arms = values.arms!.split(",") as Arm[];
const maxRounds = Number(values.rounds);

for (const task of tasks)
  for (let trial = 1; trial <= Number(values.trials); trial++)
    for (const arm of arms) {
      const dir = workspace(task, arm);
      const { server, port } = await serve(dir);
      const baseline = await measure(browser, port, DESKTOP);
      const startGoal = task.goal(await measure(browser, port, task.mobile));
      if (startGoal.ok) throw new Error(`task ${task.id} starts solved: ${startGoal.detail}`);

      const rounds: RoundResult[] = [];
      let feedback: string[] = [];
      for (let round = 1; round <= maxRounds; round++) {
        const run = runClaude(dir, arm, prompt(task, arm, round, feedback));
        const invalid = compileIfNeeded(dir, arm);
        const mobile = await measure(browser, port, task.mobile);
        const desktop = await measure(browser, port, DESKTOP);
        const goal = task.goal(mobile);
        const changes = regression(baseline, desktop);
        rounds.push({ round, goal: goal.ok && !invalid, goalDetail: goal.detail, desktopChanges: changes, invalidSource: invalid, ...run });
        process.stdout.write(
          `${task.id} ${arm.padEnd(6)} trial ${trial} round ${round}: ${invalid ? "invalid source" : goal.ok ? "goal met" : "goal not met"}${changes.length ? `, desktop changed (${changes.length} boxes)` : ""} · ${run.turns} turns · $${(run.costUsd ?? 0).toFixed(3)}\n`,
        );
        if (!invalid && goal.ok && !changes.length) break;
        feedback = [
          ...(invalid ? [`${arm === "cadesa" ? "component.cadesa.yaml" : "component.css"} is invalid:\n${invalid}`] : []),
          ...(goal.ok ? [] : [`At ${task.mobile}px the goal is not met: ${goal.detail}`]),
          ...changes.map((c) => `At ${DESKTOP}px, ${c} (desktop must not change)`),
        ];
      }
      server.close();
      const last = rounds[rounds.length - 1];
      results.push({
        task: task.id,
        arm,
        trial,
        solved: last.goal && !last.desktopChanges.length,
        attempts: rounds.length,
        desktopRegressionRounds: rounds.filter((r) => r.desktopChanges.length).length,
        finalDesktopRegression: last.desktopChanges.length > 0,
        rounds,
      });
    }
await browser.close();

mkdirSync(values.out!, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = join(values.out!, `${stamp}.json`);
writeFileSync(
  file,
  JSON.stringify({ model: values.model, rounds: maxRounds, claude: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(), results }, null, 2) + "\n",
);

// Summary
console.log(`\n${"task".padEnd(16)} ${"arm".padEnd(7)} solved  attempts  desktop-regression rounds  turns/round  cost`);
for (const task of tasks)
  for (const arm of arms) {
    const rs = results.filter((r) => r.task === task.id && r.arm === arm);
    if (!rs.length) continue;
    const solved = rs.filter((r) => r.solved);
    const allRounds = rs.flatMap((r) => r.rounds);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    console.log(
      `${task.id.padEnd(16)} ${arm.padEnd(7)} ${`${solved.length}/${rs.length}`.padEnd(7)} ${mean(solved.map((r) => r.attempts)).toFixed(2).padEnd(9)} ${String(rs.reduce((n, r) => n + r.desktopRegressionRounds, 0)).padEnd(26)} ${mean(allRounds.map((r) => r.turns)).toFixed(1).padEnd(12)} $${allRounds.reduce((n, r) => n + (r.costUsd ?? 0), 0).toFixed(2)}`,
    );
  }
console.log(`\nwrote ${file}`);
