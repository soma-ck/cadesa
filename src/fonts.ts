/**
 * Which fonts a page's text is set in, whether Cadesa has metrics for them, and where each font
 * comes from: an @font-face with a file, Google Fonts, or the machine (a system font). Then
 * measure what can be measured, writing metrics exactly as `cadesa metrics` does.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "parse5";
import postcss, { type AtRule } from "postcss";
import { walk, type Layout } from "./engine/layout.js";
import { clearMetricsCache, metricsFor, type MetricsInfo } from "./engine/text.js";
import { generateMetrics, launchChromium, metricsFileName, sha256, writeMetrics, type Browser, type MetricsFile } from "./metrics.js";

// ------------------------------------------------------------------ what the text uses

export interface FontUse {
  /** The first family of the stack: the one the engine measures with. */
  family: string;
  /** The whole font-family value (undefined: the browser's default font). */
  stack?: string;
  weights: number[];
  sizes: number[];
  /** Set only by a stylesheet rule that no laid-out text box uses: that stylesheet. */
  declaredIn?: string;
  /** Text boxes set in it, at any of the widths laid out. */
  boxes: string[];
}

export const firstFamily = (stack: string) => stack.split(",")[0].trim().replace(/^["']|["']$/g, "");

/** The families the page's text is set in, from laid-out boxes (every text box at every width). */
export function fontUses(layouts: Layout[]): FontUse[] {
  const out = new Map<string, FontUse>();
  for (const l of layouts)
    for (const b of walk(l.boxes)) {
      const t = b.props.text?.value;
      if (!t || !b.text?.trim()) continue;
      const family = t.font ? firstFamily(t.font) : "(browser default)";
      const key = family.toLowerCase();
      let u = out.get(key);
      if (!u) out.set(key, (u = { family, stack: t.font, weights: [], sizes: [], boxes: [] }));
      if (!u.weights.includes(t.weight)) u.weights.push(t.weight);
      if (!u.sizes.includes(t.sizePx)) u.sizes.push(t.sizePx);
      if (!u.boxes.includes(b.id)) u.boxes.push(b.id);
    }
  for (const u of out.values()) (u.weights.sort((a, b) => a - b), u.sizes.sort((a, b) => a - b));
  return [...out.values()];
}

// ------------------------------------------------------------------ where fonts come from

export interface FontFaceRule {
  family: string;
  /** "400", or a variable font's range "100 900". */
  weight: string;
  style: string;
  unicodeRange?: string;
  /** Each src url(): a local path (resolved against the stylesheet) or an absolute URL. */
  src: { url: string; format?: string; path?: string; exists?: boolean }[];
  /** The stylesheet that declares it. */
  from: string;
}

export interface GoogleLink {
  url: string;
  families: string[];
  /** The page or stylesheet that links it. */
  from: string;
}

export interface PageFontSources {
  faces: FontFaceRule[];
  google: GoogleLink[];
  /** Stylesheets read (local files). */
  stylesheets: string[];
  /** Font stacks set by the stylesheets' rules (font-family or the font shorthand), with weights. */
  declared: { stack: string; weights: number[]; from: string }[];
}

/** The family list and weight a `font` shorthand sets ("600 14px/20px Inter, sans-serif"). */
function shorthand(v: string): { stack?: string; weight?: number } {
  const m = /^\s*((?:[\w-]+\s+)*?)(\d*\.?\d+(?:px|r?em|%|pt|vw|vh)|[a-z-]+-?(?:small|large|medium))(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(v);
  if (!m) return {};
  const pre = m[1].trim().split(/\s+/);
  const w = pre.map((p) => (p === "bold" ? 700 : /^\d+$/.test(p) ? Number(p) : undefined)).find((x) => x !== undefined);
  return { stack: m[3].trim(), weight: w };
}

const GENERIC = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace",
  "ui-rounded", "math", "emoji", "fangsong", "-apple-system", "blinkmacsystemfont", "(browser default)",
]);
/** Fonts that come with an operating system, not with the page. */
const SYSTEM = new Set(
  [
    "Arial", "Helvetica", "Helvetica Neue", "Segoe UI", "Segoe UI Variable", "SF Pro", "SF Pro Text", "SF Pro Display", "San Francisco",
    "Times", "Times New Roman", "Georgia", "Verdana", "Tahoma", "Trebuchet MS", "Courier", "Courier New", "Menlo", "Monaco",
    "Consolas", "Cascadia Code", "Calibri", "Cambria", "Candara", "Lucida Grande", "Lucida Sans", "Gill Sans", "Avenir", "Avenir Next",
    "Optima", "Palatino", "Palatino Linotype", "Book Antiqua", "Garamond", "Futura", "Impact", "Comic Sans MS", "Ubuntu", "Cantarell",
    "Oxygen", "Oxygen-Sans", "Fira Sans", "Droid Sans", "Noto Sans", "Noto Serif", "Liberation Sans", "Liberation Serif", "DejaVu Sans",
    "DejaVu Serif", "DejaVu Sans Mono", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", "Roboto",
  ].map((s) => s.toLowerCase()),
);

const SYSTEM_UI = new Set(["system-ui", "ui-sans-serif", "-apple-system", "blinkmacsystemfont"]);

const isGoogleCss = (url: string) => /^(https?:)?\/\/fonts\.googleapis\.com\/css2?\b/.test(url);

/** Family names in a Google Fonts CSS URL (css2: one family= per family; css: "A:400,700|B"). */
export function googleFamilies(url: string): string[] {
  const u = new URL(url.startsWith("//") ? `https:${url}` : url);
  return u.searchParams
    .getAll("family")
    .flatMap((f) => f.split("|"))
    .map((f) => f.split(":")[0].trim())
    .filter(Boolean);
}

/**
 * The weights a Google Fonts URL asks for one family: "400", "700", or a range "100 900" (css2
 * "Name:wght@400;700", "Name:ital,wght@0,400;1,700" or "Name:wght@100..900"; css "Name:400,700").
 * Empty when it names no weights (the API then serves 400).
 */
export function googleWeights(url: string, family: string): string[] {
  const u = new URL(url.startsWith("//") ? `https:${url}` : url);
  for (const f of u.searchParams.getAll("family").flatMap((x) => x.split("|"))) {
    const [name, spec] = f.split(":");
    if (name.trim().toLowerCase() !== family.toLowerCase()) continue;
    if (!spec) return ["400"];
    const at = spec.indexOf("@");
    if (at < 0) return [...new Set(spec.split(",").map((w) => (w.match(/\d+/) ?? ["400"])[0]))];
    const axes = spec.slice(0, at).split(",");
    const wi = axes.indexOf("wght");
    if (wi < 0) return ["400"];
    const ii = axes.indexOf("ital");
    return [
      ...new Set(
        spec
          .slice(at + 1)
          .split(";")
          .map((t) => t.split(","))
          .filter((t) => ii < 0 || t[ii] === "0")
          .map((t) => t[wi].replace("..", " ")),
      ),
    ];
  }
  return [];
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

/** A CSS font-weight descriptor as Cadesa writes it: "400", or "100 900" for a range. */
function weightOf(v: string | undefined): string {
  const named: Record<string, string> = { normal: "400", bold: "700" };
  const parts = (v ?? "400").trim().split(/\s+/).map((p) => named[p] ?? p);
  return parts.length > 1 && parts[0] !== parts[1] ? `${parts[0]} ${parts[1]}` : parts[0];
}

/** Whether a unicode-range covers the Latin letters (a face without one covers everything). */
function coversLatin(range: string | undefined): boolean {
  if (!range) return true;
  return range.split(",").some((r) => {
    const m = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(r.trim());
    if (!m) return false;
    const lo = parseInt(m[1].replace(/\?/g, "0"), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, "f"), 16);
    return lo <= 0x41 && hi >= 0x7a;
  });
}

/** Split a src descriptor into its url() entries (local() entries are left out). */
function srcList(value: string, base: string): FontFaceRule["src"] {
  const out: FontFaceRule["src"] = [];
  for (const m of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/g)) {
    const url = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!url || url.startsWith("data:")) continue;
    const remote = /^(https?:)?\/\//.test(url);
    const path = remote ? undefined : resolve(base, decodeURIComponent(url.split(/[?#]/)[0]));
    out.push({ url, ...(m[4] && { format: m[4] }), ...(path && { path, exists: existsSync(path) }) });
  }
  return out;
}

/**
 * Read a page's stylesheets (the given CSS, linked local stylesheets, <style> blocks and their
 * @imports) for @font-face rules and Google Fonts links.
 */
export function pageFontSources(page: string, extraCss: string[] = []): PageFontSources {
  const out: PageFontSources = { faces: [], google: [], stylesheets: [], declared: [] };
  const seen = new Set<string>();
  const readCss = (css: string, base: string, from: string) => {
    let root;
    try {
      root = postcss.parse(css);
    } catch {
      return;
    }
    root.walkAtRules((a: AtRule) => {
      if (a.name === "import") {
        const m = /^(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?/.exec(a.params.trim());
        if (!m) return;
        if (isGoogleCss(m[1])) out.google.push({ url: m[1], families: googleFamilies(m[1]), from });
        else if (!/^(https?:)?\/\//.test(m[1])) sheet(resolve(base, m[1]));
      } else if (a.name === "font-face") {
        const d = new Map<string, string>();
        a.walkDecls((x) => void d.set(x.prop.toLowerCase(), x.value));
        const family = d.get("font-family");
        if (!family || !d.get("src")) return;
        out.faces.push({
          family: unquote(family),
          weight: weightOf(d.get("font-weight")),
          style: (d.get("font-style") ?? "normal").trim(),
          ...(d.get("unicode-range") && { unicodeRange: d.get("unicode-range") }),
          src: srcList(d.get("src")!, base),
          from,
        });
      }
    });
    root.walkRules((r) => {
      if (r.parent?.type === "atrule" && (r.parent as AtRule).name === "font-face") return;
      let stack: string | undefined;
      let weight: number | undefined;
      r.each((d) => {
        if (d.type !== "decl") return;
        const prop = d.prop.toLowerCase();
        if (prop === "font-family") stack = d.value;
        else if (prop === "font") ({ stack = stack, weight = weight } = shorthand(d.value));
        else if (prop === "font-weight") weight = d.value === "bold" ? 700 : /^\d+$/.test(d.value.trim()) ? Number(d.value) : weight;
      });
      // Values from custom properties (Tailwind's theme) aren't resolved here.
      if (!stack || stack.includes("var(") || /^(inherit|initial|unset|revert)$/.test(stack.trim())) return;
      const prev = out.declared.find((x) => x.stack === stack);
      const w = weight ?? 400;
      if (prev) prev.weights.includes(w) || prev.weights.push(w);
      else out.declared.push({ stack, weights: [w], from });
    });
  };
  const sheet = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    out.stylesheets.push(file);
    readCss(readFileSync(file, "utf8"), dirname(file), file);
  };
  for (const css of extraCss) sheet(resolve(css));
  const html = readFileSync(page, "utf8");
  const doc = parse(html) as unknown as P5;
  const visit = (n: P5) => {
    if (n.tagName === "link") {
      const href = n.attrs?.find((a) => a.name === "href")?.value ?? "";
      const rel = n.attrs?.find((a) => a.name === "rel")?.value ?? "";
      if (isGoogleCss(href)) out.google.push({ url: href, families: googleFamilies(href), from: page });
      else if (/\bstylesheet\b/.test(rel) && href && !/^(https?:)?\/\//.test(href)) sheet(resolve(dirname(page), href.split(/[?#]/)[0]));
    }
    if (n.tagName === "style") readCss((n.childNodes ?? []).map((c) => c.value ?? "").join(""), dirname(page), page);
    for (const c of n.childNodes ?? []) visit(c);
    if (n.content) visit(n.content);
  };
  visit(doc);
  return out;
}

interface P5 {
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5[];
  content?: P5;
}

// ------------------------------------------------------------------ the report

export type FontStatus =
  /** Cadesa has metrics for it. */
  | "measured"
  /** The page declares it with @font-face: measurable from the file. */
  | "file"
  /** The page loads it from Google Fonts: measurable by downloading the same files. */
  | "google"
  /** A font of the operating system (or a generic family): it differs by machine. */
  | "system"
  /** Not declared by the page and not a known system font. */
  | "unknown";

export interface FontReport extends FontUse {
  status: FontStatus;
  metrics?: MetricsInfo & { file: string };
  /** For a measured font the page also declares: whether the page's files are the ones measured. */
  sameFiles?: boolean;
  /** For a measured font: why its table may not fit what the page loads (--measure measures that). */
  remeasure?: string;
  faces: FontFaceRule[];
  google?: GoogleLink;
  note?: string;
}

export function fontReport(uses: FontUse[], sources: PageFontSources): FontReport[] {
  // Stacks the stylesheets set that no laid-out text box uses (its rule may not have been lifted).
  const extra: FontUse[] = [];
  for (const d of sources.declared) {
    const family = firstFamily(d.stack);
    if (!family || [...uses, ...extra].some((u) => u.family.toLowerCase() === family.toLowerCase())) continue;
    extra.push({ family, stack: d.stack, weights: [...d.weights].sort((a, b) => a - b), sizes: [], boxes: [], declaredIn: d.from });
  }
  return [...uses, ...extra].map((u) => {
    const key = u.family.toLowerCase();
    const faces = sources.faces.filter((f) => f.family.toLowerCase() === key);
    const google = sources.google.find((g) => g.families.some((f) => f.toLowerCase() === key));
    const m = u.stack ? metricsFor(u.stack) : undefined;
    const base = { ...u, faces, ...(google && { google }) };
    if (m) {
      const r: FontReport = { ...base, status: "measured", metrics: { ...m.info, file: m.file } };
      const local = faces.flatMap((f) => f.src.filter((s) => s.exists).map((s) => sha256(readFileSync(s.path!))));
      const measured = new Set((m.info.files ?? []).map((f) => f.sha256).filter(Boolean));
      if (local.length && measured.size) r.sameFiles = local.some((h) => measured.has(h));
      if (r.sameFiles === false) r.remeasure = "the page's font files differ from the ones measured";
      // A variable table, while the page declares single weights: the browser uses the nearest
      // declared weight, not the one asked for.
      const declared = faces.length ? faces.filter((f) => f.style === "normal").map((f) => f.weight) : google ? googleWeights(google.url, u.family) : [];
      if (!r.remeasure && m.info.kind === "variable" && declared.length && declared.every((w) => !w.includes(" ")) && u.weights.some((w) => !declared.includes(String(w))))
        r.remeasure = `the page declares only weights ${declared.join(", ")} (text at ${u.weights.filter((w) => !declared.includes(String(w))).join(", ")} uses the nearest of them), but the table is variable`;
      if (r.remeasure) r.note = `${r.remeasure}: --measure measures what the page loads`;
      else if (m.info.bundled && !faces.length && !google)
        r.note = "the page doesn't load this font (no @font-face or Google Fonts link in the files given): the browser uses it only where it is installed, and the bundled metrics fit the Google Fonts files";
      if (m.info.machineSpecific) r.note = m.info.machineSpecific;
      return r;
    }
    if (faces.some((f) => f.src.length)) return { ...base, status: "file" };
    if (google) return { ...base, status: "google" };
    if (GENERIC.has(key) || SYSTEM.has(key))
      return {
        ...base,
        status: "system",
        note:
          key === "(browser default)"
            ? "no font-family is set: the browser's default font differs by machine"
            : SYSTEM_UI.has(key)
              ? "the operating system's UI font (San Francisco on macOS, Segoe UI on Windows, Cantarell, Ubuntu or DejaVu Sans on Linux): it differs by machine"
              : GENERIC.has(key)
                ? "a generic family: the browser picks an installed font, which differs by machine"
                : "a system font: it comes with the operating system, so whether it is there, and which version, differs by machine",
      };
    return {
      ...base,
      status: "unknown",
      note: `the page doesn't load it (no @font-face or Google Fonts link in the files given), so the browser uses it only where it is installed; if the page loads it from Google Fonts some other way: cadesa metrics --google "${u.family}"`,
    };
  });
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : w.endsWith("x") ? "es" : "s"}`;
const rel = (p: string) => {
  const r = p.startsWith(process.cwd() + "/") ? p.slice(process.cwd().length + 1) : p;
  return r;
};

/** One line on where a font's metrics came from. */
export function describeMetrics(m: MetricsInfo & { file: string }): string {
  const files = m.files?.map((f) => f.file) ?? [];
  const what = m.bundled ? "bundled with Cadesa" : rel(m.file);
  return `${what}, measured from ${files.length ? [...new Set(files)].join(", ") : m.source}${m.machineSpecific ? " (this machine's installed font)" : ""}`;
}

export function formatFonts(page: string, report: FontReport[], hint?: string): string {
  if (!report.length) return `no text in ${page}\n`;
  const out = [`fonts the text in ${page} is set in:`];
  for (const r of report) {
    const head = `  ${r.family} · ${r.weights.join(", ")} · ${r.boxes.length ? plural(r.boxes.length, "text box") : `set in ${rel(r.declaredIn ?? "the CSS")}, but no laid-out text box uses it`}`;
    if (r.status === "measured") out.push(`${head}\n    ✓ metrics: ${describeMetrics(r.metrics!)}`);
    else if (r.status === "file") {
      const faces = r.faces.filter((f) => f.src.length);
      out.push(`${head}\n    ✗ no metrics · @font-face in ${[...new Set(faces.map((f) => rel(f.from)))].join(", ")}:`);
      for (const f of faces) {
        const s = f.src[0];
        out.push(`      ${f.weight}${f.style !== "normal" ? ` ${f.style}` : ""}: ${s.path ? `${rel(s.path)}${s.exists ? "" : " (file not found)"}` : s.url}`);
      }
    } else if (r.status === "google") out.push(`${head}\n    ✗ no metrics · Google Fonts, linked from ${rel(r.google!.from)}`);
    else if (r.status === "system") out.push(`${head}\n    ✗ no metrics · ${r.note}`);
    else out.push(`${head}\n    ✗ no metrics · ${r.note}`);
    if (r.status === "measured" && r.note) out.push(`    ! ${r.note}`);
    if (r.sameFiles) out.push("    ✓ the page's @font-face file is the one measured (same sha256)");
    if (r.stack && r.stack.includes(",") && r.status !== "measured") out.push(`    stack: ${r.stack}`);
  }
  const missing = report.filter((r) => r.status !== "measured");
  if (missing.length) {
    const boxes = new Set(missing.flatMap((r) => r.boxes)).size;
    if (boxes) out.push("", `${plural(boxes, "text box")} can't be measured: ${boxes === 1 ? "it is" : "they are"} assumed to be one line, and flagged.`);
    if (hint) out.push(hint);
  } else {
    const machine = report.filter((r) => r.metrics?.machineSpecific).length;
    out.push("", `✓ every font the text uses has metrics${machine ? ` (${machine} measured from this machine's installed fonts: valid on this machine only)` : ""}`);
    if (hint && report.some((r) => r.remeasure)) out.push(hint);
  }
  return out.join("\n") + "\n";
}

// ------------------------------------------------------------------ measuring

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function fetchOk(url: string, what: string): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(url, { headers: { "user-agent": UA } });
  } catch (e) {
    throw new Error(`couldn't fetch ${what} (${url}): ${(e as Error).message}`);
  }
  if (!r.ok) throw new Error(`couldn't fetch ${what} (${url}): HTTP ${r.status}`);
  return r;
}

/** @font-face rules of a Google Fonts stylesheet (fetched with a browser's User-Agent, so the files are woff2). */
export async function googleFaces(cssUrl: string): Promise<FontFaceRule[]> {
  const url = cssUrl.startsWith("//") ? `https:${cssUrl}` : cssUrl;
  const css = await (await fetchOk(url, "the Google Fonts stylesheet")).text();
  const faces: FontFaceRule[] = [];
  postcss.parse(css).walkAtRules("font-face", (a) => {
    const d = new Map<string, string>();
    a.walkDecls((x) => void d.set(x.prop.toLowerCase(), x.value));
    faces.push({
      family: unquote(d.get("font-family") ?? ""),
      weight: weightOf(d.get("font-weight")),
      style: (d.get("font-style") ?? "normal").trim(),
      ...(d.get("unicode-range") && { unicodeRange: d.get("unicode-range") }),
      src: srcList(d.get("src") ?? "", process.cwd()).map((s) => ({ url: s.url, ...(s.format && { format: s.format }) })),
      from: url,
    });
  });
  return faces;
}

/** Whether a Google Fonts css2 request answers (the API rejects a weight or range a family doesn't have). */
async function googleOk(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { headers: { "user-agent": UA } })).ok;
  } catch (e) {
    throw new Error(`couldn't reach fonts.googleapis.com: ${(e as Error).message}`);
  }
}

/**
 * The Google Fonts stylesheet for a family by name: its variable wght axis when it has one,
 * otherwise its static weights (those in `weights` when given).
 */
export async function googleCssFor(family: string, weights?: number[]): Promise<string> {
  const base = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}`;
  const probe = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  const ok = await Promise.all(probe.map((w) => googleOk(`${base}:wght@${w}`)));
  const available = probe.filter((_, i) => ok[i]);
  if (!available.length) {
    if (await googleOk(base)) return base;
    throw new Error(`Google Fonts has no family named "${family}" (names are case-sensitive, e.g. "Open Sans")`);
  }
  // A variable font answers a range; static weights answer only one at a time.
  const [lo, hi] = [available[0], available[available.length - 1]];
  if (available.length > 1 && (await googleOk(`${base}:wght@${lo}..${hi}`))) return `${base}:wght@${lo}..${hi}`;
  const want = weights?.length ? available.filter((w) => weights.includes(w)) : available;
  const use = want.length ? want : available;
  return `${base}:wght@${use.join(";")}`;
}

/** The faces to measure for a family: normal style, Latin subset, one per weight (variable first). */
function facesToMeasure(faces: FontFaceRule[], family: string): FontFaceRule[] {
  const own = faces.filter((f) => f.family.toLowerCase() === family.toLowerCase() && f.style === "normal" && coversLatin(f.unicodeRange) && f.src.length);
  const variable = own.find((f) => f.weight.includes(" "));
  if (variable) return [variable];
  const byWeight = new Map<string, FontFaceRule>();
  for (const f of own) if (!byWeight.has(f.weight)) byWeight.set(f.weight, f);
  return [...byWeight.values()];
}

const FONT_EXT = /\.(woff2|woff|ttf|otf)$/i;
const FORMAT_EXT: Record<string, string> = { woff2: ".woff2", woff: ".woff", truetype: ".ttf", opentype: ".otf" };

/** A face's font file on disk: the local file, or a download kept in `.cadesa/fonts/<family>/`. */
async function fileFor(f: FontFaceRule, cacheDir: string): Promise<{ path: string; url?: string }> {
  const local = f.src.find((s) => s.path && s.exists && FONT_EXT.test(s.path));
  if (local) return { path: local.path! };
  const missing = f.src.find((s) => s.path && !s.exists);
  const remote = f.src.find((s) => !s.path && (FONT_EXT.test(s.url.split(/[?#]/)[0]) || (s.format && FORMAT_EXT[s.format])));
  if (!remote) throw new Error(missing ? `font file not found: ${missing.path}` : `no usable src in the @font-face for "${f.family}" ${f.weight}`);
  const url = remote.url.startsWith("//") ? `https:${remote.url}` : remote.url;
  const name = basename(new URL(url).pathname);
  const file = join(cacheDir, metricsFileName(f.family).replace(/\.metrics\.json$/, ""), FONT_EXT.test(name) ? name : `${name}${FORMAT_EXT[remote.format!] ?? ""}`);
  if (!existsSync(file)) {
    const bytes = Buffer.from(await (await fetchOk(url, `the font file for "${f.family}" ${f.weight}`)).arrayBuffer());
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  return { path: file, url };
}

export interface Measured {
  family: string;
  /** "file", "google" or "system": how it was measured. */
  via: "file" | "google" | "system";
  metrics?: string;
  faces: { weight: string; file: string; url?: string; sha256?: string }[];
  error?: string;
  warning?: string;
}

/** Measure faces of one family and write them into `out` (static faces merge into one file). */
export async function measureFaces(
  family: string,
  faces: FontFaceRule[],
  opts: { out: string; cacheDir: string; browser: Browser; via: Measured["via"] },
): Promise<Measured> {
  const result: Measured = { family, via: opts.via, faces: [] };
  const todo = facesToMeasure(faces, family);
  if (!todo.length) return { ...result, error: `no normal-style face of "${family}" covering Latin text` };
  let file: string | undefined;
  for (const f of todo) {
    const { path, url } = await fileFor(f, opts.cacheDir);
    const variable = f.weight.includes(" ");
    const m: MetricsFile = await generateMetrics({ font: path, family, weight: variable ? undefined : Number(f.weight), url, browser: opts.browser });
    file = writeMetrics(m, opts.out);
    result.faces.push({ weight: f.weight, file: rel(path), ...(url && { url }), ...(m.files?.[0].sha256 && { sha256: m.files[0].sha256 }) });
  }
  return { ...result, metrics: file && rel(file) };
}

/**
 * Measure the font installed on this machine under `family` (machine-specific). With `stack`,
 * the first of its families this machine has, as the browser would pick it.
 */
export async function measureSystem(family: string, weights: number[], opts: { out: string; browser: Browser; stack?: string }): Promise<Measured> {
  const m = await generateMetrics({ family, system: { weights, stack: opts.stack }, browser: opts.browser });
  const file = writeMetrics(m, opts.out);
  return {
    family,
    via: "system",
    metrics: rel(file),
    faces: [{ weight: weights.join(", "), file: m.source }],
    warning: m.machineSpecific,
  };
}

/** Measure a Google font by name (variable wght axis when it has one, else static weights). */
export async function measureGoogle(family: string, opts: { out: string; cacheDir: string; browser: Browser; weights?: number[] }): Promise<Measured> {
  const css = await googleCssFor(family, opts.weights);
  const faces = await googleFaces(css);
  const name = faces.find((f) => f.family.toLowerCase() === family.toLowerCase())?.family ?? family;
  return measureFaces(name, faces, { ...opts, via: "google" });
}

export interface MeasureOptions {
  /** Where metrics are written (default .cadesa/metrics). */
  out?: string;
  /**
   * Also measure system fonts, and fonts the page doesn't load, as this machine's browser resolves
   * their font-family list (machine-specific metrics).
   */
  system?: boolean;
  /** A browser to reuse. */
  browser?: Browser;
}

/** Measure every font in the report that can be measured. */
export async function measureReport(report: FontReport[], opts: MeasureOptions = {}): Promise<Measured[]> {
  const out = opts.out ?? join(".cadesa", "metrics");
  const cacheDir = join(dirname(resolve(out)), "fonts");
  const todo = report.filter(
    (r) => r.status === "file" || r.status === "google" || (r.status === "measured" && !!r.remeasure) || ((r.status === "system" || r.status === "unknown") && opts.system && !!r.stack),
  );
  const done: Measured[] = [];
  // A measured font the page loads from Google Fonts: measured again when the page's link now
  // serves other files than those measured (Google updates fonts; bundled tables age).
  for (const r of report.filter((r) => r.status === "measured" && r.google && !r.faces.length && !r.remeasure && !r.metrics?.machineSpecific)) {
    try {
      const urls = facesToMeasure(await googleFaces(r.google!.url), r.family).flatMap((f) => f.src.map((s) => s.url));
      const measured = new Set((r.metrics!.files ?? []).map((f) => f.url));
      if (urls.length && !urls.every((u) => measured.has(u))) todo.push({ ...r, status: "google" });
    } catch (e) {
      done.push({ family: r.family, via: "google", faces: [], error: (e as Error).message.split("\n")[0] });
    }
  }
  if (!todo.length) return done;
  const browser = opts.browser ?? (await launchChromium());
  try {
    for (const r of todo) {
      try {
        if (r.status === "file" || (r.status === "measured" && r.faces.length)) done.push(await measureFaces(r.family, r.faces, { out, cacheDir, browser, via: "file" }));
        else if (r.status === "google" || (r.status === "measured" && r.google)) done.push(await measureFaces(r.family, await googleFaces(r.google!.url), { out, cacheDir, browser, via: "google" }));
        else done.push(await measureSystem(r.family, [...new Set([400, 700, ...r.weights])].sort((a, b) => a - b), { out, browser, stack: r.stack }));
      } catch (e) {
        done.push({ family: r.family, via: r.status === "system" || r.status === "unknown" ? "system" : r.status === "google" ? "google" : "file", faces: [], error: (e as Error).message.split("\n")[0] });
      }
    }
  } finally {
    if (!opts.browser) await browser.close();
  }
  clearMetricsCache();
  return done;
}

export function formatMeasured(done: Measured[]): string {
  if (!done.length) return "";
  const out = ["measured:"];
  for (const d of done) {
    if (d.error) {
      out.push(`  ✖ ${d.family}: ${d.error}`);
      continue;
    }
    out.push(`  ✓ ${d.family} → ${d.metrics}`);
    for (const f of d.faces) out.push(`      ${f.weight}: ${f.url ?? f.file}${f.sha256 ? ` (sha256 ${f.sha256.slice(0, 12)})` : ""}`);
    if (d.warning) out.push(`    ! ${d.warning}`);
  }
  return out.join("\n") + "\n";
}
