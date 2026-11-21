/**
 * What Cadesa does with a real browser, shared by `check --verify`, `capture` and the conformance
 * scripts: serve files to Chromium and measure the boxes of elements tagged `data-fixture`.
 * Callers launch Chromium with launchChromium() (metrics.ts), through playwright-core.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, relative, resolve, sep } from "node:path";

export type Page = import("playwright-core").Page;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export interface Served {
  /** The URL of a file under the root. */
  url(path: string): string;
  /** sha256 of every stylesheet served, by absolute path. */
  css: Map<string, string>;
  close(): void;
}

/**
 * Serve the files under `root` on 127.0.0.1, with some files replaced by other bytes
 * (`overrides`, by absolute path). Nothing outside `root` is served.
 */
export async function serveFiles(root: string, overrides = new Map<string, string>()): Promise<Served> {
  const base = resolve(root);
  const css = new Map<string, string>();
  const server = createServer((req, res) => {
    const path = resolve(base, "." + decodeURIComponent(new URL(req.url!, "http://x").pathname));
    const inside = path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
    if (!inside || (!overrides.has(path) && (!existsSync(path) || !statSync(path).isFile()))) return void res.writeHead(404).end();
    const body = overrides.has(path) ? Buffer.from(overrides.get(path)!) : readFileSync(path);
    if (path.endsWith(".css")) css.set(path, sha256(body));
    res.writeHead(200, { "content-type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: (p) => `http://127.0.0.1:${port}/${relative(base, resolve(p)).split(sep).map(encodeURIComponent).join("/")}`,
    css,
    close: () => server.close(),
  };
}

/**
 * Freeze the page's animations from the start, through the browser (DevTools' animation playback
 * rate 0): an animation shorter than the time the page takes to load can't end before settle()
 * pauses it at its start (under load, one did: its end state was measured). Call before loading.
 */
export async function freezeAnimations(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
}

/**
 * Wait for web fonts and images, so text and replaced elements have their final size; then seek
 * every animation to its start (t=0) and hold it there, where Cadesa predicts boxes: what is drawn
 * at load would otherwise depend on how long loading took.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate("document.fonts.ready");
  // A lazy image below the fold never loads, and its decode() never settles: it is loaded now (its
  // attribute is put back once it has), and no image is waited for longer than 10s.
  await page.evaluate(`Promise.all([...document.images].map((i) => {
    const lazy = i.getAttribute("loading");
    if (lazy !== null && !i.complete) i.loading = "eager";
    return Promise.race([i.decode().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]).then(() => {
      if (lazy !== null && i.getAttribute("loading") !== lazy) i.setAttribute("loading", lazy);
    });
  }))`);
  // Laid out again from scratch: a native select laid out before its web font loaded keeps the
  // baseline it had then (Chromium doesn't recompute it when the font arrives), so its place would
  // depend on when the font loaded. After a full relayout it is where it is when the font loads
  // first, every time (probed: 52 selects in a font loaded late, 14 of them half a pixel off
  // after document.fonts.ready, none after the relayout).
  await page.evaluate("(() => { const s = document.documentElement.style; const d = s.display; s.display = 'none'; void document.documentElement.offsetHeight; s.display = d; void document.documentElement.offsetHeight; })()");
  // (A transition a resize started, by a media query, is finished: its end is the page at that width.)
  await page.evaluate("for (const a of document.getAnimations()) if (a instanceof CSSTransition) a.finish(); else { a.pause(); a.currentTime = 0; }");
}

/** The border box of every element with a data-fixture id, in CSS px from the viewport's top left. */
export function measureBoxes(page: Page): Promise<Record<string, Rect>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("[data-fixture]")].map((el) => {
        const r = el.getBoundingClientRect();
        return [el.dataset.fixture!, { x: r.x, y: r.y, w: r.width, h: r.height }];
      }),
    ),
  );
}

/** Lines of text in each data-fixture element: its text's line boxes, counted by distinct top edge. */
export function measureLineCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(`Object.fromEntries([...document.querySelectorAll("[data-fixture]")].map((el) => {
    const tops = new Set();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const q of r.getClientRects()) if (q.width > 0) tops.add(Math.round(q.top * 4));
    }
    return [el.dataset.fixture, tops.size];
  }))`);
}

/** Largest difference in x, y, width or height between two boxes. */
export const rectDelta = (a: Rect, b: Rect) => Math.max(...(["x", "y", "w", "h"] as const).map((k) => Math.abs(a[k] - b[k])));
