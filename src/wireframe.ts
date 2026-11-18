/**
 * Draw the engine's predicted layout at one width as an SVG wireframe: every box as an outline,
 * every wrapped line of text as a bar of its predicted width, images crossed, issues in red.
 * No browser: this is exactly what `render` computes, drawn.
 */
import { walk, type Box, type Layout } from "./engine/layout.js";
import { fmtPx, insets } from "./resolve.js";

const MEDIA = new Set(["img", "video", "picture", "svg", "canvas", "iframe"]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function wireframeSvg(l: Layout, opts: { labels?: boolean } = {}): string {
  const labels = opts.labels ?? true;
  const boxes = [...walk(l.boxes)];
  const height = Math.ceil(Math.max(1, ...boxes.map((b) => b.y + b.h))) + 1;
  const flagged = new Set(l.issues.map((i) => i.id));
  const out: string[] = [];
  const placed: { x: number; y: number; w: number }[] = [];
  const depthOf = new Map<Box, number>();
  const visit = (b: Box, d: number) => {
    depthOf.set(b, d);
    b.children.forEach((c) => visit(c, d + 1));
  };
  l.boxes.forEach((b) => visit(b, 0));

  for (const b of boxes) {
    const root = !b.slot;
    const bad = flagged.has(b.id) || !!b.overflowX || !!b.overflowY;
    const stroke = bad ? "#e5484d" : root ? "#a32ff0" : "#8b93a1";
    const fill = b.props.background ? b.props.background.value : "none";
    const dash = b.assumptions.length ? ` stroke-dasharray="4 3"` : "";
    out.push(
      `<rect x="${fmtPx(b.x + 0.5)}" y="${fmtPx(b.y + 0.5)}" width="${fmtPx(Math.max(0, b.w - 1))}" height="${fmtPx(Math.max(0, b.h - 1))}" fill="${fill}" fill-opacity="${fill === "none" ? 0 : 0.12}" stroke="${stroke}" stroke-width="${root || bad ? 1.5 : 1}"${dash}/>`,
    );
    if (MEDIA.has(b.tag))
      out.push(
        `<path d="M${fmtPx(b.x)} ${fmtPx(b.y)}L${fmtPx(b.x + b.w)} ${fmtPx(b.y + b.h)}M${fmtPx(b.x + b.w)} ${fmtPx(b.y)}L${fmtPx(b.x)} ${fmtPx(b.y + b.h)}" stroke="#c7ccd4" stroke-width="1"/>`,
      );
    // Predicted text lines: one bar per line, at its measured width.
    if (b.lines && b.props.text) {
      const t = b.props.text.value;
      const lh = t.sizePx * t.lineHeight;
      const ins = insets(b.props);
      const ix = ins.left;
      const iy = ins.top;
      const inner = b.w - ins.left - ins.right;
      const total = b.lines.length * lh;
      const top = b.props.height ? b.y + iy + (b.h - ins.top - ins.bottom - total) / 2 : b.y + iy; // fixed-height text is centered
      const align = b.props.textAlign?.value ?? (b.tag === "button" ? "center" : "start");
      b.lines.forEach((line, i) => {
        const w = Math.min(line.width, inner);
        const x = b.x + ix + (align === "center" ? (inner - w) / 2 : align === "end" ? inner - w : 0);
        const barH = Math.max(2, Math.min(t.sizePx * 0.62, lh * 0.7));
        out.push(
          `<rect x="${fmtPx(x)}" y="${fmtPx(top + i * lh + (lh - barH) / 2)}" width="${fmtPx(w)}" height="${fmtPx(barH)}" rx="${fmtPx(barH / 3)}" fill="${bad ? "#e5484d" : "#3b4252"}" fill-opacity="${bad ? 0.55 : 0.32}"/>`,
        );
      });
    }
    // Skip a label that would overlap one already drawn (nested boxes often share a corner).
    const lw = (b.id.length + 1) * 5.6;
    const hit = placed.some((r) => b.x + 3 < r.x + r.w && r.x < b.x + 3 + lw && b.y < r.y + 12 && r.y < b.y + 12);
    if (labels && b.w >= 40 && b.h >= 14 && !hit) {
      placed.push({ x: b.x + 3, y: b.y, w: lw });
      const depth = depthOf.get(b) ?? 0;
      out.push(
        `<text x="${fmtPx(b.x + 3)}" y="${fmtPx(b.y + 10)}" font-size="9" fill="${stroke}" opacity="${depth > 2 ? 0.75 : 1}">#${esc(b.id)}</text>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${l.width} ${height}" width="${l.width}" height="${height}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
<rect width="${l.width}" height="${height}" fill="#fbfbfd"/>
${out.join("\n")}
</svg>
`;
}
