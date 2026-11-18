import type { Box, Issue, Layout } from "./engine/layout.js";
import type { WhatIf } from "./project.js";
import { fmtPx, type Resolved } from "./resolve.js";

const pad = (s: string, n: number) => (s.length >= n ? s + " " : s + " ".repeat(n - s.length));

/** Show "← when.narrow" when a value comes from a breakpoint override. */
function via(r?: Resolved<unknown>) {
  const w = r?.steps.find((s) => s.kind === "when");
  return w ? ` ← when.${w.path.split(".")[1]}` : "";
}

function summary(b: Box): string {
  const p = b.props;
  const parts: string[] = [];
  if (p.pattern) parts.push(`${p.pattern.value}${via(p.pattern)}`);
  if (p.gap && p.gap.value) parts.push(`gap ${p.gap.display}${via(p.gap)}`);
  if (p.padding) parts.push(`padding ${p.padding.display}${via(p.padding)}`);
  if (p.width) parts.push(`width ${p.width.display}${via(p.width)}`);
  if (p.text) parts.push(`text ${p.text.value.role}`);
  if (b.overflowX) parts.push(`⚠ overflow ${fmtPx(b.overflowX)}px`);
  if (b.assumptions.length) parts.push("(1 line assumed)");
  return parts.join(" · ");
}

function issueLine(i: Issue) {
  const icon = i.severity === "error" ? "✖" : "⚠";
  return `  ${icon} ${i.message}${i.path ? `\n    edit: ${i.path}` : ""}${i.suggestion ? `\n    did you mean ${i.suggestion}?` : ""}`;
}

function header(l: Layout) {
  return `${l.width}px${l.active.length ? ` · ${l.active.join(", ")} active` : ""}`;
}

export function formatRender(layouts: Layout[], meta: { source: string; fixture: string; ms: number }): string {
  const out = [`${meta.source} × ${meta.fixture} · computed in ${meta.ms}ms, no browser`, ""];
  for (const l of layouts) {
    out.push(header(l));
    const rows: string[][] = [];
    const visit = (b: Box, depth: number) => {
      rows.push([
        `${"  ".repeat(depth + 1)}#${b.id}`,
        b.tag,
        `${fmtPx(b.x)},${fmtPx(b.y)}`,
        `${fmtPx(b.w)}×${fmtPx(b.h)}`,
        summary(b),
      ]);
      b.children.forEach((c) => visit(c, depth + 1));
    };
    l.boxes.forEach((b) => visit(b, 0));
    const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length)) + 1);
    for (const r of rows) out.push(r.map((c, i) => (i < 4 ? pad(c, widths[i]) : c)).join(" ").trimEnd());
    for (const i of l.issues) out.push(issueLine(i));
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export function formatWhatif(r: WhatIf, meta: { ms: number }): string {
  const out = r.changes.map((c) => `whatif ${c.path}: ${show(c.from)} → ${show(c.to)}`);
  out.push(`(in memory, nothing written · computed in ${meta.ms}ms, no browser)`, "");
  for (const w of r.widths) {
    const active = w.activeAfter.length ? ` · ${w.activeAfter.join(", ")} active` : "";
    out.push(`${w.width}px${active}`);
    if (!w.elements.length) out.push("  ✓ unchanged: no box moved, no property changed");
    const idW = Math.max(0, ...w.elements.map((e) => e.id.length)) + 4;
    for (const e of w.elements) {
      const lead = pad(`  #${e.id}`, idW);
      const blank = " ".repeat(idW);
      let first = true;
      const line = (s: string) => {
        out.push((first ? lead : blank) + s);
        first = false;
      };
      for (const p of e.props) {
        line(`${p.prop} ${p.from?.display ?? "unset"} → ${p.to?.display ?? "unset"}`);
        if (p.to) out.push(blank + "  ← " + p.to.steps.map((s) => s.label).join(" ← "));
      }
      if (e.geometry.length) line(e.geometry.map((g) => `${g.key} ${fmtPx(g.from)} → ${fmtPx(g.to)}`).join("  "));
    }
    const fresh = w.issuesAfter.filter((i) => !w.issuesBefore.some((b) => b.message === i.message));
    const fixed = w.issuesBefore.filter((i) => !w.issuesAfter.some((a) => a.message === i.message));
    for (const i of fresh) out.push(issueLine(i).replace(/^ {2}/, "  new "));
    for (const i of fixed) out.push(`  ✓ fixed: ${i.message}`);
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}
