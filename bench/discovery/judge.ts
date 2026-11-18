/**
 * The judge: measures a page in Chromium (never with Cadesa's engine) across a dense width sweep
 * and lists every latent defect, plus each box's geometry relative to its page section so that
 * collateral changes can be found by comparing with the starting state.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, resolve } from "node:path";
import type { Browser } from "playwright";

/** Every 20px from 320 to 1440, plus 1024 (a breakpoint the fourth-plan request names): 58 widths. */
export const SWEEP = [...Array.from({ length: 57 }, (_, i) => 320 + 20 * i), 1024].sort((a, b) => a - b);

export type Kind =
  | "overflow" // a box past its parent's box or past the viewport, or the page scrolls sideways
  | "text-overflow-x" // text wider than its box (an unbreakable word)
  | "text-overflow-y" // text taller than its box (a fixed height)
  | "tap-24" // link/button smaller than 24px in either dimension (WCAG 2.5.8)
  | "tap-44" // smaller than 44px (WCAG 2.5.5); counted separately, includes tap-24 ones
  | "long-line" // a rendered line with more than 80 characters
  | "overlap" // two sibling boxes overlap
  | "tiny-text" // text under 12px
  | "hidden"; // an element that was visible at the start now has no box

export const KINDS: Kind[] = ["overflow", "text-overflow-x", "text-overflow-y", "tap-24", "tap-44", "long-line", "overlap", "tiny-text", "hidden"];

export interface Defect {
  kind: Kind;
  id: string;
  detail: string;
}

export interface Geo {
  /** Section (top-level data-fixture element under <body>). */
  s: string;
  /** Box relative to its section's top-left, in px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Computed font-size. */
  fs: number;
  visible: boolean;
}

export interface Snapshot {
  width: number;
  defects: Defect[];
  geo: Record<string, Geo>;
}

// Runs in the page. Kept as a string so the bundler doesn't inject helpers.
const MEASURE = String.raw`(() => {
  const W = window.innerWidth;
  const els = [...document.querySelectorAll("[data-fixture]")];
  const defects = [];
  const add = (kind, id, detail) => defects.push({ kind, id, detail });
  const r1 = (n) => Math.round(n * 10) / 10;
  const visible = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.01 && r.width > 0.5 && r.height > 0.5;
  };
  const directText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
  const sectionOf = (el) => { let e = el; while (e.parentElement && e.parentElement !== document.body) e = e.parentElement; return e; };

  const doc = document.documentElement;
  if (doc.scrollWidth > W + 0.5) add("overflow", "(page)", "page scrolls sideways: " + doc.scrollWidth + "px wide at " + W + "px");

  const geo = {};
  for (const el of els) {
    const id = el.dataset.fixture;
    const r = el.getBoundingClientRect();
    const sec = sectionOf(el);
    const sr = sec.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const vis = visible(el);
    geo[id] = { s: sec.dataset.fixture || "?", x: r.x - sr.x, y: r.y - sr.y, w: r.width, h: r.height, fs: parseFloat(cs.fontSize), visible: vis };
    if (!vis) continue;

    // Box past the viewport or past its parent's border box.
    if (r.right > W + 0.5 || r.left < -0.5) add("overflow", id, "box spans " + r1(r.left) + "–" + r1(r.right) + "px, viewport " + W + "px");
    else {
      const p = el.parentElement;
      if (p && p !== document.body) {
        const pr = p.getBoundingClientRect();
        if (r.right > pr.right + 0.5 || r.left < pr.left - 0.5)
          add("overflow", id, "sticks out of #" + (p.dataset.fixture || p.tagName.toLowerCase()) + " by " + r1(Math.max(r.right - pr.right, pr.left - r.left)) + "px");
      }
    }

    const texts = directText(el);
    if (texts.length) {
      // Text wider than the box's content area (an unbreakable word), or more lines than a fixed
      // height holds. Measured from the browser's own line boxes.
      const bl = parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const br = parseFloat(cs.borderRightWidth) + parseFloat(cs.paddingRight);
      const bt = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
      const bb = parseFloat(cs.borderBottomWidth) + parseFloat(cs.paddingBottom);
      const cl = r.left + bl, cr = r.right - br;
      let minL = Infinity, maxR = -Infinity;
      const tops = new Set();
      for (const t of texts) {
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const q of range.getClientRects()) {
          if (q.width < 0.01) continue;
          minL = Math.min(minL, q.left); maxR = Math.max(maxR, q.right);
          tops.add(Math.round(q.top));
        }
      }
      const past = Math.max(maxR - cr, cl - minL);
      if (past > 0.5) add("text-overflow-x", id, "text runs " + r1(past) + "px past its box (" + r1(r.width) + "px wide)");
      const lh = parseFloat(cs.lineHeight);
      const avail = r.height - bt - bb;
      if (!isNaN(lh) && tops.size * lh > avail + 1) add("text-overflow-y", id, tops.size + " lines of " + r1(lh) + "px don't fit in " + r1(avail) + "px of height");
      if (parseFloat(cs.fontSize) < 11.99) add("tiny-text", id, "font-size " + cs.fontSize);
      // Characters per rendered line.
      const lines = new Map();
      for (const t of texts) {
        const re = /\S+/g; let m;
        while ((m = re.exec(t.textContent))) {
          const range = document.createRange();
          range.setStart(t, m.index); range.setEnd(t, m.index + m[0].length);
          const q = range.getClientRects()[0];
          if (!q) continue;
          const key = Math.round(q.top);
          const prev = lines.get(key);
          lines.set(key, prev === undefined ? m[0].length : prev + 1 + m[0].length);
        }
      }
      const longest = Math.max(0, ...lines.values());
      if (longest > 80) add("long-line", id, "a line has " + longest + " characters");
    }

    if (el.matches("a, button")) {
      const m = Math.min(r.width, r.height);
      if (m < 24) add("tap-24", id, "target " + r1(r.width) + "×" + r1(r.height) + "px");
      if (m < 44) add("tap-44", id, "target " + r1(r.width) + "×" + r1(r.height) + "px");
    }
  }

  // Overlapping siblings (children of the same parent), except deliberate stacking in one grid cell.
  for (const p of new Set(els.map((e) => e.parentElement))) {
    const kids = [...p.children].filter((k) => k.dataset.fixture && visible(k));
    for (let i = 0; i < kids.length; i++)
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i], b = kids[j];
        const ca = getComputedStyle(a), cb = getComputedStyle(b);
        if (ca.gridRowStart !== "auto" && ca.gridRowStart === cb.gridRowStart && ca.gridColumnStart === cb.gridColumnStart) continue;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ox > 1 && oy > 1) add("overlap", a.dataset.fixture + "+" + b.dataset.fixture, "overlap " + r1(ox) + "×" + r1(oy) + "px");
      }
  }
  return { defects, geo };
})()`;

export function serve(dir: string): Promise<{ server: Server; port: number }> {
  const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
  const server = createServer((req, res) => {
    const p = resolve(dir, "." + decodeURIComponent(new URL(req.url!, "http://x").pathname));
    if (!p.startsWith(dir) || !existsSync(p)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(p));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as { port: number }).port })));
}

/** Measure `page.html` served from `dir` at every width. */
export async function sweep(browser: Browser, dir: string, widths = SWEEP): Promise<Snapshot[]> {
  const { server, port } = await serve(dir);
  const ctx = await browser.newContext({ viewport: { width: widths[0], height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/page.html`);
  await page.evaluate("document.fonts.ready");
  const out: Snapshot[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const { defects, geo } = (await page.evaluate(MEASURE)) as { defects: Defect[]; geo: Record<string, Geo> };
    out.push({ width, defects, geo });
  }
  await ctx.close();
  server.close();
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;

/** Elements visible at the start that have no box now. */
export function hidden(start: Snapshot[], now: Snapshot[]): Defect[] {
  const out: Defect[] = [];
  for (let i = 0; i < now.length; i++)
    for (const [id, g] of Object.entries(start[i].geo))
      if (g.visible && !now[i].geo[id]?.visible) out.push({ kind: "hidden", id, detail: "visible at the start, hidden now" });
  return out;
}

export interface DefectSummary {
  /** Distinct (kind, element) pairs, over all widths. */
  distinct: number;
  /** (kind, element, width) instances. */
  instances: number;
  byKind: Partial<Record<Kind, number>>;
  /** kind:id → widths where it occurs. */
  where: Record<string, number[]>;
}

export function summarize(snaps: Snapshot[], extra: Map<number, Defect[]> = new Map()): DefectSummary {
  const where: Record<string, number[]> = {};
  for (const s of snaps)
    for (const d of [...s.defects, ...(extra.get(s.width) ?? [])]) {
      const key = `${d.kind}:${d.id}`;
      (where[key] ??= []).includes(s.width) || where[key].push(s.width);
    }
  const byKind: Partial<Record<Kind, number>> = {};
  for (const key of Object.keys(where)) {
    const k = key.slice(0, key.indexOf(":")) as Kind;
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  return { distinct: Object.keys(where).length, instances: Object.values(where).reduce((n, ws) => n + ws.length, 0), byKind, where };
}

/** Defects "shipped": everything except tap-44, which is reported separately (AAA, advisory). */
export const SHIPPED = (s: DefectSummary) => s.distinct - (s.byKind["tap-44"] ?? 0);

export interface Collateral {
  /** Sections the request didn't need to touch that changed at some width. */
  sections: string[];
  /** Distinct elements in those sections that moved or resized. */
  elements: number;
  /** (section, width) pairs with a change. */
  instances: number;
  examples: string[];
}

/** Boxes in `untouched` sections that moved or resized (relative to their section) vs. the start. */
export function collateral(start: Snapshot[], now: Snapshot[], untouched: string[]): Collateral {
  const sections = new Set<string>();
  const elements = new Set<string>();
  const examples: string[] = [];
  let instances = 0;
  for (let i = 0; i < start.length; i++) {
    const hit = new Set<string>();
    for (const [id, a] of Object.entries(start[i].geo)) {
      if (!untouched.includes(a.s)) continue;
      const b = now[i].geo[id];
      if (b && near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h)) continue;
      sections.add(a.s);
      elements.add(id);
      hit.add(a.s);
      if (examples.length < 6)
        examples.push(`${start[i].width}px #${id} ${b ? `${a.w.toFixed(1)}×${a.h.toFixed(1)}@${a.x.toFixed(1)},${a.y.toFixed(1)} → ${b.w.toFixed(1)}×${b.h.toFixed(1)}@${b.x.toFixed(1)},${b.y.toFixed(1)}` : "missing"}`);
    }
    instances += hit.size;
  }
  return { sections: [...sections].sort(), elements: elements.size, instances, examples };
}

/** Sections (top-level fixtures) in a snapshot. */
export const sectionsOf = (s: Snapshot) => [...new Set(Object.values(s.geo).map((g) => g.s))];
