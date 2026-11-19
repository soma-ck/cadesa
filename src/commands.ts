/** Command implementations shared by the CLI and the MCP server. Each returns text and data. */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { check } from "./check.js";
import { wireframeSvg } from "./wireframe.js";
import { critique } from "./critique.js";
import { compile } from "./compile.js";
import { explain } from "./explain.js";
import { parseFixture, type Fixture } from "./fixture.js";
import { loadSource, loadSourceFile, type Source } from "./load.js";
import { diffLayouts, modelOf, render, whatif, type Change, type WhatIf } from "./project.js";
import { walk, type Layout } from "./engine/layout.js";
import type { Model } from "./model.js";
import { liftTailwind, type TailwindLift } from "./tailwind/lift.js";
import { liftCssPage } from "./lift/css-page.js";
import type { PageLift } from "./lift/page.js";
import { type Coverage, coverage, formatCoverage, formatCheck, shortenPaths, formatExplain, formatImpact, formatLift, formatRender, formatWhatif } from "./report.js";
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
import { pointFindings, Pointers } from "./pointers.js";
import { verifyFindings, type VerifyReport } from "./verify.js";
import { capture, formatCapture } from "./capture.js";
import { checkAddedCss, compareFindings, type FindingChange } from "./whatif-check.js";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

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

/**
 * --css entries that are directories: their stylesheets, in name order (what capture writes:
 * css/01-…, css/02-…). Other entries are kept as given.
 */
export function cssList(spec: string): string[] {
  return spec
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean)
    .flatMap((f) => {
      if (!existsSync(f) || !statSync(f).isDirectory()) return [f];
      const files = readdirSync(f)
        .filter((n) => /\.css$/i.test(n))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
        .map((n) => join(f, n));
      if (!files.length) throw new InputError(`no .css files in ${f}`);
      return files;
    });
}

/** The input with --css (and --after) directories expanded into their files. */
function withCssDir<T extends { css?: string; after?: string }>(s: T): T {
  return {
    ...s,
    ...(s.css && { css: cssList(s.css).join(",") }),
    ...(s.after && { after: cssList(s.after).join(",") }),
  };
}

const liftFile = (css: string) => lift(css, readFileSync(css, "utf8"));

const pageCache = new Map<string, PageLift>();
/** Lift a page with its stylesheet (cached per file contents, so one command lifts once). */
function pageLiftFile(kind: "tailwind" | "css", page: string, css: string): PageLift {
  const html = readFileSync(page, "utf8");
  // --css takes several stylesheets, comma-separated (a framework's CSS and the app's own).
  const files = (kind === "css" ? css.split(",").map((f) => f.trim()).filter(Boolean) : [css]).map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const hash = createHash("sha256").update(kind).update("\0").update(page).update("\0").update(html);
  for (const f of files) hash.update("\0").update(f.file).update("\0").update(f.text);
  const key = hash.digest("hex");
  let t = pageCache.get(key);
  if (!t) {
    t = kind === "tailwind" ? liftTailwind(page, html, css, files[0].text) : liftCssPage(page, html, files);
    pageCache.clear();
    pageCache.set(key, t);
  }
  return t;
}

/** Lift a Tailwind page (cached per file contents, so one command lifts once). */
export function tailwindFile(page: string, css: string): TailwindLift {
  return pageLiftFile("tailwind", page, css);
}

/** Lift an HTML page with its plain CSS: the cascade element by element (cached per file contents). */
export function cssPageFile(page: string, css: string): PageLift {
  return pageLiftFile("css", page, css);
}

/** The page lift behind --tailwind, or --css with a page (fixture). */
function pageLiftOf(s: SourceInput & { fixture?: string }): PageLift | undefined {
  if (s.tailwind) {
    if (!s.fixture) throw new InputError("--tailwind needs the Tailwind page as <fixture.html>");
    return tailwindFile(s.fixture, s.tailwind);
  }
  if (s.css && s.fixture) return cssPageFile(s.fixture, s.css);
  return undefined;
}

/** The page a command lays out: one fixture, or (Tailwind) one per width range. */
interface Page {
  label: string;
  fixture: Fixture;
  at(width: number): Fixture;
  tw?: PageLift;
}

function pageOf(s: SourceInput & { fixture: string }): Page {
  const tw = pageLiftOf(s);
  if (tw) return { label: `${s.fixture} (${s.tailwind ? `Tailwind, ${s.tailwind}` : `CSS, ${s.css}`})`, fixture: tw.fixture, at: tw.fixtureAt, tw };
  const f = parseFixture(s.fixture);
  return { label: s.css ? `${s.css} (lifted)` : s.source!, fixture: f, at: () => f };
}

/** The page lift's notes for the reader, shown under the coverage line. */
function withNotes(c: Coverage, p: Page): Coverage {
  if (p.tw?.notes.length) c.notes = p.tw.notes;
  return c;
}

function renderPage(model: Model, p: Page, widths: number[]): Layout[] {
  return p.tw ? widths.map((w) => render(model, p.at(w), [w])[0]) : render(model, p.fixture, widths);
}

function load(s: SourceInput & { fixture?: string }): Source {
  const tw = pageLiftOf(s);
  if (tw) {
    const label = `${s.fixture} (${s.tailwind ? "tailwind" : "lifted"})`;
    if (s.sourceText !== undefined) return loadSource(s.source ?? label, s.sourceText);
    return loadSource(label, tw.yaml);
  }
  if (s.css) return loadSource(`${s.css} (lifted)`, liftFile(s.css).yaml);
  if (!s.source) throw new InputError("needs --source <file.cadesa.yaml> or --css <file.css>");
  return s.sourceText !== undefined ? loadSource(s.source, s.sourceText) : loadSourceFile(s.source);
}

/** For --css and --tailwind inputs: the lift and its box-level impact at each width. */
function impactFor(s: SourceInput & { fixture: string }, layouts: ReturnType<typeof render>) {
  const tw = pageLiftOf(s);
  if (tw) return { lifted: tw.lifted, impacts: tailwindImpact(tw, layouts) };
  if (!s.css) return undefined;
  const lifted = liftFile(s.css);
  return { lifted, impacts: impact(lifted, parseFixture(s.fixture), layouts) };
}

/** Box-level impact for a page lift (Tailwind or CSS): static records plus what each layout decides. */
export function tailwindImpact(tw: PageLift, layouts: Layout[]): WidthImpact[] {
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
  s = withCssDir(s);
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
    text: shortenPaths(
      formatCoverage(withNotes(coverage(layouts, imp?.impacts), p)) +
      formatRender(layouts, { source: label, fixture: s.fixture, ms: ms(t0), lines: s.lines, impacts: imp?.impacts }) +
      (imp ? "\n" + formatImpact(imp.impacts) : "") +
      (written.length ? `\nwireframe: ${written.join(", ")}\n` : "") +
      fontsNote(fonts, s, true)),
    data: { source: label, fixture: s.fixture, layouts, impact: imp?.impacts, fonts: fontsData(fonts) },
    ok: !layouts.some((l) => l.issues.some((i) => i.severity === "error")),
  };
}

/**
 * The widths whatif checks when none are given: the same sweep as check, plus the width on each
 * side of every breakpoint, where an edit is most likely to change behaviour.
 */
function whatifWidths(model: Model, p: Page): number[] {
  const out = new Set(parseWidths(SWEEP));
  const edge = (px: number) => {
    // A max-width breakpoint applies up to px inclusive: sample the last width inside and the first outside.
    const inside = Math.floor(px);
    for (const w of [inside, inside + 1]) if (w >= 320 && w <= 1440) out.add(w);
  };
  for (const b of model.breakpoints) edge(b.length.px);
  for (const st of p.tw?.states ?? []) if (Number.isFinite(st.hi)) edge(Math.ceil(st.hi) - 1);
  return [...out].sort((a, b) => a - b);
}

export function whatifCmd(
  s: SourceInput & { fixture: string; widths?: number[]; changes: Change[]; after?: string; addCss?: string },
): Result {
  s = withCssDir(s);
  if (s.after || s.addCss) return cssWhatifCmd({ ...s, css: s.css ?? "" });
  if (!s.changes.length) throw new InputError("whatif needs at least one change (path=value), or with --css: --after <new.css> or --add-css <rules>");
  const t0 = performance.now();
  const p = pageOf(s);
  const src = load(s);
  const widths = s.widths?.length ? s.widths : whatifWidths(modelOf(src), p);
  let result: WhatIf;
  if (p.tw) {
    const per = widths.map((w) => whatif(src, p.at(w), [w], s.changes));
    result = { changes: per[0].changes, widths: per.flatMap((r) => r.widths) };
    Object.defineProperty(result, "before", { value: per.flatMap((r) => r.before!), enumerable: false });
    Object.defineProperty(result, "after", { value: per.flatMap((r) => r.after!), enumerable: false });
  } else result = whatif(src, p.fixture, widths, s.changes);
  // Carry the engine's uncertainty into the diff: a box predicted approximately (≈) before or
  // after the edit can move in a browser even where the prediction says it didn't.
  const approx = (ls: Layout[]) => {
    const imp = impactFor(s, ls)?.impacts;
    return ls.map((l) => {
      const ids = new Set((imp?.find((i) => i.width === l.width)?.uncertain ?? []).map((u) => u.id));
      for (const b of walk(l.boxes)) if (b.assumptions.length) ids.add(b.id);
      return ids;
    });
  };
  const [a, b] = [approx(result.before!), approx(result.after!)];
  result.widths.forEach((w, i) => (w.approximate = [...new Set([...a[i], ...b[i]])]));
  const ia = impactFor(s, result.after!)?.impacts;
  const cov = withNotes(coverage(result.after!, ia), p);
  const findings = findingChanges(result.before!, impactFor(s, result.before!)?.impacts, p.tw, result.after!, ia, p.tw);
  return {
    text: shortenPaths(formatWhatif(result, { ms: ms(t0), coverage: cov, defaulted: !s.widths?.length, findings })),
    data: { coverage: cov, findings: findingsData(findings), ...result },
    ok: true,
  };
}

/** check before and after an edit, compared: what it fixes, what it leaves, what it adds. */
function findingChanges(before: Layout[], ib: WidthImpact[] | undefined, pb: PageLift | undefined, after: Layout[], ia: WidthImpact[] | undefined, pa: PageLift | undefined): FindingChange[] {
  const fb = check(before, ib, pb);
  const fa = check(after, ia, pa);
  const changes = compareFindings(fb, fa);
  // Compared by generated id first; then named as check names them (element, rules).
  if (pb) pointFindings(fb, pb);
  if (pa) pointFindings(fa, pa);
  return changes;
}

const findingsData = (cs: FindingChange[]) =>
  cs.map((c) => ({
    status: c.status,
    check: c.check,
    severity: c.finding.severity,
    ...(c.finding.inconclusive && { inconclusive: true }),
    id: c.finding.id,
    message: c.finding.message,
    ...(c.was && { before: c.was.message }),
    widths: c.widths,
    ...(c.finding.element && { element: c.finding.element }),
    ...(c.finding.source && { source: c.finding.source }),
  }));

/**
 * The --css file whose rules come last in the page's cascade (where --add-css rules go): the
 * page links its stylesheets in its own order, and given files it doesn't link come first.
 */
export function lastInCascade(html: string, files: string[]): number {
  const base = (f: string) => f.replace(/[?#].*$/, "").replace(/^.*[\\/]/, "");
  const links = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((t) => /\brel\s*=\s*["']?[^"'>]*\bstylesheet/i.test(t) && !/\balternate\b/i.test(t))
    .map((t) => /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(t))
    .map((h) => base(h?.[1] ?? h?.[2] ?? h?.[3] ?? ""));
  // Each file's place in the cascade: the link it's matched to by name, -1 when the page doesn't link it.
  const pos = files.map(() => -1);
  const taken = new Set<number>();
  links.forEach((name, at) => {
    const i = files.findIndex((f, k) => pos[k] < 0 && base(f) === name);
    if (i >= 0) (pos[i] = at), taken.add(at);
  });
  // As many unmatched files as unmatched links: the same stylesheets under other names, in order.
  const looseFiles = files.map((_, k) => k).filter((k) => pos[k] < 0);
  const looseLinks = links.map((_, at) => at).filter((at) => !taken.has(at));
  if (looseFiles.length && looseFiles.length === looseLinks.length) looseFiles.forEach((k, j) => (pos[k] = looseLinks[j]));
  let last = files.length - 1;
  pos.forEach((p, k) => {
    if (p > pos[last] || (p === pos[last] && k > last)) last = k;
  });
  return last;
}

/**
 * whatif for plain CSS: lay the page out with its stylesheets as they are and as edited (other
 * files in place of them with `after`, or `addCss` rules appended to the last one), and report
 * what moves at each width. Nothing is written.
 */
function cssWhatifCmd(s: { fixture: string; css: string; widths?: number[]; after?: string; addCss?: string }): Result {
  if (!s.css) throw new InputError("--after and --add-css preview a CSS edit: they need the page's stylesheets as --css");
  const t0 = performance.now();
  const split = (l: string) => l.split(",").map((f) => f.trim()).filter(Boolean);
  const html = readFileSync(s.fixture, "utf8");
  const read = (files: string[]) => files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const beforeFiles = read(split(s.css));
  let afterFiles = beforeFiles;
  if (s.after) {
    if (split(s.after).length !== beforeFiles.length)
      throw new InputError(`--after names ${split(s.after).length} stylesheet(s) and --css ${beforeFiles.length}: give one file for each, in the same order (unchanged ones repeated)`);
    afterFiles = read(split(s.after));
    // Rules keep pointing at the file the page links, so the cascade order is unchanged.
    afterFiles = afterFiles.map((f, i) => ({ file: beforeFiles[i].file, text: f.text }));
  }
  // Added rules go at the end of the stylesheet that comes last in the page's cascade.
  let added: { file: string; firstLine: number } | undefined;
  if (s.addCss) {
    const i = lastInCascade(html, afterFiles.map((f) => f.file));
    const last = afterFiles[i];
    added = { file: last.file, firstLine: last.text.split("\n").length + 1 };
    afterFiles = afterFiles.map((f, k) => (k === i ? { file: f.file, text: `${f.text}\n${s.addCss}\n` } : f));
  }
  const lb = liftCssPage(s.fixture, html, beforeFiles);
  const la = liftCssPage(s.fixture, html, afterFiles);
  const mb = modelOf(loadSource(`${s.fixture} (lifted)`, lb.yaml));
  const ma = modelOf(loadSource(`${s.fixture} (lifted, edited)`, la.yaml));
  const pb: Page = { label: s.fixture, fixture: lb.fixture, at: lb.fixtureAt, tw: lb };
  const pa: Page = { label: s.fixture, fixture: la.fixture, at: la.fixtureAt, tw: la };
  const widths = s.widths?.length ? s.widths : [...new Set([...whatifWidths(mb, pb), ...whatifWidths(ma, pa)])].sort((a, b) => a - b);
  const before = renderPage(mb, pb, widths);
  const after = renderPage(ma, pa, widths);
  const ib = tailwindImpact(lb, before);
  const ia = tailwindImpact(la, after);
  const approx = (ls: Layout[], imp: WidthImpact[], i: number) => {
    const ids = new Set((imp[i]?.uncertain ?? []).map((u) => u.id));
    for (const b of walk(ls[i].boxes)) if (b.assumptions.length) ids.add(b.id);
    return ids;
  };
  const result: WhatIf = {
    changes: [
      ...(s.after ? split(s.css).map((f, i) => ({ path: f, from: "as is", to: split(s.after!)[i] })).filter((c) => c.path !== c.to) : []),
      ...(s.addCss ? [{ path: added!.file, from: "as is", to: `+ ${s.addCss.replace(/\s+/g, " ").trim()}` }] : []),
    ],
    widths: widths.map((w, i) => {
      const d = diffLayouts(before[i], after[i], { valuesOnly: true });
      // The generated source's provenance means nothing to someone editing CSS: show values only.
      for (const e of d.elements) for (const p of e.props) if (p.to) p.to = { ...p.to, steps: [] };
      d.approximate = [...new Set([...approx(before, ib, i), ...approx(after, ia, i)])];
      return d;
    }),
  };
  const cov = withNotes(coverage(after, ia), pa);
  const findings = findingChanges(before, ib, lb, after, ia, la);
  const texts = new Map(afterFiles.map((f) => [f.file, f.text]));
  const addedCss = added && checkAddedCss(la, s.addCss!, added.file, added.firstLine, (f) => texts.get(f));
  return {
    text: shortenPaths(formatWhatif(result, { ms: ms(t0), coverage: cov, defaulted: !s.widths?.length, findings, addedCss, css: true })),
    data: { coverage: cov, findings: findingsData(findings), ...(addedCss && { addedCss }), ...result },
    ok: true,
  };
}

export function explainCmd(s: SourceInput & { fixture: string; widths: number[]; id: string }): Result {
  s = withCssDir(s);
  const id = s.id.replace(/^#/, "");
  const model = modelOf(load(s));
  const results = renderPage(model, pageOf(s), s.widths).map((l) => explain(model, l, id));
  if (results.some((r) => !r)) throw new InputError(`no element with data-fixture="${id}" in ${s.fixture}`);
  return { text: results.map((r) => formatExplain(r!)).join("\n"), data: results, ok: true };
}

/** The engine's sweep for check: findings, coverage and what verify and the pointers need. */
function runCheck(s: SourceInput & { fixture: string; widths: number[] }) {
  const p = pageOf(s);
  const layouts = renderPage(modelOf(load(s)), p, s.widths);
  const imp = impactFor(s, layouts);
  const findings = check(layouts, imp?.impacts, p.tw);
  const cov = withNotes(coverage(layouts, imp?.impacts), p);
  return { p, layouts, impacts: imp?.impacts, findings, cov };
}

function finishCheck(s: SourceInput & { fixture: string; widths: number[] }, run: ReturnType<typeof runCheck>, verified?: VerifyReport): Result {
  const { p, layouts, findings, cov } = run;
  // On a lifted page, name the element in the page and the CSS rules behind each finding.
  if (p.tw) pointFindings(findings, p.tw);
  const fonts = fontsOf(s, layouts);
  return {
    text: formatCheck(findings, s.widths, cov, verified) + fontsNote(fonts, s, false),
    data: { coverage: cov, findings, fonts: fontsData(fonts), ...(verified && { verify: verified }) },
    ok: !findings.some((f) => f.severity === "error" && !f.inconclusive && f.verified?.status !== "not reproduced"),
  };
}

export function checkCmd(s: SourceInput & { fixture: string; widths: number[] }): Result {
  s = withCssDir(s);
  return finishCheck(s, runCheck(s));
}

/** `check --verify`: the sweep, then each finding measured in Chromium (Playwright). */
export async function checkVerifyCmd(s: SourceInput & { fixture: string; widths: number[] }): Promise<Result> {
  s = withCssDir(s);
  const run = runCheck(s);
  if (!run.p.tw) throw new InputError("--verify needs a page with its CSS: --css <file.css> or --tailwind <compiled.css>");
  const cssFiles = (s.tailwind ?? s.css!).split(",").map((f) => f.trim()).filter(Boolean);
  const names = new Pointers(run.p.tw);
  const describe = (id: string) => {
    const e = names.element(id);
    return `${names.short(id) ?? `#${id}`}${e?.line ? ` (${basename(e.file)}:${e.line})` : ""}`;
  };
  const report = await verifyFindings({ page: s.fixture, html: run.p.tw.html, cssFiles, findings: run.findings, layouts: run.layouts, impacts: run.impacts, describe });
  return finishCheck(s, run, report);
}

// ------------------------------------------------------------------ fonts

/** The fonts a laid-out page's text uses, and what Cadesa knows about each. */
function fontsOf(s: SourceInput & { fixture: string }, layouts: Layout[]): FontReport[] {
  return fontReport(fontUses(layouts), pageFontSources(s.fixture, [...(s.css ? cssList(s.css) : []), ...(s.tailwind ? [s.tailwind] : [])]));
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
  s = withCssDir(s);
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
      ? `measure them (needs Chrome or Chromium; Google Fonts are downloaded): ${how("")}`
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
  s = withCssDir(s);
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
  if (s.fixture) return liftTailwindCmd({ ...s, page: s.fixture, plain: true });
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
function liftTailwindCmd(s: { css: string; page: string; out?: string; widths: number[]; plain?: boolean }): Result {
  const tw = s.plain ? cssPageFile(s.page, s.css) : tailwindFile(s.page, s.css);
  const fixtureOut = s.out ? join(dirname(s.out), `${basename(s.page).replace(/\.html?$/, "")}.cadesa.html`) : undefined;
  if (s.out) {
    mkdirSync(dirname(s.out), { recursive: true });
    writeFileSync(s.out, tw.yaml);
    writeFileSync(fixtureOut!, tw.standaloneHtml);
  }
  const model = modelOf(loadSource(s.out ?? `${s.page} (${s.plain ? "lifted" : "tailwind"})`, tw.yaml)); // the lift must always produce a valid source
  const impacts = tailwindImpact(tw, s.widths.map((w) => render(model, tw.fixtureAt(w), [w])[0]));
  const states = tw.states.map((st) => (st.name ? `${st.name} (≤ ${st.raw})` : "base")).join(", ");
  const head =
    formatLift(tw.lifted, { out: s.out, impacts }) +
    (s.out ? `wrote ${fixtureOut} (the page with generated ca-* classes and data-fixture ids)\n` : "") +
    `width ranges: ${states}\n` +
    (tw.responsive.length ? `shown at some widths only: ${tw.responsive.map((id) => `#${id}`).join(", ")} (laid out only where shown with ${s.plain ? "--css" : "--tailwind"})\n` : "");
  return {
    text: head + (s.out ? "" : "\n" + tw.yaml),
    data: { source: tw.yaml, fixture: tw.html, unlifted: tw.lifted.unlifted, stats: tw.lifted.stats, impact: impacts, states: tw.states, responsive: tw.responsive },
    ok: true,
  };
}

/**
 * `cadesa capture <url>`: save the page as Chromium rendered it (DOM, stylesheets, fonts) for
 * check. A local file path is loaded as a file:// URL.
 */
export async function captureCmd(s: { url: string; out?: string; loginScript?: string; wait?: string; width?: number }): Promise<Result> {
  const url = /^[a-z][\w+.-]*:/i.test(s.url) ? s.url : existsSync(s.url) ? pathToFileURL(resolvePath(s.url)).href : undefined;
  if (!url) throw new InputError(`capture needs a URL (https://...) or an existing file; got "${s.url}"`);
  if (s.loginScript && !existsSync(s.loginScript)) throw new InputError(`no login script at ${s.loginScript}`);
  const r = await capture({ url, out: s.out ?? "capture", loginScript: s.loginScript, wait: s.wait, width: s.width });
  return { text: formatCapture(r), data: r, ok: true };
}
