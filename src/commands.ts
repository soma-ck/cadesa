/** Command implementations shared by the CLI and the MCP server. Each returns text and data. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { check } from "./check.js";
import { critique } from "./critique.js";
import { compile } from "./compile.js";
import { explain } from "./explain.js";
import { parseFixture } from "./fixture.js";
import { loadSource, loadSourceFile } from "./load.js";
import { modelOf, render, whatif, type Change } from "./project.js";
import { formatCheck, formatExplain, formatImpact, formatLift, formatRender, formatWhatif } from "./report.js";
import { impact, type WidthImpact } from "./lift/impact.js";
import { lift, type LiftResult } from "./lift/lift.js";
import { readFileSync } from "node:fs";

export interface Result {
  text: string;
  data: unknown;
  /** false when the command found errors (non-zero exit / isError). */
  ok: boolean;
}

export class InputError extends Error {}

/** Every 20px from 320 to 1440: the default for check and critique, cheap at ~4ms per width. */
export const SWEEP = "320-1440/20";

/** Parse "390,1280" or ranges "320-1440/20" (step defaults to 10), in any mix. */
export function parseWidths(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/.exec(part);
    if (m) {
      const [a, b, step] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 10)];
      if (!(a > 0) || !(b >= a) || !(step > 0) || (b - a) / step > 5000) throw new InputError(`invalid width range "${part}"`);
      for (let w = a; w <= b + 1e-9; w += step) out.add(Math.round(w * 100) / 100);
      continue;
    }
    const n = Number(part);
    if (!Number.isFinite(n) || n <= 0) throw new InputError(`invalid width "${part}"`);
    out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

const ms = (t0: number) => Math.round(performance.now() - t0);

export interface SourceInput {
  /** Path to a .cadesa.yaml source. */
  source?: string;
  /** Unsaved YAML to use instead of the file's contents (diagnostics still name `source`). */
  sourceText?: string;
  /** Plain CSS to lift on the fly instead of a Cadesa source. */
  css?: string;
}

const liftFile = (css: string) => lift(css, readFileSync(css, "utf8"));

function load(s: SourceInput) {
  if (s.css) return loadSource(`${s.css} (lifted)`, liftFile(s.css).yaml);
  if (!s.source) throw new InputError("needs --source <file.cadesa.yaml> or --css <file.css>");
  return s.sourceText !== undefined ? loadSource(s.source, s.sourceText) : loadSourceFile(s.source);
}

/** For --css inputs: the lift and its box-level impact at each width. */
function impactFor(s: SourceInput & { fixture: string }, layouts: ReturnType<typeof render>) {
  if (!s.css) return undefined;
  const lifted = liftFile(s.css);
  return { lifted, impacts: impact(lifted, parseFixture(s.fixture), layouts) };
}

export function validateCmd(s: SourceInput): Result {
  modelOf(load(s)); // throws CadesaError with diagnostics
  return { text: `✓ ${s.css ? `${s.css} (lifted)` : s.source} is valid\n`, data: { valid: true }, ok: true };
}

export function buildCmd(s: SourceInput & { out: string }): Result {
  const css = compile(modelOf(load(s)));
  mkdirSync(dirname(s.out), { recursive: true });
  writeFileSync(s.out, css);
  const sha256 = createHash("sha256").update(css).digest("hex");
  const bytes = Buffer.byteLength(css);
  return { text: `wrote ${s.out} (${bytes} bytes, sha256 ${sha256.slice(0, 12)})\n`, data: { out: s.out, bytes, sha256 }, ok: true };
}

export function cssCmd(s: SourceInput): Result {
  const css = compile(modelOf(load(s)));
  return { text: css, data: { css }, ok: true };
}

export function renderCmd(s: SourceInput & { fixture: string; widths: number[]; lines?: boolean }): Result {
  const t0 = performance.now();
  const layouts = render(modelOf(load(s)), parseFixture(s.fixture), s.widths);
  const imp = impactFor(s, layouts);
  const label = s.css ? `${s.css} (lifted)` : s.source!;
  return {
    text:
      formatRender(layouts, { source: label, fixture: s.fixture, ms: ms(t0), lines: s.lines, impacts: imp?.impacts }) +
      (imp ? "\n" + formatImpact(imp.impacts) : ""),
    data: { source: label, fixture: s.fixture, layouts, impact: imp?.impacts },
    ok: !layouts.some((l) => l.issues.some((i) => i.severity === "error")),
  };
}

export function whatifCmd(s: SourceInput & { fixture: string; widths: number[]; changes: Change[] }): Result {
  if (!s.changes.length) throw new InputError("whatif needs at least one change (path=value)");
  const t0 = performance.now();
  const result = whatif(load(s), parseFixture(s.fixture), s.widths, s.changes);
  return { text: formatWhatif(result, { ms: ms(t0) }), data: result, ok: true };
}

export function explainCmd(s: SourceInput & { fixture: string; widths: number[]; id: string }): Result {
  const id = s.id.replace(/^#/, "");
  const model = modelOf(load(s));
  const results = render(model, parseFixture(s.fixture), s.widths).map((l) => explain(model, l, id));
  if (results.some((r) => !r)) throw new InputError(`no element with data-fixture="${id}" in ${s.fixture}`);
  return { text: results.map((r) => formatExplain(r!)).join("\n"), data: results, ok: true };
}

export function checkCmd(s: SourceInput & { fixture: string; widths: number[] }): Result {
  const layouts = render(modelOf(load(s)), parseFixture(s.fixture), s.widths);
  const imp = impactFor(s, layouts);
  const findings = check(layouts, imp?.impacts);
  return {
    text: formatCheck(findings, s.widths),
    data: { findings },
    ok: !findings.some((f) => f.severity === "error"),
  };
}

export function critiqueCmd(s: SourceInput & { fixture: string; widths: number[] }): Result {
  const model = modelOf(load(s));
  const fixture = parseFixture(s.fixture);
  const found = critique(model, fixture, render(model, fixture, s.widths));
  const text = found.length
    ? found.map((c) => `◇ [${c.check}] ${c.message}${c.path ? `\n    edit: ${c.path}` : ""}`).join("\n") + `\n\n${found.length} suggestion${found.length === 1 ? "" : "s"}\n`
    : `✓ no critique at ${s.widths.join(", ")}px\n`;
  return { text, data: { critique: found }, ok: true };
}

export function liftCmd(s: { css: string; out?: string; fixture?: string; widths: number[] }): Result {
  const lifted: LiftResult = liftFile(s.css);
  let impacts: WidthImpact[] | undefined;
  if (s.out) {
    mkdirSync(dirname(s.out), { recursive: true });
    writeFileSync(s.out, lifted.yaml);
  }
  modelOf(loadSource(s.out ?? `${s.css} (lifted)`, lifted.yaml)); // the lift must always produce a valid source
  if (s.fixture) {
    const model = modelOf(loadSource(`${s.css} (lifted)`, lifted.yaml));
    impacts = impact(lifted, parseFixture(s.fixture), render(model, parseFixture(s.fixture), s.widths));
  }
  return {
    text: formatLift(lifted, { out: s.out, impacts }) + (s.out ? "" : "\n" + lifted.yaml),
    data: { source: lifted.yaml, unlifted: lifted.unlifted, stats: lifted.stats, impact: impacts },
    ok: true,
  };
}
