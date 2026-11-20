/**
 * `cadesa capture <url>`: load a page in Chromium (after an optional login script), and save what
 * it rendered so `cadesa check` can read it: the DOM as page.html (scripts removed), every
 * stylesheet in cascade order (linked, @import-ed, <style> blocks and CSS-in-JS rules inserted
 * through the CSSOM) and the font files the page loaded. Cookies, storage and form values are
 * not written.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import postcss from "postcss";
import { settle, type Page } from "./browser.js";
import { RunError } from "./diagnostics.js";
import { launchChromium } from "./metrics.js";

/** One --before step: "click: text=Full log", "fill: #q = shoes", "press: Escape", "wait: .modal.show" or "wait: 500". */
export async function runStep(page: Page, step: string, timeout: number): Promise<void> {
  const m = /^\s*(click|hover|fill|press|wait)\s*:\s*(.+?)\s*$/i.exec(step);
  if (!m) throw new RunError(`--before "${step}": expected click: <selector>, hover: <selector>, fill: <selector> = <text>, press: <key> or wait: <selector or ms>`);
  const [, verb, arg] = m;
  try {
    switch (verb.toLowerCase()) {
      case "click":
        return await page.locator(arg).first().click({ timeout });
      case "hover":
        return await page.locator(arg).first().hover({ timeout });
      case "fill": {
        // "<selector> = <text>": the first " = " (a selector may contain "=" itself: [name=q]).
        const sp = arg.indexOf(" = ");
        if (sp < 0) throw new RunError(`--before "${step}": fill needs <selector> = <text>`);
        return await page.locator(arg.slice(0, sp).trim()).first().fill(arg.slice(sp + 3), { timeout });
      }
      case "press":
        return await page.keyboard.press(arg);
      case "wait":
        if (/^\d+$/.test(arg)) return await page.waitForTimeout(Number(arg));
        await page.locator(arg).first().waitFor({ state: "visible", timeout });
        return;
    }
  } catch (e) {
    if (e instanceof RunError) throw e;
    throw new RunError(`--before "${step}" failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

export interface CaptureOptions {
  url: string;
  /** Directory to write into (created). */
  out: string;
  /** A module whose default export is `async (page) => {}`, run before loading `url` (to log in). */
  loginScript?: string;
  /** A CSS selector to wait for after loading (the app has rendered). */
  wait?: string;
  /**
   * Steps to run after the page has rendered and before it is saved, to capture a state the page
   * only reaches through interaction: "click: <selector>", "hover: <selector>", "fill: <selector> = <text>",
   * "press: <key>", "wait: <selector>" or "wait: <ms>". Selectors are Playwright's (`text=Full log`, CSS, `role=button[name="Save"]`).
   */
  before?: string[];
  /** Viewport width to load the page at (default 1280). */
  width?: number;
  /** Milliseconds to wait for the page and the selector (default 30000). */
  timeout?: number;
}

export interface CapturedSheet {
  /** Written to, relative to the output directory. */
  file: string;
  /** Where it came from: its URL, or "<style> 3" / "adopted 1" for sheets without one. */
  from: string;
  /** network: the bytes the server sent; text: a <style> element's text; cssom: rules read back from the browser. */
  via: "network" | "text" | "cssom";
  rules: number;
}

export interface CaptureResult {
  url: string;
  out: string;
  page: string;
  stylesheets: CapturedSheet[];
  fonts: { file: string; from: string }[];
  notes: string[];
  /** The check command to run on what was written. */
  command: string;
}

/** What the page reports about one stylesheet, in cascade order. */
interface SheetInfo {
  href: string | null;
  base: string;
  owner: "link" | "style" | "import" | "adopted";
  index: number;
  media: string;
  disabled: boolean;
  text: string | null;
  cssom: string | null;
  /** The style element's text parses to as many rules as the sheet has (no rules were inserted by script). */
  textMatches: boolean;
}

/** Runs in the page: every stylesheet in cascade order (imports before the sheet that imports them). */
const SHEETS_SCRIPT = `(() => {
  const out = [];
  let styles = 0, adopted = 0;
  const rulesOf = (sheet) => { try { return [...sheet.cssRules]; } catch { return null; } };
  const visit = (sheet, owner, index) => {
    const rules = rulesOf(sheet);
    if (rules) for (const r of rules) if (r instanceof CSSImportRule && r.styleSheet) visit(r.styleSheet, "import", 0);
    const node = sheet.ownerNode;
    let text = null, textMatches = false;
    if (owner === "style" && node) {
      text = node.textContent;
      try {
        const probe = new CSSStyleSheet();
        probe.replaceSync(text.replace(/@import[^;]*;/g, ""));
        textMatches = rules !== null && probe.cssRules.length === rules.filter((r) => !(r instanceof CSSImportRule)).length;
      } catch { textMatches = false; }
    }
    out.push({
      href: sheet.href,
      base: sheet.href || document.baseURI,
      owner,
      index,
      media: sheet.media ? sheet.media.mediaText : "",
      disabled: sheet.disabled,
      text,
      cssom: rules ? rules.map((r) => r.cssText).join("\\n") : null,
      textMatches,
    });
  };
  for (const s of document.styleSheets) {
    const tag = s.ownerNode && s.ownerNode.tagName ? s.ownerNode.tagName.toLowerCase() : "";
    visit(s, tag === "link" ? "link" : "style", tag === "link" ? 0 : ++styles);
  }
  for (const s of document.adoptedStyleSheets || []) visit(s, "adopted", ++adopted);
  return out;
})()`;

/**
 * Runs in the page: the rendered DOM without scripts, styles, credentials or relative URLs, one
 * element per line where a line break can't change the rendering (so findings name a useful
 * page.html:line). A line break is added before a block-level element, or any child of a flex or
 * grid container: white space there collapses away. Never inside white-space: pre and the like,
 * and never next to inline content, where it would be a space.
 */
const DOM_SCRIPT = `(() => {
  const FLAG = "data-cadesa-capture-ws";
  const marked = [];
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    const parent = el.parentElement ? getComputedStyle(el.parentElement) : null;
    const inHead = !!el.closest("head") || el.tagName === "HEAD" || el.tagName === "BODY";
    const collapse = (s) => !s || (s.whiteSpaceCollapse ? s.whiteSpaceCollapse === "collapse" : !/^(pre|pre-wrap|pre-line|break-spaces)$/.test(s.whiteSpace));
    let f = "";
    if (inHead || ((/^(block|flex|grid|table|list-item|flow-root)$/.test(cs.display) || (parent && /(^|-)(flex|grid)$/.test(parent.display))) && collapse(parent))) f += "b";
    if (!collapse(cs)) f += "p";
    if (f) { el.setAttribute(FLAG, f); marked.push(el); }
  }
  const root = document.documentElement.cloneNode(true);
  for (const el of marked) el.removeAttribute(FLAG);
  const drop = (sel) => root.querySelectorAll(sel).forEach((e) => e.remove());
  drop("script, noscript, style, base, iframe[srcdoc]");
  drop('link[rel~="stylesheet"], link[rel~="preload"], link[rel~="modulepreload"], link[rel~="prefetch"], link[rel~="preconnect"], link[rel~="dns-prefetch"], link[rel~="manifest"]');
  drop('meta[http-equiv], meta[name*="csrf" i], meta[name*="token" i]');
  for (const el of root.querySelectorAll("*")) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || a.name === "nonce" || a.name === "integrity") el.removeAttribute(a.name);
      else if (/^(src|href|poster|action)$/.test(a.name) && a.value && !/^(#|data:|javascript:|mailto:|tel:)/i.test(a.value)) {
        try { el.setAttribute(a.name, new URL(a.value, document.baseURI).href); } catch {}
      } else if (a.name === "srcset") {
        el.setAttribute("srcset", a.value.split(",").map((part) => {
          const [u, ...rest] = part.trim().split(/\\s+/);
          try { return [new URL(u, document.baseURI).href, ...rest].join(" "); } catch { return part.trim(); }
        }).join(", "));
      }
    }
    // Form values can hold credentials and tokens: none are written.
    if (el.tagName === "INPUT" && /^(password|hidden)$/i.test(el.getAttribute("type") || "")) el.removeAttribute("value");
  }
  let shadow = 0;
  for (const el of document.querySelectorAll("*")) if (el.shadowRoot) shadow++;
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const text = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\\u00a0/g, "&nbsp;");
  const attr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\\u00a0/g, "&nbsp;");
  const flag = (n) => (n.nodeType === 1 && n.getAttribute(FLAG)) || "";
  const blockish = (n) => !!n && flag(n).includes("b");
  const blank = (n) => n.nodeType === 3 && !/[^ \\t\\n\\r\\f]/.test(n.data);
  const ser = (n, depth, pretty) => {
    if (n.nodeType === 3) return text(n.data);
    if (n.nodeType === 8) return "<!--" + n.data + "-->";
    if (n.nodeType !== 1) return "";
    // SVG and MathML as the browser writes them.
    if (n.namespaceURI !== "http://www.w3.org/1999/xhtml") { n.removeAttribute(FLAG); n.querySelectorAll("[" + FLAG + "]").forEach((x) => x.removeAttribute(FLAG)); return n.outerHTML; }
    const keep = pretty && !flag(n).includes("p");
    n.removeAttribute(FLAG);
    const tag = n.localName;
    let s = "<" + tag + [...n.attributes].map((a) => " " + a.name + (a.value === "" ? "" : '="' + attr(a.value) + '"')).join("") + ">";
    if (VOID.has(tag)) return s;
    if (tag === "template") return s + n.innerHTML + "</" + tag + ">";
    const kids = [...n.childNodes];
    // The parser drops a newline right after <pre> and <textarea>: write one more to keep it.
    if (/^(pre|textarea|listing)$/.test(tag) && kids[0] && kids[0].nodeType === 3 && kids[0].data.startsWith("\\n")) s += "\\n";
    const pad = "\\n" + "  ".repeat(depth + 1);
    // Read before serializing a child removes its flag.
    const block = kids.map(blockish);
    let last = false;
    kids.forEach((k, i) => {
      // White space next to a block-level box collapses away: it's replaced by the line breaks.
      if (keep && blank(k) && (block[i - 1] || block[i + 1])) return;
      if (keep && block[i]) s += pad;
      s += ser(k, depth + 1, keep);
      last = block[i];
    });
    if (keep && last) s += "\\n" + "  ".repeat(Math.max(0, depth));
    return s + "</" + tag + ">";
  };
  const dt = document.doctype;
  return { html: (dt ? "<!doctype " + dt.name + ">\\n" : "") + ser(root, -1, true), shadow };
})()`;

/** A file name from a URL's path: "bootstrap.min.css" (no query, nothing unsafe). */
function nameFrom(url: string | null, fallback: string, ext: string): string {
  let name = "";
  try {
    if (url) name = decodeURIComponent(basename(new URL(url).pathname));
  } catch {
    /* not a URL */
  }
  name = name.replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  if (!name) name = fallback;
  if (extname(name).toLowerCase() !== ext) name += ext;
  return name;
}


/**
 * Make a captured stylesheet one the lift reads as the browser applied it: each @import replaced
 * by the imported sheet's rules (wrapped in its media query), @charset removed, url()s pointing at
 * the saved font files or made absolute, and the sheet's own media wrapped around it.
 */
export function sanitizeCss(
  css: string,
  opts: { base: string; fonts: Map<string, string>; media?: string; fontPrefix: string; imported?: (url: string) => string | undefined },
  depth = 0,
): { css: string; notes: string[] } {
  const notes: string[] = [];
  const abs = (raw: string) => {
    try {
      return new URL(raw, opts.base).href;
    } catch {
      return undefined;
    }
  };
  const rewrite = (value: string) =>
    value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g, (all, a, b, c) => {
      const raw = a ?? b ?? c ?? "";
      if (!raw || /^(data:|#)/i.test(raw)) return all;
      const u = abs(raw);
      if (!u) return all;
      const font = opts.fonts.get(u.split("#")[0]);
      return `url("${font ? opts.fontPrefix + font : u}")`;
    });
  let out: string;
  try {
    const root = postcss.parse(css);
    root.walkAtRules((r) => {
      if (r.name === "charset") return void r.remove();
      if (r.name !== "import") return;
      const m = /^\s*(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?\s*(.*)$/.exec(r.params);
      const url = m && abs(m[1]);
      const text = url && depth < 8 ? opts.imported?.(url) : undefined;
      if (text === undefined) {
        notes.push(`could not read ${url ?? r.params}, imported by ${opts.base}; its rules are missing`);
        return void r.remove();
      }
      const inner = sanitizeCss(text, { ...opts, base: url!, media: m![2].trim() || undefined }, depth + 1);
      notes.push(...inner.notes);
      r.replaceWith(postcss.parse(inner.css).nodes);
    });
    root.walkDecls((d) => {
      if (/url\(/i.test(d.value)) d.value = rewrite(d.value);
    });
    out = root.toString();
  } catch (e) {
    // Saved with only its url()s rewritten: the lift reports what it can't read.
    notes.push(`could not parse the stylesheet from ${opts.base} (${(e as Error).message.split("\n")[0]}); saved as it was`);
    out = rewrite(css);
  }
  if (opts.media && !/^(all|)$/i.test(opts.media.trim())) out = `@media ${opts.media} {\n${out}\n}\n`;
  return { css: out.trim() + "\n", notes };
}

/** Run a login script: a module whose default export (or `login` export) is `async (page) => {}`. */
async function runLogin(file: string, page: Page, url: string) {
  const mod = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown; login?: unknown };
  const fn = typeof mod.default === "function" ? mod.default : typeof mod.login === "function" ? mod.login : undefined;
  if (!fn) throw new RunError(`${file} must export a function: export default async (page) => { ... }`);
  await (fn as (page: Page, ctx: { url: string }) => Promise<void>)(page, { url });
}

export async function capture(opts: CaptureOptions): Promise<CaptureResult> {
  const timeout = opts.timeout ?? 30000;
  const out = resolve(opts.out);
  const browser = await launchChromium();
  const notes: string[] = [];
  try {
    // A fresh context: nothing from it (cookies, storage) is written out.
    const context = await browser.newContext({ viewport: { width: opts.width ?? 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    const bodies = new Map<string, Promise<Buffer | undefined>>();
    const fontUrls: string[] = [];
    page.on("response", (res) => {
      const type = res.request().resourceType();
      if (type !== "stylesheet" && type !== "font") return;
      const url = res.url().split("#")[0];
      if (!res.ok()) {
        if (type === "stylesheet") notes.push(`the stylesheet ${url} returned HTTP ${res.status()}; its rules are missing`);
        return;
      }
      if (type === "font") fontUrls.push(url);
      bodies.set(url, res.body().catch(() => undefined));
    });
    if (opts.loginScript) await runLogin(opts.loginScript, page, opts.url);
    // The status of the document itself (Chromium fails the navigation when an error page is empty).
    let status: { code: number; text: string } | undefined;
    page.on("response", (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) status = { code: r.status(), text: r.statusText() };
    });
    const loaded = await page.goto(opts.url, { waitUntil: "load", timeout }).then(
      () => undefined,
      (e: Error) => e,
    );
    // An error page (a 404, a login wall's 401) isn't the page that was asked for.
    if (status && status.code >= 400)
      throw new RunError(
        `${opts.url} returned HTTP ${status.code}${status.text ? ` ${status.text}` : ""}: nothing was captured${status.code === 401 || status.code === 403 ? " (if the page needs a login, pass --login-script)" : ""}`,
      );
    if (loaded) throw new RunError(`could not load ${opts.url}: ${loaded.message.split("\n")[0].replace(/^page\.goto: /, "")}`);
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 10000) }).catch(() => notes.push("the network was still busy 10s after load; captured anyway"));
    if (opts.wait) await page.waitForSelector(opts.wait, { timeout });
    await settle(page);
    for (const step of opts.before ?? []) {
      await runStep(page, step, timeout);
      await settle(page);
      notes.push(`ran before saving: ${step}`);
    }
    const landed = page.url();
    if (landed.split("#")[0] !== new URL(opts.url).href.split("#")[0]) notes.push(`the page ended up at ${landed}, not the URL given (a redirect: is it a login page?)`);

    const sheets = (await page.evaluate(SHEETS_SCRIPT)) as SheetInfo[];
    const dom = (await page.evaluate(DOM_SCRIPT)) as { html: string; shadow: number };
    if (dom.shadow) notes.push(`${dom.shadow} element${dom.shadow === 1 ? " has" : "s have"} a shadow root; what is inside one is not saved`);

    // Fonts the page loaded.
    mkdirSync(join(out, "css"), { recursive: true });
    // check reads every stylesheet in css/: none left over from an earlier capture.
    for (const f of readdirSync(join(out, "css"))) if (/^\d+-.*\.css$/.test(f)) rmSync(join(out, "css", f));
    const fonts = new Map<string, string>();
    const fontFiles: CaptureResult["fonts"] = [];
    const used = new Set<string>();
    for (const url of [...new Set(fontUrls)]) {
      const body = await bodies.get(url);
      if (!body) continue;
      let name = nameFrom(url, `font-${fonts.size + 1}`, extname(new URL(url).pathname).toLowerCase() || ".woff2");
      for (let i = 2; used.has(name); i++) name = name.replace(/(-\d+)?(\.\w+)$/, `-${i}$2`);
      used.add(name);
      if (!fontFiles.length) mkdirSync(join(out, "fonts"), { recursive: true });
      writeFileSync(join(out, "fonts", name), body);
      fonts.set(url, name);
      fontFiles.push({ file: `fonts/${name}`, from: url });
    }

    // Stylesheets, in cascade order; an @import-ed sheet goes where its @import is.
    const cssBodies = new Map<string, string>();
    for (const [url, body] of bodies) {
      const b = await body;
      if (b && !fonts.has(url)) cssBodies.set(url, b.toString("utf8"));
    }
    const imported = (url: string) => cssBodies.get(url.split("#")[0]) ?? sheets.find((x) => x.owner === "import" && x.href === url)?.cssom ?? undefined;
    const written: CapturedSheet[] = [];
    const names = new Set<string>();
    let n = 0;
    for (const s of sheets) {
      if (s.disabled || s.owner === "import") continue;
      let text: string | null = null;
      let via: CapturedSheet["via"] = "cssom";
      const from = s.href ?? (s.owner === "adopted" ? `adopted stylesheet ${s.index}` : `<style> ${s.index}`);
      if (s.href) {
        const body = await bodies.get(s.href.split("#")[0]);
        if (body) (text = body.toString("utf8")), (via = "network");
      } else if (s.owner === "style" && s.text !== null && s.textMatches) (text = s.text), (via = "text");
      if (text === null) text = s.cssom;
      if (text === null) {
        notes.push(`${from}: neither its text nor its rules could be read (a cross-origin sheet without CORS); not saved`);
        continue;
      }
      if (!text.trim()) continue;
      const clean = sanitizeCss(text, { base: s.base, fonts, media: s.media, fontPrefix: "../fonts/", imported });
      notes.push(...clean.notes);
      n++;
      const stem = s.href ? nameFrom(s.href, `sheet-${n}`, ".css") : s.owner === "adopted" ? `adopted-${s.index}.css` : `style-${s.index}.css`;
      let name = `${String(n).padStart(2, "0")}-${stem}`;
      while (names.has(name)) name = name.replace(/\.css$/, "-2.css");
      names.add(name);
      writeFileSync(join(out, "css", name), clean.css);
      written.push({ file: `css/${name}`, from, via, rules: (() => {
        try {
          return postcss.parse(clean.css).nodes.length;
        } catch {
          return 0;
        }
      })() });
    }

    // The page, linking the saved stylesheets in order.
    const links = written.map((w) => `<link rel="stylesheet" href="${w.file}">`).join("\n");
    const html = /<\/head>/i.test(dom.html) ? dom.html.replace(/<\/head>/i, `${links}\n</head>`) : `${links}\n${dom.html}`;
    writeFileSync(join(out, "page.html"), html.endsWith("\n") ? html : html + "\n");
    await context.close();

    const rel = (p: string) => {
      const r = relative(process.cwd(), join(out, p));
      return r.startsWith("..") ? join(out, p) : r;
    };
    const quote = (p: string) => (/[\s"'$`\\]/.test(p) ? `"${p.replace(/(["$`\\])/g, "\\$1")}"` : p);
    // The css directory: check, render and whatif read its stylesheets in name order (01-…, 02-…).
    const command = `cadesa check ${quote(rel("page.html"))}${written.length ? ` --css ${quote(rel("css"))}` : ""}`;
    return { url: opts.url, out, page: join(out, "page.html"), stylesheets: written, fonts: fontFiles, notes, command };
  } finally {
    await browser.close();
  }
}

export function formatCapture(r: CaptureResult): string {
  const rel = (p: string) => {
    const x = relative(process.cwd(), p);
    return x.startsWith(".." + sep) || x === ".." ? p : x;
  };
  const out = [`captured ${r.url} into ${rel(r.out)}/`, `  page.html (rendered DOM, scripts removed)`];
  for (const s of r.stylesheets) out.push(`  ${s.file}  ${s.rules} rule${s.rules === 1 ? "" : "s"} · from ${s.from}${s.via === "cssom" ? " (read back from the browser's CSSOM)" : ""}`);
  for (const f of r.fonts) out.push(`  ${f.file}  from ${f.from}`);
  for (const n of r.notes) out.push(`  ! ${n}`);
  out.push("", "check it with:", `  ${r.command}`);
  return out.join("\n") + "\n";
}
