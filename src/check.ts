/**
 * Design checks over engine layouts. Every finding names the element, the width, and the
 * YAML path to edit. Checks that can't be decided from the source say "inconclusive".
 */
import { walk, type Box, type Issue, type Layout } from "./engine/layout.js";
import type { WidthImpact } from "./lift/impact.js";
import type { PageLift } from "./lift/page.js";
import { fmtPx, insets } from "./resolve.js";

export interface Finding extends Issue {
  check: "layout" | "tap-target" | "contrast" | "clipped" | "spacing";
  width: number;
  inconclusive?: boolean;
  /** On a lifted page (--css, --tailwind): the element in the page (file:line, tag, classes, text). */
  element?: import("./pointers.js").ElementRef;
  /** On a lifted page: the CSS rules that set the properties behind the finding. */
  source?: import("./pointers.js").SourcePointer[];
  /** With check --verify: what Chromium showed at this width. */
  verified?: import("./verify.js").Verified;
}

const MEDIA = new Set(["img", "video", "picture", "svg", "canvas", "iframe", "object", "embed"]);
const ROLES = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio", "switch", "option"]);

/** What a user can actually tap: controls, links with an href, and elements with an interactive role. */
export function isTapTarget(b: Box): boolean {
  const a = b.attrs ?? {};
  if (a.role && ROLES.has(a.role.trim())) return true;
  if (b.tag === "a") return "href" in a;
  if (b.tag === "input") return (a.type ?? "").toLowerCase() !== "hidden";
  return b.tag === "button" || b.tag === "select" || b.tag === "textarea" || b.tag === "summary";
}

function luminance(hex: string): number {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** [r, g, b] in 0–255 and alpha in 0–1. */
function rgba(hex: string): [number, number, number, number] {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** `top` painted over an opaque `base`. */
export function composite(top: string, base: string): string {
  const [r, g, b, a] = rgba(top);
  const [R, G, B] = rgba(base);
  return toHex(r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a));
}

/** What sits behind a box's text, as far as the source knows. */
interface Behind {
  /** The solid color underneath (opaque), if any. */
  color?: string;
  path?: string;
  /** Gradient stops (hex, may be translucent) painted over `color`. */
  stops?: string[];
  stopsPath?: string;
  /** A backdrop with url(), or an image in a layer below this box. */
  image?: string;
}

const quote = (s: string, n = 40) => `"${s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s}"`;
const innerOf = (b: Box) => {
  const i = insets(b.props);
  return { w: b.w - i.left - i.right, h: b.h - i.top - i.bottom, left: b.x + i.left, top: b.y + i.top };
};

/**
 * Text a box cuts off: overflow hidden or clip (with or without text-overflow: ellipsis) on a box
 * narrower than its unwrapped text, or shorter than its lines. Scrolling boxes (auto, scroll) are
 * fine: the text is still reachable.
 */
function clippedText(b: Box): { id: string; message: (width: number) => string } | undefined {
  const ov = b.props.overflow?.value;
  if (!ov) return undefined;
  const how = `overflow: ${b.props.overflow!.display}`;
  const inner = innerOf(b);
  if ((ov.x === "hidden" || ov.x === "clip") && (b.overflowX ?? 0) > 0.5) {
    if (b.text && b.lines?.length) {
      const widest = b.lines.reduce((a, l) => (l.width > a.width ? l : a));
      return { id: b.id, message: (w) => `the text of #${b.id} is cut off at ${w}px: ${quote(widest.text)} needs ${fmtPx(widest.width)}px, the box shows ${fmtPx(inner.w)}px (${how}); let it wrap, or make room for it` };
    }
    // A child's text past the right edge.
    for (const k of walk(b.children)) {
      if (k === b || !k.text || !k.lines?.length) continue;
      if (k.x + k.w > inner.left + inner.w + 0.5)
        return { id: k.id, message: (w) => `the text of #${k.id} is cut off by #${b.id} at ${w}px: it ends ${fmtPx(k.x + k.w - inner.left - inner.w)}px past #${b.id}'s edge (${how} on #${b.id})` };
    }
  }
  if ((ov.y === "hidden" || ov.y === "clip") && (b.overflowY ?? 0) > 0.5 && b.text && b.lines?.length) {
    const lineH = b.lines.length ? (b.h - (insets(b.props).top + insets(b.props).bottom) + (b.overflowY ?? 0)) / b.lines.length : 0;
    const shown = Math.max(0, Math.floor((inner.h + 0.5) / lineH));
    return { id: b.id, message: (w) => `the text of #${b.id} is cut off at the bottom at ${w}px: ${b.lines!.length} lines, ${shown} fit in its ${fmtPx(inner.h)}px (${how}); remove the height or let it grow` };
  }
  return undefined;
}

/** `c` painted over what's behind: opaque replaces it, translucent over a solid color blends, else one more stop. */
function paintOver(bg: Behind, c: string, path: string): Behind {
  const a = rgba(c)[3];
  if (a >= 0.999) return { color: c, path };
  if (a <= 0.001) return bg;
  // A tinted card header over a card: the two blended.
  if (bg.color && !bg.stops?.length && !bg.image) return { color: composite(c, bg.color), path: `${path} (${Math.round(a * 100)}% opaque) over ${bg.path}` };
  return { ...bg, stops: [...(bg.stops ?? []), c], stopsPath: path };
}

/** The worst contrast of text in `color` over what's behind it (every gradient stop), or why it can't be known. */
function contrastOf(color: string, sizePx: number, weight: number, here: Behind): { why: string } | { ratio: number; min: number; on: string; from: string; alpha: number; shown: string } {
  const large = sizePx >= 24 || (sizePx >= 18.66 && weight >= 700);
  const min = large ? 3 : 4.5;
  // Translucent stops over an image can't be resolved; nearly opaque ones can.
  const stopsOpaque = (here.stops ?? []).length > 0 && here.stops!.every((s) => rgba(s)[3] >= 0.9);
  if (here.image && !stopsOpaque) return { why: `the text sits over ${here.image}; check it by eye, or put an opaque background or scrim behind it` };
  if (!here.color && !stopsOpaque) return { why: "no background behind it in the source; set page.background or a background on an ancestor" };
  // The solid color, and every gradient stop composited over it: report the worst.
  const base = here.color ?? "#ffffff";
  const candidates = [
    ...(here.color && !stopsOpaque ? [{ c: here.color, from: here.path! }] : []),
    ...(here.stops ?? []).map((s) => ({ c: rgba(s)[3] >= 0.999 ? s.slice(0, 7) : composite(s, base), from: `gradient stop ${s} in ${here.stopsPath}` })),
  ];
  // Translucent text (rgba, Bootstrap's .text-muted and navbar links) shows as its color over the background.
  const alpha = rgba(color)[3];
  const shown = (bg: string) => (alpha < 0.999 ? composite(color, bg) : color.slice(0, 7));
  const worst = candidates.map((x) => ({ ...x, ratio: contrast(shown(x.c), x.c) })).sort((a, b) => a.ratio - b.ratio)[0];
  return { ratio: worst.ratio, min, on: worst.c, from: worst.from, alpha, shown: shown(worst.c) };
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const PROPAGATED = /^(?:moved by|resized by|stretched with|geometry depends on) /;

/**
 * Boxes whose width, or whose width or height, may differ from the browser's. Finer than "≈", which
 * also covers boxes that only move: a box moved down by something uncertain above it keeps its size.
 *
 * A width can be wrong when the box itself is uncertain, when its parent's width is, when it sits
 * in a cluster (its width comes from its content and its siblings') next to anything uncertain, or
 * when it is sized to its content (width: fit) and something inside is uncertain. Its height also
 * when its width is, when anything inside it is, or when it shares a row (cluster, grid, layer, a
 * stack whose items grow) with something uncertain.
 */
export function sizeUncertainty(l: Layout, imp?: WidthImpact): { width: Set<string>; size: Set<string> } {
  const own = new Set<string>();
  for (const u of imp?.uncertain ?? []) if (u.reasons.some((r) => !PROPAGATED.test(r))) own.add(u.id);
  for (const b of walk(l.boxes)) if (b.assumptions.some((a) => !PROPAGATED.test(a))) own.add(b.id);
  // A box the engine reports an error on (content it can't measure, an unsupported margin) isn't known either.
  for (const i of l.issues) if (i.severity === "error") own.add(i.id);
  const inside = new Map<Box, boolean>();
  const anyInside = (b: Box): boolean => {
    let r = inside.get(b);
    if (r === undefined) inside.set(b, (r = own.has(b.id) || b.children.some(anyInside)));
    return r;
  };
  const out = new Set<string>();
  const visit = (b: Box, parent: Box | undefined, parentUnknown: boolean) => {
    // A cluster item with its own width (a length or a percentage, which never shrinks) and no grow keeps it.
    const w = b.props.width?.value;
    const fixed = (typeof w === "number" || (typeof w === "object" && "pct" in w)) && !b.props.grow;
    const cluster = parent?.props.pattern?.value === "cluster" && !fixed;
    const unknown =
      own.has(b.id) || parentUnknown || (cluster && parent!.children.some(anyInside)) || (b.props.width?.value === "fit" && anyInside(b));
    if (unknown) out.add(b.id);
    for (const k of b.children) visit(k, b, unknown);
  };
  for (const b of l.boxes) visit(b, undefined, false);
  // A transform (visual) may scale the box as drawn.
  const sized = new Set((imp?.uncertain ?? []).filter((u) => u.effects.includes("size") || u.effects.includes("visual")).map((u) => u.id));
  const size = new Set<string>();
  const visitSize = (b: Box, parent: Box | undefined) => {
    const pat = parent?.props.pattern?.value;
    const sharesRow = !!parent && (pat === "cluster" || pat === "grid" || pat === "layer" || (pat === "stack" && parent.children.some((k) => k.props.grow)));
    if (out.has(b.id) || sized.has(b.id) || anyInside(b) || (sharesRow && parent!.children.some(anyInside))) size.add(b.id);
    for (const k of b.children) visitSize(k, b);
  };
  for (const b of l.boxes) visitSize(b, undefined);
  return { width: out, size };
}

export const widthUncertainty = (l: Layout, imp?: WidthImpact) => sizeUncertainty(l, imp).width;

/**
 * With `impacts` (from a lift), findings on boxes the engine can't predict exactly are inconclusive.
 * With `page` (a page lift), also text that runs together, which the markup and cascade decide.
 */
export function check(layouts: Layout[], impacts?: WidthImpact[], page?: Partial<Pick<PageLift, "spacing" | "inlineRuns">>): Finding[] {
  const out: Finding[] = [];
  for (const l of layouts) {
    const imp = impacts?.find((i) => i.width === l.width);
    // Boxes the lift can't guarantee, and boxes the engine itself flags (unmeasured text, a scrollbar...).
    const geometryUnknown = new Set([...(imp?.uncertain.map((u) => u.id) ?? []), ...[...walk(l.boxes)].filter((b) => b.assumptions.length).map((b) => b.id)]);
    const paintUnknown = new Set([...(imp?.uncertain ?? []), ...(imp?.paintOnly ?? [])].filter((u) => u.effects.includes("paint")).map((u) => u.id));
    const { width: widthUnknown, size: sizeUnknown } = sizeUncertainty(l, imp);
    const byId = new Map([...walk(l.boxes)].map((b) => [b.id, b]));
    const start = out.length;
    for (const i of l.issues) out.push({ ...i, check: "layout", width: l.width });
    for (const i of page?.spacing?.(l.width) ?? []) out.push({ ...i, check: "spacing", width: l.width });
    const visit = (b: Box, bg: Behind) => {
      let here: Behind = bg;
      if (b.props.background) here = paintOver(bg, b.props.background.value, b.props.background.steps.at(-1)!.path);
      if (b.props.backdrop) {
        const raw = b.props.backdrop.value;
        const stops = raw.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
        here = /url\(/.test(raw)
          ? { ...here, image: `the backdrop image of #${b.id}` }
          : { ...here, stops: [...(here.stops ?? []), ...stops], stopsPath: b.props.backdrop.steps.at(-1)!.path };
      }

      if (isTapTarget(b)) {
        const small = Math.min(b.w, b.h);
        // WCAG 2.5.8 (AA) needs 24×24. The 44×44 advice (2.5.5, AAA) only for compact controls:
        // a full-width row 26px tall is easy to hit, a 32×32 icon button isn't.
        if (small < 24)
          out.push({
            check: "tap-target",
            width: l.width,
            severity: "error",
            id: b.id,
            path: (b.h < b.w ? b.props.height : b.props.width)?.steps.at(-1)?.path ?? b.sourcePath,
            message: `#${b.id} is ${fmtPx(b.w)}×${fmtPx(b.h)}px; WCAG 2.5.8 needs at least 24×24px`,
          });
        else if (small < 44 && Math.max(b.w, b.h) < 44)
          out.push({
            check: "tap-target",
            width: l.width,
            severity: "warning",
            id: b.id,
            path: (b.h < b.w ? b.props.height : b.props.width)?.steps.at(-1)?.path ?? b.sourcePath,
            message: `#${b.id} is ${fmtPx(b.w)}×${fmtPx(b.h)}px; 44×44px is recommended for touch (WCAG 2.5.5)`,
          });
      }

      if (b.text && b.props.text) {
        const t = b.props.text.value;
        const colorPath = `${b.props.text.steps[0].path}.color`;
        const judge = (color: string, sizePx: number, weight: number, behind: Behind, who: string, path: string) => {
          const r = contrastOf(color, sizePx, weight, behind);
          if ("why" in r)
            out.push({ check: "contrast", width: l.width, severity: "warning", inconclusive: true, id: b.id, path, message: `contrast of ${who} is inconclusive: ${r.why}` });
          else if (r.ratio < r.min)
            out.push({
              check: "contrast",
              width: l.width,
              severity: "error",
              id: b.id,
              path,
              message: `${who} text ${color}${r.alpha < 0.999 ? ` (${Math.round(r.alpha * 100)}% opaque, shows as ${r.shown})` : ""} on ${r.on} is ${r.ratio.toFixed(2)}:1; WCAG AA needs ${r.min}:1 (background: ${r.from})`,
            });
        };
        judge(t.color, t.sizePx, t.weight, here, `#${b.id}`, colorPath);
        // Inline runs in a color (or on a background) of their own: <span class="text-danger">, a badge.
        for (const r of page?.inlineRuns?.(l.width) ?? [])
          if (r.id === b.id) judge(r.color, r.sizePx, r.weight, r.background ? paintOver(here, r.background, r.where) : here, `${quote(r.text, 30)} (<${r.tag}> in #${b.id})`, r.where);
      }
      const clip = clippedText(b);
      if (clip) out.push({ check: "clipped", width: l.width, severity: "warning", id: clip.id, path: b.props.overflow!.steps.at(-1)!.path, message: clip.message(l.width) });
      // In a layer, children after an image sit on top of it.
      let behind = here;
      for (const k of b.children) {
        visit(k, behind);
        if (b.props.pattern?.value === "layer" && MEDIA.has(k.tag)) behind = { ...here, image: `the image #${k.id}` };
      }
    };
    const pageBg: Behind = l.page ? { color: l.page.background, path: l.page.path } : {};
    for (const b of l.boxes) visit(b, pageBg);
    for (const f of out.slice(start)) {
      // Contrast depends on colours, not geometry: only unknown paint makes it inconclusive.
      // Text running together depends on the markup and the cascade only (decided by the lift).
      // Clipped and overflowing text compare widths: a box that only moves up or down doesn't change them.
      const horizontal = f.check === "clipped" ? !/cut off at the bottom/.test(f.message) : f.check === "layout" && /overflows|can't wrap/.test(f.message);
      const unknown =
        f.check === "contrast"
          ? paintUnknown.has(f.id)
          : f.check === "spacing"
            ? false
            : horizontal
              ? widthUnknown.has(f.id) || !!byId.get(f.id)?.children.some((k) => widthUnknown.has(k.id))
              : // A tap target's size, and text taller than its box, don't depend on where the box is.
                f.check === "tap-target" || f.check === "clipped" || (f.check === "layout" && /^content of #/.test(f.message))
                ? sizeUnknown.has(f.id)
                : geometryUnknown.has(f.id);
      if (unknown && !f.inconclusive) {
        f.inconclusive = true;
        f.severity = "warning";
        f.message += " (inconclusive: this box isn't exactly predicted for the original CSS)";
      }
    }
  }
  return out;
}
