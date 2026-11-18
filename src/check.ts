/**
 * Design checks over engine layouts. Every finding names the element, the width, and the
 * YAML path to edit. Checks that can't be decided from the source say "inconclusive".
 */
import type { Box, Issue, Layout } from "./engine/layout.js";
import { fmtPx } from "./resolve.js";

export interface Finding extends Issue {
  check: "layout" | "tap-target" | "contrast" | "line-length";
  width: number;
  inconclusive?: boolean;
}

const INTERACTIVE = new Set(["button", "a", "input", "select", "textarea", "summary"]);

function luminance(hex: string): number {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export function check(layouts: Layout[]): Finding[] {
  const out: Finding[] = [];
  for (const l of layouts) {
    for (const i of l.issues) out.push({ ...i, check: "layout", width: l.width });
    const visit = (b: Box, bg?: { color: string; path: string }) => {
      const here = b.props.background ? { color: b.props.background.value, path: b.props.background.steps.at(-1)!.path } : bg;

      if (INTERACTIVE.has(b.tag)) {
        const small = Math.min(b.w, b.h);
        if (small < 24)
          out.push({
            check: "tap-target",
            width: l.width,
            severity: "error",
            id: b.id,
            path: (b.h < b.w ? b.props.height : b.props.width)?.steps.at(-1)?.path ?? b.sourcePath,
            message: `#${b.id} is ${fmtPx(b.w)}×${fmtPx(b.h)}px; WCAG 2.5.8 needs at least 24×24px`,
          });
        else if (small < 44)
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
        if (!here) {
          out.push({
            check: "contrast",
            width: l.width,
            severity: "warning",
            inconclusive: true,
            id: b.id,
            message: `contrast of #${b.id} is inconclusive: no Cascadio background behind it (the page background is outside the source)`,
          });
        } else {
          const ratio = contrast(t.color, here.color);
          const large = t.sizePx >= 24 || (t.sizePx >= 18.66 && t.weight >= 700);
          const min = large ? 3 : 4.5;
          if (ratio < min)
            out.push({
              check: "contrast",
              width: l.width,
              severity: "error",
              id: b.id,
              path: colorPath,
              message: `#${b.id} text ${t.color} on ${here.color} is ${ratio.toFixed(2)}:1; WCAG AA needs ${min}:1 (background from ${here.path})`,
            });
        }
        if (b.lines && b.lines.length > 1 && !b.props.height) {
          const longest = Math.max(...b.lines.map((x) => [...x.text].length));
          if (longest > 80)
            out.push({
              check: "line-length",
              width: l.width,
              severity: "warning",
              id: b.id,
              path: b.sourcePath,
              message: `#${b.id} has lines up to ${longest} characters at ${l.width}px; 45–75 reads comfortably`,
            });
        }
      }
      for (const k of b.children) visit(k, here);
    };
    for (const b of l.boxes) visit(b);
  }
  return out;
}
