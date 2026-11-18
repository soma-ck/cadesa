/**
 * Design checks over engine layouts. Every finding names the element, the width, and the
 * YAML path to edit. Checks that can't be decided from the source say "inconclusive".
 */
import type { Box, Issue, Layout } from "./engine/layout.js";
import type { WidthImpact } from "./lift/impact.js";
import { fmtPx } from "./resolve.js";

export interface Finding extends Issue {
  check: "layout" | "tap-target" | "contrast";
  width: number;
  inconclusive?: boolean;
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

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** With `impacts` (from a lift), findings on boxes the engine can't predict exactly are inconclusive. */
export function check(layouts: Layout[], impacts?: WidthImpact[]): Finding[] {
  const out: Finding[] = [];
  for (const l of layouts) {
    const imp = impacts?.find((i) => i.width === l.width);
    const geometryUnknown = new Set(imp?.uncertain.map((u) => u.id));
    const paintUnknown = new Set([...(imp?.uncertain ?? []), ...(imp?.paintOnly ?? [])].filter((u) => u.effects.includes("paint")).map((u) => u.id));
    const start = out.length;
    for (const i of l.issues) out.push({ ...i, check: "layout", width: l.width });
    const visit = (b: Box, bg: Behind) => {
      let here: Behind = bg;
      if (b.props.background) {
        const c = b.props.background.value;
        const opaque = rgba(c)[3] >= 0.999;
        here = opaque
          ? { color: c, path: b.props.background.steps.at(-1)!.path }
          : { ...bg, stops: [...(bg.stops ?? []), c], stopsPath: b.props.background.steps.at(-1)!.path };
      }
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
        const large = t.sizePx >= 24 || (t.sizePx >= 18.66 && t.weight >= 700);
        const min = large ? 3 : 4.5;
        const inconclusive = (why: string) =>
          out.push({ check: "contrast", width: l.width, severity: "warning", inconclusive: true, id: b.id, path: colorPath, message: `contrast of #${b.id} is inconclusive: ${why}` });
        // Translucent stops over an image can't be resolved; nearly opaque ones can.
        const stopsOpaque = (here.stops ?? []).length > 0 && here.stops!.every((s) => rgba(s)[3] >= 0.9);
        if (here.image && !stopsOpaque) inconclusive(`the text sits over ${here.image}; check it by eye, or put an opaque background or scrim behind it`);
        else if (!here.color && !stopsOpaque)
          inconclusive("no background behind it in the source; set page.background or a background on an ancestor");
        else {
          // The solid color, and every gradient stop composited over it: report the worst.
          const base = here.color ?? "#ffffff";
          const candidates = [
            ...(here.color && !stopsOpaque ? [{ c: here.color, from: here.path! }] : []),
            ...(here.stops ?? []).map((s) => ({ c: rgba(s)[3] >= 0.999 ? s.slice(0, 7) : composite(s, base), from: `gradient stop ${s} in ${here.stopsPath}` })),
          ];
          const worst = candidates.map((x) => ({ ...x, ratio: contrast(t.color, x.c) })).sort((a, b) => a.ratio - b.ratio)[0];
          if (worst && worst.ratio < min)
            out.push({
              check: "contrast",
              width: l.width,
              severity: "error",
              id: b.id,
              path: colorPath,
              message: `#${b.id} text ${t.color} on ${worst.c} is ${worst.ratio.toFixed(2)}:1; WCAG AA needs ${min}:1 (background: ${worst.from})`,
            });
        }
      }
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
      const unknown = f.check === "contrast" ? paintUnknown.has(f.id) : geometryUnknown.has(f.id);
      if (unknown && !f.inconclusive) {
        f.inconclusive = true;
        f.severity = "warning";
        f.message += " (inconclusive: this box isn't exactly predicted for the original CSS)";
      }
    }
  }
  return out;
}
