/** Command implementations shared by the CLI and the MCP server. Each returns text and data. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { check } from "./check.js";
import { wireframeSvg } from "./wireframe.js";
import { critique } from "./critique.js";
import { compile } from "./compile.js";
import { explain } from "./explain.js";
import { parseFixture, type Fixture } from "./fixture.js";
import { loadSource, loadSourceFile, type Source } from "./load.js";
import { modelOf, render, whatif, type Change, type WhatIf } from "./project.js";
import type { Layout } from "./engine/layout.js";
import type { Model } from "./model.js";
import { liftTailwind, type TailwindLift } from "./tailwind/lift.js";
import { formatCheck, formatExplain, formatImpact, formatLift, formatRender, formatWhatif } from "./report.js";
import { impact, type WidthImpact } from "./lift/impact.js";
import { lift, type LiftResult } from "./lift/lift.js";
import { readFileSync } from "node:fs";
import {
  describeMetrics,
  fontReport,
  fontUses,
  formatFonts,
  formatMeasured,
  measureGoogle,
  measureReport,
  measureSystem,
  pageFontSources,
  type FontReport,
  type Measured,
} from "./fonts.js";
import { generateMetrics, launchChromium, writeMetrics } from "./metrics.js";

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
  /**
   * Compiled Tailwind CSS: the fixture is then a Tailwind page, lifted on the fly (utilities →
   * source, generated class names and ids → fixture).
   */
  tailwind?: string;
}

const liftFile = (css: string) => lift(css, readFileSync(css, "utf8"));

const twCache = new Map<string, TailwindLift>();
/** Lift a Tailwind page (cached per file contents, so one command lifts once). */
export function tailwindFile(page: string, css: string): TailwindLift {
  const html = readFileSync(page, "utf8");
  const cssText = readFileSync(css, "utf8");
  const key = createHash("sha256").update(page).update("\0").update(html).update("\0").update(css).update("\0").update(cssText).digest("hex");
  let t = twCache.get(key);
  if (!t) {
    t = liftTailwind(page, html, css, cssText);
    twCache.clear();
    twCache.set(key, t);
  }
  return t;
}

/** The page a command lays out: one fixture, or (Tailwind) one per width range. */
interface Page {
  label: string;
  fixture: Fixture;
  at(width: number): Fixture;
  tw?: TailwindLift;
}

function pageOf(s: SourceInput & { fixture: string }): Page {
  if (s.tailwind) {
    const tw = tailwindFile(s.fixture, s.tailwind);
    return { label: `${s.fixture} (Tailwind, ${s.tailwind})`, fixture: tw.fixture, at: tw.fixtureAt, tw };
  }
  const f = parseFixture(s.fixture);
  return { label: s.css ? `${s.css} (lifted)` : s.source!, fixture: f, at: () => f };
}

function renderPage(model: Model, p: Page, widths: number[]): Layout[] {
  return p.tw ? widths.map((w) => render(model, p.at(w), [w])[0]) : render(model, p.fixture, widths);
}

function load(s: SourceInput & { fixture?: string }): Source {
  if (s.tailwind) {
    if (!s.fixture) throw new InputError("--tailwind needs the Tailwind page as <fixture.html>");
    if (s.sourceText !== undefined) return loadSource(s.source ?? `${s.fixture} (tailwind)`, s.sourceText);
    return loadSource(`${s.fixture} (tailwind)`, tailwindFile(s.fixture, s.tailwind).yaml);
  }
  if (s.css) return loadSource(`${s.css} (lifted)`, liftFile(s.css).yaml);
  if (!s.source) throw new InputError("needs --source <file.cadesa.yaml> or --css <file.css>");
  return s.sourceText !== undefined ? loadSource(s.source, s.sourceText) : loadSourceFile(s.source);
}

/** For --css and --tailwind inputs: the lift and its box-level impact at each width. */
function impactFor(s: SourceInput & { fixture: string }, layouts: ReturnType<typeof render>) {
  if (s.tailwind) {
    const tw = tailwindFile(s.fixture, s.tailwind);
    return { lifted: tw.lifted, impacts: tailwindImpact(tw, layouts) };
  }
  if (!s.css) return undefined;
  const lifted = liftFile(s.css);
  return { lifted, impacts: impact(lifted, parseFixture(s.fixture), layouts) };
}

/** Box-level impact for a Tailwind lift: static records plus what each layout decides. */
export function tailwindImpact(tw: TailwindLift, layouts: Layout[]): WidthImpact[] {
  return layouts.map((l) => impact({ ...tw.lifted, unlifted: [...tw.lifted.unlifted, ...tw.dynamic(l)] }, tw.fixtureAt(l.width), [l])[0]);
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

export function renderCmd(s: SourceInput & { fixture: string; widths: number[]; lines?: boolean; svg?: string }): Result {
  const t0 = performance.now();
  const p = pageOf(s);
  const layouts = renderPage(modelOf(load(s)), p, s.widths);
  // --svg out.svg: draw each width's predicted boxes (out.svg for one width, out-<width>.svg for several).
  const written: string[] = [];
  if (s.svg) {
    for (const l of layouts) {
      const file = layouts.length === 1 ? s.svg : s.svg.replace(/(\.svg)?$/, `-${l.width}.svg`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, wireframeSvg(l));
      written.push(file);
    }
  }
  const imp = impactFor(s, layouts);
  const label = p.label;
  const fonts = fontsOf(s, layouts);
  return {
    text:
      formatRender(layouts, { source: label, fixture: s.fixture, ms: ms(t0), lines: s.lines, impacts: imp?.impacts }) +
      (imp ? "\n" + formatImpact(imp.impacts) : "") +
      (written.length ? `\nwireframe: ${written.join(", ")}\n` : "") +
      fontsNote(fonts, s, true),
    data: { source: label, fixture: s.fixture, layouts, impact: imp?.impacts, fonts: fontsData(fonts) },
    ok: !layouts.some((l) => l.issues.some((i) => i.severity === "error")),
  };
}

export function whatifCmd(s: SourceInput & { fixture: string; widths: number[]; changes: Change[] }): Result {
  if (!s.changes.length) throw new InputError("whatif needs at least one change (path=value)");
  const t0 = performance.now();
  const p = pageOf(s);
  let result: WhatIf;
  if (p.tw) {
    const src = load(s);
    const per = s.widths.map((w) => whatif(src, p.at(w), [w], s.changes));
    result = { changes: per[0].changes, widths: per.flatMap((r) => r.widths) };
  } else result = whatif(load(s), p.fixture, s.widths, s.changes);
  return { text: formatWhatif(result, { ms: ms(t0) }), data: result, ok: true };
}

export function explainCmd(s: SourceInput & { fixture: string; widths: number[]; id: string }): Result {
  const id = s.id.replace(/^#/, "");
  const model = modelOf(load(s));
  const results = renderPage(model, pageOf(s), s.widths).map((l) => explain(model, l, id));
  if (results.some((r) => !r)) throw new InputError(`no element with data-fixture="${id}" in ${s.fixture}`);
  return { text: results.map((r) => formatExplain(r!)).join("\n"), data: results, ok: true };
}

export function checkCmd(s: SourceInput & { fixture: string; widths: number[] }): Result {
  const p = pageOf(s);
  const layouts = renderPage(modelOf(load(s)), p, s.widths);
  const imp = impactFor(s, layouts);
  const findings = check(layouts, imp?.impacts);
  if (p.tw) {
    // Tailwind: also name the element in the page, where the utilities are edited.
    const lines = new Map<string, number>();
    const visit = (ns: Fixture["body"]) => ns.forEach((n) => (n.fixtureId && n.line && lines.set(n.fixtureId, n.line), visit(n.children)));
    visit(p.fixture.body);
    for (const f of findings) if (lines.has(f.id)) f.message += ` [${s.fixture}:${lines.get(f.id)}]`;
  }
  const fonts = fontsOf(s, layouts);
  return {
    text: formatCheck(findings, s.widths) + fontsNote(fonts, s, false),
    data: { findings, fonts: fontsData(fonts) },
    ok: !findings.some((f) => f.severity === "error"),
  };
}

// ------------------------------------------------------------------ fonts

/** The fonts a laid-out page's text uses, and what Cadesa knows about each. */
function fontsOf(s: SourceInput & { fixture: string }, layouts: Layout[]): FontReport[] {
  return fontReport(fontUses(layouts), pageFontSources(s.fixture, [s.css, s.tailwind].filter((x): x is string => !!x)));
}

const fontsData = (r: FontReport[]) =>
  r.map((f) => ({
    family: f.family,
    stack: f.stack,
    status: f.status,
    weights: f.weights,
    boxes: f.boxes.length,
    ...(f.metrics && { metrics: f.metrics.file, bundled: f.metrics.bundled, measuredFrom: f.metrics.files ?? f.metrics.source }),
    ...(f.note && { note: f.note }),
  }));

const flags = (s: SourceInput & { fixture: string }) =>
  `${s.fixture}${s.tailwind ? ` --tailwind ${s.tailwind}` : s.css ? ` --css ${s.css}` : s.source ? ` --source ${s.source}` : ""}`;

/**
 * For render and check: which metrics measured the text, and which fonts couldn't be measured.
 * check says nothing when every font has metrics that aren't machine-specific.
 */
function fontsNote(r: FontReport[], s: SourceInput & { fixture: string }, always: boolean): string {
  const missing = r.filter((f) => f.status !== "measured" && f.boxes.length);
  const machine = r.filter((f) => f.metrics?.machineSpecific);
  if (!always && !missing.length && !machine.length) return "";
  const out = ["", always ? "text measured with:" : "fonts:"];
  for (const f of r.filter((f) => f.status === "measured")) if (always || f.metrics!.machineSpecific) out.push(`  ✓ ${f.family}: ${describeMetrics(f.metrics!)}`);
  for (const f of machine) out.push(`    ! ${f.metrics!.machineSpecific}`);
  for (const f of missing)
    out.push(
      `  ✗ ${f.family}: no metrics (${f.boxes.length} text box${f.boxes.length === 1 ? "" : "es"} assumed to be one line) · ${
        f.status === "file" ? "@font-face file in the page" : f.status === "google" ? "Google Fonts" : f.note
      }`,
    );
  if (missing.some((f) => f.status !== "system")) out.push(`  measure them: cadesa fonts ${flags(s)} --measure`);
  else if (missing.length) out.push(`  system fonts differ by machine; cadesa fonts ${flags(s)} --measure --system measures this machine's`);
  return out.join("\n") + "\n";
}

/**
 * `cadesa fonts`: every font the page's text is set in, whether Cadesa has metrics for it, and
 * where it comes from. With `measure`, measures each one it can (Playwright + Chromium), writing
 * metrics where `cadesa metrics` does.
 */
export async function fontsCmd(
  s: SourceInput & { fixture: string; widths: number[]; measure?: boolean; system?: boolean; out?: string; via?: "cli" | "mcp" },
): Promise<Result> {
  const p = pageOf(s);
  const model = modelOf(load(s));
  let report = fontsOf(s, renderPage(model, p, s.widths));
  let measured: Measured[] | undefined;
  let text = "";
  if (s.measure) {
    measured = await measureReport(report, { out: s.out, system: s.system });
    text += formatMeasured(measured) + (measured.length ? "\n" : "");
    report = fontsOf(s, renderPage(model, p, s.widths));
  }
  const measurable = report.some((f) => f.status === "file" || f.status === "google" || !!f.remeasure);
  const system = report.some((f) => (f.status === "system" || f.status === "unknown") && !!f.stack);
  const how = (extra: string) => (s.via === "mcp" ? `call cadesa_fonts again with measure: true${extra ? ", system: true" : ""}` : `cadesa fonts ${flags(s)} --measure${extra}`);
  const hint = s.measure
    ? system && !s.system
      ? `system fonts (and fonts the page doesn't load) differ by machine; to measure what this machine's browser uses anyway (machine-specific metrics): ${how(" --system")}`
      : undefined
    : measurable
      ? `measure them (needs Playwright and Chrome/Chromium; Google Fonts are downloaded): ${how("")}`
      : system
        ? `system fonts (and fonts the page doesn't load) differ by machine; to measure what this machine's browser uses anyway (machine-specific metrics): ${how(" --system")}`
        : undefined;
  text += formatFonts(s.fixture, report, hint);
  return {
    text,
    data: { fonts: fontsData(report), ...(measured && { measured }) },
    ok: !measured?.some((m) => m.error),
  };
}

/** `cadesa metrics`: measure one font (a file, a Google font by name, or an installed font). */
export async function metricsCmd(s: {
  font?: string;
  family?: string;
  weight?: number;
  google?: string;
  system?: boolean;
  weights?: number[];
  out?: string;
}): Promise<Result> {
  const out = s.out ?? join(".cadesa", "metrics");
  let measured: Measured;
  if (s.google) {
    const browser = await launchChromium();
    try {
      measured = await measureGoogle(s.google, { out, cacheDir: join(dirname(out), "fonts"), browser, weights: s.weights });
    } finally {
      await browser.close();
    }
  } else if (s.system) {
    if (!s.family) throw new InputError("metrics --system needs --family <installed font name>");
    const browser = await launchChromium();
    try {
      measured = await measureSystem(s.family, s.weights?.length ? s.weights : [400, 700], { out, browser });
    } finally {
      await browser.close();
    }
  } else {
    if (!s.font) throw new InputError("metrics needs <font-file>, --google <family> or --system --family <name>");
    if (!s.family) throw new InputError("metrics needs --family <name> (the font-family name your CSS uses)");
    const m = await generateMetrics({ font: s.font, family: s.family, weight: s.weight });
    const file = writeMetrics(m, out);
    const pairs = Object.values(m.kerning).reduce((n, k) => n + Object.keys(k).length, 0);
    const text = `wrote ${file}: ${m.family} (${m.kind}${s.weight ? ` ${s.weight}` : ", 100–900"}), ${m.chars.length} glyphs, ${pairs} kerning pairs${m.missing ? `; no glyph for ${[...m.missing].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ")}` : ""}\n`;
    return { text, data: { file, family: m.family, kind: m.kind, weights: m.weights, files: m.files }, ok: true };
  }
  if (measured.error) return { text: `✖ ${measured.family}: ${measured.error}\n`, data: measured, ok: false };
  return { text: formatMeasured([measured]), data: measured, ok: true };
}

export function critiqueCmd(s: SourceInput & { fixture: string; widths: number[] }): Result {
  const model = modelOf(load(s));
  const p = pageOf(s);
  const found = critique(model, p.fixture, renderPage(model, p, s.widths));
  const text = found.length
    ? found.map((c) => `◇ [${c.check}] ${c.message}${c.path ? `\n    edit: ${c.path}` : ""}`).join("\n") + `\n\n${found.length} suggestion${found.length === 1 ? "" : "s"}\n`
    : `✓ no critique at ${s.widths.join(", ")}px\n`;
  return { text, data: { critique: found }, ok: true };
}

export function liftCmd(s: { css: string; out?: string; fixture?: string; widths: number[]; tailwind?: string }): Result {
  if (s.tailwind) return liftTailwindCmd({ ...s, page: s.tailwind });
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

/** `cadesa lift --tailwind page.html --css compiled.css`: a source plus the page with generated classes and ids. */
function liftTailwindCmd(s: { css: string; page: string; out?: string; widths: number[] }): Result {
  const tw = tailwindFile(s.page, s.css);
  const fixtureOut = s.out ? join(dirname(s.out), `${basename(s.page).replace(/\.html?$/, "")}.cadesa.html`) : undefined;
  if (s.out) {
    mkdirSync(dirname(s.out), { recursive: true });
    writeFileSync(s.out, tw.yaml);
    writeFileSync(fixtureOut!, tw.standaloneHtml);
  }
  const model = modelOf(loadSource(s.out ?? `${s.page} (tailwind)`, tw.yaml)); // the lift must always produce a valid source
  const impacts = tailwindImpact(tw, s.widths.map((w) => render(model, tw.fixtureAt(w), [w])[0]));
  const states = tw.states.map((st) => (st.name ? `${st.name} (≤ ${st.raw})` : "base")).join(", ");
  const head =
    formatLift(tw.lifted, { out: s.out, impacts }) +
    (s.out ? `wrote ${fixtureOut} (the page with generated ca-* classes and data-fixture ids)\n` : "") +
    `width ranges: ${states}\n` +
    (tw.responsive.length ? `shown at some widths only: ${tw.responsive.map((id) => `#${id}`).join(", ")} (laid out only where shown with --tailwind)\n` : "");
  return {
    text: head + (s.out ? "" : "\n" + tw.yaml),
    data: { source: tw.yaml, fixture: tw.html, unlifted: tw.lifted.unlifted, stats: tw.lifted.stats, impact: impacts, states: tw.states, responsive: tw.responsive },
    ok: true,
  };
}
