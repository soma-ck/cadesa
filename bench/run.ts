/**
 * Cadesa vs. plain CSS: how many attempts does an agent need to fix a layout problem, and does
 * the fix break widths that must not change?
 *
 *   npm run build:ts && npx tsx bench/run.ts [--set hard | --tasks a,b] [--arms css,cadesa]
 *     [--trials 5] [--rounds 3] [--protocol free|one-edit] [--max-turns 16] [--model sonnet]
 *   npx tsx bench/run.ts --verify          # prove every task starts broken and is solvable (no model calls)
 *
 * Protocol (identical for both arms):
 *   - Same fixture, same starting pixels (the plain-CSS arm starts from the compiled CSS).
 *   - Each round is one headless `claude -p` run that ends with a submission.
 *       free:     any number of edits, within --max-turns tool calls (the edit budget).
 *       one-edit: exactly one Edit call (run 1's protocol).
 *   - Both arms can screenshot the fixture (`node preview.mjs`). The Cadesa arm can also run
 *     `./cadesa render | whatif | explain | check | validate`.
 *   - After each round the harness measures the fixture in Chromium (never with Cadesa's engine):
 *     goal met at the goal widths? any box moved at a protected width vs. the start?
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
import { regression, TASKS, type At, type Boxes, type Task } from "./tasks.js";

const { values } = parseArgs({
  options: {
    set: { type: "string", default: "hard" },
    tasks: { type: "string" },
    arms: { type: "string", default: "css,cadesa" },
    trials: { type: "string", default: "5" },
    rounds: { type: "string", default: "3" },
    protocol: { type: "string", default: "free" },
    model: { type: "string", default: "sonnet" },
    "max-turns": { type: "string", default: "16" },
    out: { type: "string", default: "bench/results" },
    verify: { type: "boolean", default: false },
  },
});

const REPO = resolve(".");
const CLI = join(REPO, "lib", "cli.js");
type Arm = "css" | "cadesa";
const protocol = values.protocol as "free" | "one-edit";
const tasks: Task[] = values.tasks
  ? values.tasks.split(",").map((id) => {
      const t = TASKS.find((x) => x.id === id);
      if (!t) throw new Error(`unknown task ${id}; known: ${TASKS.map((x) => x.id).join(", ")}`);
      return t;
    })
  : TASKS.filter((t) => t.set === values.set);

// ---------------------------------------------------------------- workspace

const compileYaml = (yaml: string) => compile(modelOf(loadSource("component.cadesa.yaml", yaml)));

function workspace(task: Task, arm: Arm, yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cadesa-bench-${task.id}-${arm}-`));
  writeFileSync(join(dir, "component.css"), compileYaml(yaml));
  if (arm === "cadesa") writeFileSync(join(dir, "component.cadesa.yaml"), yaml);
  copyFileSync(join(REPO, "fonts", "InterVariable-latin.woff2"), join(dir, "InterVariable-latin.woff2"));
  const html = readFileSync(join(REPO, task.fixture), "utf8")
    .replace(/<link rel="stylesheet" href="[^"]+" \/>/, '<link rel="stylesheet" href="component.css" />')
    .replace(/url\("[^"]*InterVariable-latin\.woff2"\)/, 'url("InterVariable-latin.woff2")');
  writeFileSync(join(dir, "fixture.html"), html);
  const widths = [...new Set([...task.goalWidths, ...task.protect])].sort((a, b) => a - b);
  writeFileSync(
    join(dir, "preview.mjs"),
    `// Screenshots of fixture.html at ${widths.join(", ")}px → shots/<width>.png
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from ${JSON.stringify(join(REPO, "node_modules", "playwright", "index.mjs"))};
${arm === "cadesa" ? `execFileSync("node", [${JSON.stringify(CLI)}, "build", "component.cadesa.yaml", "--out", "component.css"], { stdio: "inherit" });\n` : ""}mkdirSync("shots", { recursive: true });
const browser = await chromium.launch(${JSON.stringify({ executablePath: findChrome() })});
for (const width of ${JSON.stringify(widths)}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(new URL("fixture.html", import.meta.url).href);
  await page.evaluate("document.fonts.ready");
  await page.screenshot({ path: \`shots/\${width}.png\`, fullPage: true });
}
await browser.close();
console.log("wrote ${widths.map((w) => `shots/${w}.png`).join(", ")}; Read them to see the page");
`,
  );
  if (arm === "cadesa") writeFileSync(join(dir, "cadesa"), `#!/bin/sh\nexec node ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  return dir;
}

function prompt(task: Task, arm: Arm, round: number, feedback: string[]): string {
  const file = arm === "css" ? "component.css" : "component.cadesa.yaml";
  const widths = [...new Set([...task.goalWidths, ...task.protect])].sort((a, b) => a - b).join(",");
  const tools =
    arm === "css"
      ? `- \`node preview.mjs\` writes screenshots of fixture.html at ${widths}px to shots/. Read the PNGs to see them.`
      : `- \`node preview.mjs\` compiles ${file} and writes screenshots at ${widths}px to shots/. Read the PNGs to see them.
- \`./cadesa render fixture.html --source ${file} --widths ${widths} --lines\` lists every box (x, y, w×h) and every wrapped text line, without a browser.
- \`./cadesa whatif fixture.html --source ${file} --widths ${widths} --set <yaml.path>=<value> [--set ...]\` predicts what edits change at each width, without writing them.
- \`./cadesa explain fixture.html --source ${file} --id <data-fixture id> --widths ${widths}\` shows where each value comes from.
- \`./cadesa check fixture.html --source ${file} --widths ${widths}\` reports overflow and other issues.
- \`./cadesa validate ${file}\` checks the source; an invalid file fails the round.
${file} is a Cadesa source: a small YAML styling language that compiles to the CSS in component.css. Run \`./cadesa --help\` if needed.`;
  const rule =
    protocol === "one-edit"
      ? `Make ONE edit (one Edit call) to ${file} this round, then stop and reply with one sentence describing it.`
      : `Edit ${file} as needed, then stop and reply with one sentence describing your fix. You have a limited budget of tool calls this round, so verify efficiently.`;
  return `You are fixing a layout problem in a web component. fixture.html shows it; ${file} styles it.

Problem: ${task.problem}

Rules:
- Edit only ${file}.
- ${rule}
- Elements carry data-fixture ids; the requirements refer to those elements.

Tools you may use:
${tools}
${round > 1 ? `\nThis is round ${round}. After your previous submission, a check in a real browser found:\n${feedback.map((f) => `- ${f}`).join("\n")}\n` : ""}`;
}

function runClaude(dir: string, arm: Arm, text: string) {
  const allowed = ["Read", "Edit", "Bash(node preview.mjs)", ...(arm === "cadesa" ? ["Bash(./cadesa:*)"] : [])];
  const r = spawnSync(
    "claude",
    ["-p", text, "--output-format", "json", "--model", values.model!, "--max-turns", values["max-turns"]!, "--permission-mode", "acceptEdits", "--allowedTools", ...allowed, "--strict-mcp-config", "--no-session-persistence"],
    { cwd: dir, encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  try {
    const j = JSON.parse(r.stdout);
    return { turns: j.num_turns as number, costUsd: (j.total_cost_usd as number) ?? 0, ms: j.duration_ms as number, outOfTurns: j.subtype === "error_max_turns", reply: String(j.result ?? j.subtype ?? "").slice(0, 500) };
  } catch {
    return { turns: 0, costUsd: 0, ms: 0, outOfTurns: false, reply: `claude failed: ${(r.stderr || r.stdout || String(r.error)).slice(0, 400)}` };
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

const MEASURE = `Object.fromEntries([...document.querySelectorAll("[data-fixture]")].map((el) => {
  const r = el.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(el);
  const tops = new Set([...range.getClientRects()].filter((q) => q.width > 0 && q.height > 0).map((q) => Math.round(q.bottom)));
  const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  return [el.dataset.fixture, { x: r.x, y: r.y, w: r.width, h: r.height, fontSize: parseFloat(getComputedStyle(el).fontSize), lines: hasText ? tops.size : undefined }];
}))`;

async function measure(browser: Browser, port: number, width: number): Promise<Boxes> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/fixture.html`);
  await page.evaluate("document.fonts.ready");
  const boxes = (await page.evaluate(MEASURE)) as Boxes;
  await page.close();
  return boxes;
}

async function measureAll(browser: Browser, port: number, widths: number[]): Promise<At> {
  const at: At = {};
  for (const w of widths) at[w] = await measure(browser, port, w);
  return at;
}

/** For the Cadesa arm, the editable file is YAML: compile it (the agent may not have). */
function compileIfNeeded(dir: string, arm: Arm): string | undefined {
  if (arm !== "cadesa") return undefined;
  try {
    writeFileSync(join(dir, "component.css"), compileYaml(readFileSync(join(dir, "component.cadesa.yaml"), "utf8")));
    return undefined;
  } catch (e) {
    return e instanceof CadesaError ? e.diagnostics.map(formatDiagnostic).join("\n") : String(e);
  }
}

function judge(task: Task, start: At, now: At) {
  const goal = task.goal(now);
  const changes = task.protect.flatMap((w) => regression(start[w], now[w]).map((c) => `At ${w}px, ${c} (must not change)`));
  return { goal, changes };
}

const browser = await chromium.launch({ executablePath: findChrome() });

// ---------------------------------------------------------------- --verify: tasks are fair

if (values.verify) {
  let bad = 0;
  for (const task of tasks) {
    const base = readFileSync(join(REPO, task.source), "utf8");
    const widths = [...new Set([...task.goalWidths, ...task.protect])];
    const startDir = workspace(task, "css", task.breakSource(base));
    const s = await serve(startDir);
    const start = await measureAll(browser, s.port, widths);
    s.server.close();
    const solvedDir = workspace(task, "css", task.solution ? task.solution(task.breakSource(base)) : base);
    const v = await serve(solvedDir);
    const solved = await measureAll(browser, v.port, widths);
    v.server.close();
    const before = judge(task, start, start);
    const after = judge(task, start, solved);
    const ok = !before.goal.ok && after.goal.ok && !after.changes.length;
    if (!ok) bad++;
    console.log(`${ok ? "✓" : "✖"} ${task.id}\n    start:    ${before.goal.detail}\n    solution: ${after.goal.detail}${after.changes.length ? `\n    solution changes protected widths: ${after.changes.join("; ")}` : ""}`);
  }
  await browser.close();
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------- run

if (!existsSync(CLI)) throw new Error("run `npm run build:ts` first (the Cadesa arm uses lib/cli.js)");

interface RoundResult {
  round: number;
  goal: boolean;
  goalDetail: string;
  protectedChanges: string[];
  invalidSource?: string;
  turns: number;
  outOfTurns: boolean;
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
  regressionRounds: number;
  rounds: RoundResult[];
}

const results: TrialResult[] = [];
const arms = values.arms!.split(",") as Arm[];
const maxRounds = Number(values.rounds);

for (const task of tasks)
  for (let trial = 1; trial <= Number(values.trials); trial++)
    for (const arm of arms) {
      const startYaml = task.breakSource(readFileSync(join(REPO, task.source), "utf8"));
      const dir = workspace(task, arm, startYaml);
      const { server, port } = await serve(dir);
      const widths = [...new Set([...task.goalWidths, ...task.protect])];
      const start = await measureAll(browser, port, widths);
      if (task.goal(start).ok) throw new Error(`task ${task.id} starts solved`);

      const rounds: RoundResult[] = [];
      let feedback: string[] = [];
      for (let round = 1; round <= maxRounds; round++) {
        const run = runClaude(dir, arm, prompt(task, arm, round, feedback));
        const invalid = compileIfNeeded(dir, arm);
        const { goal, changes } = judge(task, start, await measureAll(browser, port, widths));
        rounds.push({ round, goal: goal.ok && !invalid, goalDetail: goal.detail, protectedChanges: changes, invalidSource: invalid, ...run });
        process.stdout.write(
          `${task.id} ${arm.padEnd(6)} trial ${trial} round ${round}: ${invalid ? "invalid source" : goal.ok ? "goal met" : "goal not met"}${changes.length ? `, protected width changed (${changes.length} boxes)` : ""} · ${run.turns} turns${run.outOfTurns ? " (budget hit)" : ""} · $${run.costUsd.toFixed(3)}\n`,
        );
        if (!invalid && goal.ok && !changes.length) break;
        feedback = [
          ...(invalid ? [`${arm === "cadesa" ? "component.cadesa.yaml" : "component.css"} is invalid:\n${invalid}`] : []),
          ...(goal.ok ? [] : [`The goal is not met: ${goal.detail}`]),
          ...changes,
        ];
      }
      server.close();
      const last = rounds[rounds.length - 1];
      results.push({
        task: task.id,
        arm,
        trial,
        solved: last.goal && !last.protectedChanges.length,
        attempts: rounds.length,
        regressionRounds: rounds.filter((r) => r.protectedChanges.length).length,
        rounds,
      });
    }
await browser.close();

mkdirSync(values.out!, { recursive: true });
const file = join(values.out!, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  file,
  JSON.stringify(
    { model: values.model, protocol, rounds: maxRounds, maxTurns: Number(values["max-turns"]), claude: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(), results },
    null,
    2,
  ) + "\n",
);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`\n${"task".padEnd(16)} ${"arm".padEnd(7)} solved  first-try  attempts  regression-rounds  turns/round  cost`);
for (const task of tasks)
  for (const arm of arms) {
    const rs = results.filter((r) => r.task === task.id && r.arm === arm);
    if (!rs.length) continue;
    const solved = rs.filter((r) => r.solved);
    const first = rs.filter((r) => r.solved && r.attempts === 1);
    const all = rs.flatMap((r) => r.rounds);
    console.log(
      `${task.id.padEnd(16)} ${arm.padEnd(7)} ${`${solved.length}/${rs.length}`.padEnd(7)} ${`${first.length}/${rs.length}`.padEnd(10)} ${mean(solved.map((r) => r.attempts)).toFixed(2).padEnd(9)} ${String(rs.reduce((n, r) => n + r.regressionRounds, 0)).padEnd(18)} ${mean(all.map((r) => r.turns)).toFixed(1).padEnd(12)} $${all.reduce((n, r) => n + r.costUsd, 0).toFixed(2)}`,
    );
  }
console.log(`\nwrote ${file}`);
