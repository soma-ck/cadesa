/**
 * `check --verify`: after the engine's sweep, load the page in Chromium at the widths with
 * findings (and a few without), measure the elements the findings are about, and mark each
 * finding confirmed or not reproduced. Inconclusive findings are decided by what Chromium shows.
 * The page is served as the lift saw it (its stylesheets from the --css files, scripts removed),
 * with the data-fixture ids the engine's boxes carry, so each box is matched to its element.
 */
import { basename, dirname, relative, resolve, sep } from "node:path";
import { measureBoxes, rectDelta, serveFiles, settle, type Page } from "./browser.js";
import { composite, contrast, type Finding } from "./check.js";
import { walk, type Layout } from "./engine/layout.js";
import type { WidthImpact } from "./lift/impact.js";
import { findChrome, launchChromium } from "./metrics.js";
import { fmtPx } from "./resolve.js";

export interface Verified {
  status: "confirmed" | "not reproduced" | "predicted";
  /** What Chromium measured, e.g. "40×40px" or "text #6c757d on #f4f6f9 is 4.33:1". */
  detail?: string;
  /** Widths Chromium also shows this issue at, though the engine didn't report it there. */
  alsoAt?: number[];
}

export interface VerifyReport {
  browser: string;
  /** Widths loaded in Chromium: every width with a finding (up to a limit) and a sample of the others. */
  widths: number[];
  sampled: number[];
  /** Engine boxes compared with Chromium's at those widths, split by how the engine marked them. */
  boxes: { exact: number; exactDiffer: number; approximate: number; approximateDiffer: number; examples: string[] };
  notes: string[];
}

/** What to measure in Chromium for one finding, read from the finding the engine produced. */
type Probe =
  | { kind: "tap"; id: string }
  | { kind: "contrast"; id: string; run?: { tag: string; text: string } }
  | { kind: "overflow"; id: string; child: string }
  | { kind: "wrap"; id: string; textOnly?: boolean }
  | { kind: "height"; id: string }
  | { kind: "clip"; id: string; axis: "x" | "y" };

export function probeOf(f: Finding): Probe | undefined {
  if (f.check === "tap-target") return { kind: "tap", id: f.id };
  if (f.check === "contrast") {
    // An inline run (`"Apply now" (<a> in #card)`): found in Chromium by its tag and text inside the text box.
    const m = /^"(.*?)(…)?" \(<([\w-]+)> in /.exec(f.message);
    return m ? { kind: "contrast", id: f.id, run: { tag: m[3], text: m[1] } } : { kind: "contrast", id: f.id };
  }
  if (f.check === "clipped") {
    // "the text of #k is cut off by #b": #b is the box that clips (and scrolls) it.
    const by = /^the text of #[\w-]+ is cut off by #([\w-]+)/.exec(f.message);
    if (by) return { kind: "clip", id: by[1], axis: "x" };
    return /^the text of #[\w-]+ is cut off/.test(f.message) ? { kind: "clip", id: f.id, axis: /cut off at the bottom/.test(f.message) ? "y" : "x" } : undefined;
  }
  if (f.check !== "layout") return undefined;
  if (/^the text of #[\w-]+ doesn't wrap/.test(f.message)) return { kind: "wrap", id: f.id };
  let m = /^#([\w-]+) overflows #([\w-]+) by/.exec(f.message);
  if (m) return { kind: "overflow", id: m[2], child: m[1] };
  if (/^".*" in #[\w-]+ can't wrap/.test(f.message)) return { kind: "wrap", id: f.id };
  m = /^content of #([\w-]+) needs/.exec(f.message);
  if (m) return { kind: "height", id: f.id };
  return undefined;
}

const probeKey = (p: Probe) => JSON.stringify(p);

/** Why a finding without a probe isn't measured. */
export function unmeasured(f: Finding): string {
  if (f.check === "spacing") return "decided by the markup and the CSS, not by sizes: nothing to measure";
  if (f.check === "layout" && /no text role|loose text|can't be measured|isn't supported|not supported/.test(f.message))
    return "about what Cadesa can lay out, not about the page: nothing to measure";
  return "Cadesa has no measurement for this kind of finding";
}

interface Measured {
  displayed: boolean;
  w: number;
  h: number;
  /** contrast: text and background as #rrggbbaa, background undefined when an image is behind it. */
  color?: string;
  bg?: string;
  image?: boolean;
  large?: boolean;
  /** overflow / wrap / height: px past the content box. */
  over?: number;
  /** What couldn't be found in Chromium's page. */
  missing?: string;
}

/** Chromium's verdict on one probe, or why it can't give one. */
type Verdict = { shown: boolean; detail: string; severity?: "error" | "warning" } | { undecided: string };

/**
 * Runs in the page: measure each probe. Plain JS in a string so nothing the TypeScript build adds
 * ends up in the browser.
 */
const PROBE_SCRIPT = `(probes) => {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const hex = (c) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return "#" + [d[0], d[1], d[2], d[3]].map((v) => v.toString(16).padStart(2, "0")).join("");
  };
  const alpha = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[3] / 255; };
  const el = (id) => document.querySelector('[data-fixture="' + CSS.escape(id) + '"]');
  const content = (e) => {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return { right: r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight), r };
  };
  const norm = (t) => t.replace(/[ \\t\\n\\r\\f]+/g, " ").trim();
  const runIn = (box, run) => {
    if (!box || !run) return box;
    for (const c of box.querySelectorAll(run.tag)) if (norm(c.textContent).startsWith(run.text)) return c;
    return null;
  };
  return probes.map((p) => {
    const e = runIn(el(p.id), p.run);
    if (!e) return { displayed: false, w: 0, h: 0, missing: p.run ? "the <" + p.run.tag + "> run in the text box" : "the element" };
    const r = e.getBoundingClientRect();
    const out = { displayed: e.getClientRects().length > 0, w: r.width, h: r.height };
    if (p.kind === "contrast") {
      const cs = getComputedStyle(e);
      out.color = hex(cs.color);
      const size = parseFloat(cs.fontSize), weight = parseFloat(cs.fontWeight) || 400;
      out.large = size >= 24 || (size >= 18.66 && weight >= 700);
      const layers = [];
      let image = false;
      for (let a = e; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.backgroundImage && s.backgroundImage !== "none") { image = true; break; }
        if (alpha(s.backgroundColor) > 0) { layers.push(hex(s.backgroundColor)); if (alpha(s.backgroundColor) >= 0.999) break; }
      }
      out.image = image;
      out.layers = layers;
    } else if (p.kind === "overflow") {
      const c = el(p.child);
      if (c) {
        const m = parseFloat(getComputedStyle(c).marginRight) || 0;
        out.over = c.getBoundingClientRect().right + Math.min(0, m) - content(e).right;
      } else {
        // The child is a run of text (an anonymous box, no element of its own): the box's text itself.
        const range = document.createRange();
        let right = -Infinity;
        for (const n of e.childNodes) {
          if (n.nodeType !== 3 || !n.data.trim()) continue;
          range.selectNodeContents(n);
          for (const q of range.getClientRects()) right = Math.max(right, q.right);
        }
        if (right > -Infinity) out.over = right - content(e).right;
        else out.missing = "the overflowing child";
      }
    } else if (p.kind === "wrap") {
      const range = document.createRange();
      let right = -Infinity;
      // A run of text beside elements (an anonymous box): only the element's own text nodes.
      for (const n of p.textOnly ? [...e.childNodes].filter((n) => n.nodeType === 3 && n.data.trim()) : [e]) {
        range.selectNodeContents(n);
        for (const q of range.getClientRects()) right = Math.max(right, q.right);
      }
      if (right > -Infinity) out.over = right - content(e).right;
      else out.missing = "its text";
    } else if (p.kind === "height") {
      out.over = e.scrollHeight - e.clientHeight;
    } else if (p.kind === "clip") {
      // Scroll sizes are whole pixels: what's cut off, give or take one.
      out.over = p.axis === "x" ? e.scrollWidth - e.clientWidth : e.scrollHeight - e.clientHeight;
    }
    return out;
  });
}`;

/** [r, g, b, a] from #rrggbbaa. */
const hexOpaque = (h: string) => h.slice(0, 7);

/** Did Chromium show the problem, and with what numbers? */
function judge(p: Probe, m: Measured): Verdict {
  if (m.missing && !m.displayed) return { undecided: `${m.missing} isn't in the page Chromium loaded` };
  if (!m.displayed) return { shown: false, detail: "not displayed in Chromium" };
  if (m.over === undefined && p.kind !== "tap" && p.kind !== "contrast") return { undecided: `${m.missing ?? "what to measure"} isn't in the page Chromium loaded` };
  switch (p.kind) {
    case "tap": {
      const small = Math.min(m.w, m.h);
      const size = `${fmtPx(m.w)}×${fmtPx(m.h)}px`;
      if (small < 24) return { shown: true, detail: size, severity: "error" };
      if (small < 44 && Math.max(m.w, m.h) < 44) return { shown: true, detail: size, severity: "warning" };
      return { shown: false, detail: size };
    }
    case "contrast": {
      if (m.image) return { undecided: "an image is behind the text: its contrast depends on the image, which Chromium doesn't measure" };
      // Paint the backgrounds from the canvas (white) up, then the text over them.
      const layers = [...((m as Measured & { layers?: string[] }).layers ?? [])].reverse();
      let bg = "#ffffff";
      for (const l of layers) bg = composite(l, bg);
      const color = composite(m.color!, bg);
      const ratio = contrast(color, bg);
      const min = m.large ? 3 : 4.5;
      return { shown: ratio < min, detail: `text ${hexOpaque(color)} on ${hexOpaque(bg)} is ${ratio.toFixed(2)}:1; WCAG AA needs ${min}:1`, severity: "error" };
    }
    case "clip": {
      const over = m.over!;
      return { shown: over >= 1, detail: over >= 1 ? `${over}px of its text is cut off` : "its text fits", severity: "warning" };
    }
    default: {
      const by = Math.max(0, m.over!);
      return { shown: by > 0.5, detail: by > 0.5 ? `overflows by ${fmtPx(by)}px` : "fits", severity: "warning" };
    }
  }
}

/** Up to `n` widths spread evenly over `ws`, ends included. */
function spread(ws: number[], n: number): number[] {
  if (ws.length <= n) return ws;
  if (n <= 1) return ws.slice(0, n);
  return [...new Set(Array.from({ length: n }, (_, i) => ws[Math.round((i * (ws.length - 1)) / (n - 1))]))];
}

/**
 * The page as served to Chromium: scripts removed (the lift doesn't run them), and each
 * stylesheet the page links that was given as a --css file loaded from that file. Given files the
 * page doesn't link come first, as in the lift.
 */
export function pageForBrowser(html: string, page: string, cssFiles: string[]): string {
  const dir = dirname(resolve(page));
  const rel = (f: string) => relative(dir, resolve(f)).split(sep).join("/");
  const isSheet = (tag: string) => /\brel\s*=\s*["']?[^"'>]*\bstylesheet/i.test(tag) && !/\balternate\b/i.test(tag);
  const hrefOf = (tag: string) => /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const urlOf = (tag: string) => {
    const h = hrefOf(tag);
    return h?.[1] ?? h?.[2] ?? h?.[3];
  };
  // As in the lift: each link to the given file of the same name; then, when as many links match
  // no file as files match no link, they're the same stylesheets under other names, in order.
  const tags = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => isSheet(t) && urlOf(t));
  const byTag = new Map<number, string>();
  tags.forEach((t, i) => {
    const name = basename(urlOf(t)!.split(/[?#]/)[0]);
    const given = cssFiles.find((f) => basename(f) === name && ![...byTag.values()].includes(f));
    if (given) byTag.set(i, given);
  });
  const looseFiles = cssFiles.filter((f) => ![...byTag.values()].includes(f));
  const looseTags = tags.map((_, i) => i).filter((i) => !byTag.has(i));
  if (looseFiles.length && looseFiles.length === looseTags.length) looseTags.forEach((i, k) => byTag.set(i, looseFiles[k]));
  const linked = new Set<string>();
  let n = -1;
  let out = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/<link\b[^>]*>/gi, (tag) => {
      if (!isSheet(tag) || !urlOf(tag)) return tag;
      const given = byTag.get(++n);
      if (!given) return tag;
      linked.add(given);
      return tag.replace(hrefOf(tag)![0], `href="${rel(given)}"`);
    });
  const missing = cssFiles.filter((f) => !linked.has(f));
  if (missing.length) {
    const links = missing.map((f) => `<link rel="stylesheet" href="${rel(f)}">`).join("");
    out = /<head\b[^>]*>/i.test(out) ? out.replace(/<head\b[^>]*>/i, (h) => h + links) : links + out;
  }
  return out;
}

/** The deepest directory holding every one of `paths`. */
function commonDir(paths: string[]): string {
  const parts = paths.map((p) => dirname(resolve(p)).split(sep));
  const first = parts[0];
  let n = first.length;
  for (const p of parts) {
    let i = 0;
    while (i < n && p[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n).join(sep) || sep;
}

/** Verify `findings` in Chromium, setting `verified` on each; returns what was loaded and compared. */
export async function verifyFindings(opts: {
  page: string;
  /** The page with data-fixture ids on every element the engine lays out. */
  html: string;
  cssFiles: string[];
  findings: Finding[];
  layouts: Layout[];
  impacts?: WidthImpact[];
  /** At most this many widths with findings are loaded (spread over them). */
  maxWidths?: number;
  /** How to name an element in the report (default: its data-fixture id). */
  describe?: (id: string) => string;
  /** The window height (px) the page was laid out for. */
  height?: number;
  /** And this many widths without findings. */
  samples?: number;
}): Promise<VerifyReport> {
  const all = opts.layouts.map((l) => l.width);
  const describe = opts.describe ?? ((id: string) => `#${id}`);
  // A finding on a run of text beside elements (an anonymous box, no element of its own) is
  // measured on the element that holds it.
  const anonParent = new Map<string, string>();
  for (const l of opts.layouts) for (const b of walk(l.boxes)) for (const c of b.children) if (c.anonymous) anonParent.set(c.id, b.id);
  const probeFor = (f: Finding): Probe | undefined => {
    const p = probeOf(f);
    if (p?.kind === "wrap" && anonParent.has(p.id)) return { kind: "wrap", id: anonParent.get(p.id)!, textOnly: true };
    return p;
  };
  const withFindings = [...new Set(opts.findings.map((f) => f.width))].sort((a, b) => a - b);
  const checked = spread(withFindings, opts.maxWidths ?? 60);
  const sampled = spread(all.filter((w) => !withFindings.includes(w)), opts.samples ?? 6);
  const widths = [...new Set([...checked, ...sampled])].sort((a, b) => a - b);

  // Every distinct probe, measured at every loaded width (cheap, and it shows where else an issue is).
  const probes = new Map<string, Probe>();
  for (const f of opts.findings) {
    const p = probeFor(f);
    if (p) probes.set(probeKey(p), p);
  }
  const probeList = [...probes.values()];

  // Served from the directory holding the page and its stylesheets, widened to the working
  // directory when that holds them (stylesheets often load fonts from a directory above).
  const own = commonDir([opts.page, ...opts.cssFiles]);
  const cwd = process.cwd();
  const root = own === cwd || own.startsWith(cwd + sep) ? cwd : own;
  const pagePath = resolve(opts.page);
  const server = await serveFiles(root, new Map([[pagePath, pageForBrowser(opts.html, opts.page, opts.cssFiles)]]));
  const browser = await launchChromium();
  const report: VerifyReport = {
    browser: `Chromium ${browser.version()}${findChrome() ? ` (${findChrome()})` : ""}`,
    widths,
    sampled,
    boxes: { exact: 0, exactDiffer: 0, approximate: 0, approximateDiffer: 0, examples: [] },
    notes: [],
  };
  const results = new Map<number, Map<string, Verdict>>();
  try {
    const page: Page = await browser.newPage({ viewport: { width: widths[0] ?? 1280, height: opts.height ?? 800 } });
    await page.goto(server.url(pagePath));
    await settle(page);
    const failed = await page.evaluate("[...document.fonts].filter((f) => f.status === 'error').map((f) => f.family)");
    if ((failed as string[]).length) report.notes.push(`fonts that failed to load in Chromium: ${[...new Set(failed as string[])].join(", ")}`);
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: opts.height ?? 800 });
      await settle(page);
      const rects = await measureBoxes(page);
      const layout = opts.layouts.find((l) => l.width === w)!;
      const uncertain = new Set(opts.impacts?.find((i) => i.width === w)?.uncertain.map((u) => u.id));
      const errored = new Set(layout.issues.filter((i) => i.severity === "error").map((i) => i.id));
      for (const b of walk(layout.boxes)) {
        if (b.anonymous) continue;
        // (A box the engine reports an error on is approximate too, as in the coverage line.)
        const flagged = uncertain.has(b.id) || b.assumptions.length > 0 || errored.has(b.id);
        const c = rects[b.id];
        const differ = !c || rectDelta(b, c) > 0.5;
        if (flagged) (report.boxes.approximate++, differ && report.boxes.approximateDiffer++);
        else {
          report.boxes.exact++;
          if (differ) {
            report.boxes.exactDiffer++;
            if (report.boxes.examples.length < 5) report.boxes.examples.push(`${describe(b.id)} at ${w}px: engine ${fmtPx(b.w)}×${fmtPx(b.h)} at ${fmtPx(b.x)},${fmtPx(b.y)}; Chromium ${c ? `${fmtPx(c.w)}×${fmtPx(c.h)} at ${fmtPx(c.x)},${fmtPx(c.y)}` : "no box"}`);
          }
        }
      }
      const measured = (await page.evaluate(`(${PROBE_SCRIPT})(${JSON.stringify(probeList)})`)) as Measured[];
      results.set(w, new Map(probeList.map((p, i) => [probeKey(p), judge(p, measured[i])])));
    }
  } finally {
    await browser.close();
    server.close();
  }

  // Each finding: what Chromium showed at its width, if loaded there.
  const groupWidths = new Map<string, Set<number>>();
  const groupKey = (f: Finding) => [f.check, f.id, f.path ?? "", probeFor(f) ? probeKey(probeFor(f)!) : f.message].join("|");
  for (const f of opts.findings) {
    const k = groupKey(f);
    groupWidths.set(k, (groupWidths.get(k) ?? new Set()).add(f.width));
  }
  for (const f of opts.findings) {
    const p = probeFor(f);
    const r = p && results.get(f.width)?.get(probeKey(p));
    if (!p) f.verified = { status: "predicted", detail: unmeasured(f) };
    else if (!results.has(f.width)) f.verified = { status: "predicted", detail: `${f.width}px wasn't loaded in Chromium (at most ${opts.maxWidths ?? 60} widths with findings are)` };
    else if (!r) f.verified = { status: "predicted", detail: "not measured in Chromium" };
    else if ("undecided" in r) f.verified = { status: "predicted", detail: r.undecided };
    else {
      // A definite finding is confirmed only at the severity it was reported with (a 30px button
      // isn't the 20px one the engine predicted, though it is still under 44px).
      const shown = r.shown && (f.inconclusive || !r.severity || p.kind !== "tap" || r.severity === f.severity);
      f.verified = { status: shown ? "confirmed" : "not reproduced", detail: r.detail };
      if (shown && f.inconclusive) {
        // Decided by the browser: no longer inconclusive, and as severe as what Chromium shows.
        f.inconclusive = false;
        if (r.severity) f.severity = r.severity;
        f.message = f.message.replace(/ \(inconclusive: [^)]*\)/, "");
        if (/ is inconclusive: /.test(f.message)) f.message = `#${f.id} ${r.detail} in Chromium`;
      }
    }
    if (p) {
      const at = groupWidths.get(groupKey(f))!;
      const also = widths.filter((w) => {
        const v = results.get(w)?.get(probeKey(p));
        return !at.has(w) && !!v && "shown" in v && v.shown;
      });
      if (also.length) f.verified.alsoAt = also;
    }
  }
  return report;
}
