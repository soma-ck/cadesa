/** Command implementations shared by the CLI and the MCP server. Each returns text and data. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { check } from "./check.js";
import { compile } from "./compile.js";
import { explain } from "./explain.js";
import { parseFixture } from "./fixture.js";
import { loadSource, loadSourceFile } from "./load.js";
import { modelOf, render, whatif, type Change } from "./project.js";
import { formatCheck, formatExplain, formatRender, formatWhatif } from "./report.js";

export interface Result {
  text: string;
  data: unknown;
  /** false when the command found errors (non-zero exit / isError). */
  ok: boolean;
}

export class InputError extends Error {}

const ms = (t0: number) => Math.round(performance.now() - t0);

export interface SourceInput {
  source: string;
  /** Unsaved YAML to use instead of the file's contents (diagnostics still name `source`). */
  sourceText?: string;
}

const load = (s: SourceInput) => (s.sourceText !== undefined ? loadSource(s.source, s.sourceText) : loadSourceFile(s.source));

export function validateCmd(s: SourceInput): Result {
  modelOf(load(s)); // throws CascadioError with diagnostics
  return { text: `✓ ${s.source} is valid\n`, data: { valid: true }, ok: true };
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
  return {
    text: formatRender(layouts, { source: s.source, fixture: s.fixture, ms: ms(t0), lines: s.lines }),
    data: { source: s.source, fixture: s.fixture, layouts },
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
  const findings = check(render(modelOf(load(s)), parseFixture(s.fixture), s.widths));
  return {
    text: formatCheck(findings, s.widths),
    data: { findings },
    ok: !findings.some((f) => f.severity === "error"),
  };
}
