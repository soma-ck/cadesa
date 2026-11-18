import type { Finding } from "./check.js";
import { describeElement, describeRules } from "./pointers.js";
import type { VerifyReport } from "./verify.js";
import { walk, type Box, type Issue, type Layout } from "./engine/layout.js";
import type { Explanation } from "./explain.js";
import type { WidthImpact } from "./lift/impact.js";
import type { LiftResult } from "./lift/lift.js";
import type { WhatIf, WidthDiff } from "./project.js";
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
  if (b.lines && b.lines.length > 1) parts.push(`${b.lines.length} lines`);
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

export function formatRender(
  layouts: Layout[],
  meta: { source: string; fixture: string; ms: number; lines?: boolean; impacts?: WidthImpact[] },
): string {
  const out = [`${meta.source} × ${meta.fixture} · computed in ${meta.ms}ms, no browser`, ""];
  for (const l of layouts) {
    out.push(header(l));
    const imp = meta.impacts?.find((i) => i.width === l.width);
    const uncertain = new Set(imp?.uncertain.map((u) => u.id));
    const rows: { cells: string[]; lines?: Box["lines"] }[] = [];
    const visit = (b: Box, depth: number) => {
      rows.push({
        cells: [
          `${"  ".repeat(depth + 1)}#${b.id}`,
          b.anonymous ? "(text)" : b.tag,
          `${fmtPx(b.x)},${fmtPx(b.y)}`,
          `${uncertain.has(b.id) ? "≈" : ""}${fmtPx(b.w)}×${fmtPx(b.h)}`,
          summary(b),
        ],
        lines: meta.lines && b.lines && b.lines.length > 1 ? b.lines : undefined,
      });
      b.children.forEach((c) => visit(c, depth + 1));
    };
    l.boxes.forEach((b) => visit(b, 0));
    const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r.cells[i].length)) + 1);
    for (const r of rows) {
      out.push(r.cells.map((c, i) => (i < 4 ? pad(c, widths[i]) : c)).join(" ").trimEnd());
      for (const line of r.lines ?? []) out.push(`${" ".repeat(widths[0] + 1)}│ ${line.text}  (${fmtPx(line.width)}px)`);
    }
    for (const i of l.issues) out.push(issueLine(i));
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmtPx(Math.abs(n));
const list = (ids: string[], n = 6) => ids.slice(0, n).map((id) => `#${id}`).join(", ") + (ids.length > n ? ` +${ids.length - n} more` : "");

/**
 * whatif, grouped: widths where the edit does the same thing share one block (boxes, property
 * changes and geometry deltas), and "unchanged" is only claimed for boxes predicted exactly.
 */
export function formatWhatif(r: WhatIf, meta: { ms: number; coverage?: Coverage; defaulted?: boolean }): string {
  const all = r.widths.map((w) => w.width);
  const out = r.changes.map((c) => `whatif ${c.path}: ${show(c.from)} → ${show(c.to)}`);
  const swept = all.length > 2 ? `${all.length} widths from ${all[0]} to ${all[all.length - 1]}px${meta.defaulted ? " (every 20px, plus both sides of each breakpoint)" : ""}` : `${all.join(", ")}px`;
  out.push(`(in memory, nothing written · ${swept} · ${meta.ms}ms, no browser)`);
  if (meta.coverage) out.push(formatCoverage(meta.coverage).trimEnd());
  out.push("");

  type Group = { key: string; widths: number[]; w: WidthDiff[] };
  const groups = new Map<string, Group>();
  const unchanged: WidthDiff[] = [];
  for (const w of r.widths) {
    const fresh = w.issuesAfter.filter((i) => !w.issuesBefore.some((b) => b.message === i.message)).map((i) => i.message);
    const fixed = w.issuesBefore.filter((i) => !w.issuesAfter.some((a) => a.message === i.message)).map((i) => i.message);
    if (!w.elements.length && !w.added.length && !w.removed.length && !fresh.length && !fixed.length) {
      unchanged.push(w);
      continue;
    }
    const key = JSON.stringify([
      w.elements.map((e) => [e.id, e.props.map((p) => [p.prop, p.from?.display, p.to?.display]), e.geometry.map((g) => [g.key, Math.round((g.to - g.from) * 100)])]),
      w.added,
      w.removed,
      fresh,
      fixed,
    ]);
    const g = groups.get(key) ?? { key, widths: [], w: [] };
    g.widths.push(w.width);
    g.w.push(w);
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    const w = g.w[0];
    const one = g.w.length === 1;
    const approx = new Set(g.w.flatMap((x) => x.approximate ?? []));
    out.push(`at ${widthRanges(g.widths, all)}${one && w.activeAfter.length ? ` · ${w.activeAfter.join(", ")} active` : ""}`);
    const idW = Math.max(0, ...w.elements.map((e) => e.id.length)) + 6;
    for (const e of w.elements) {
      const lead = pad(`  ${approx.has(e.id) ? "≈" : " "}#${e.id}`, idW);
      const blank = " ".repeat(idW);
      let first = true;
      const line = (t: string) => {
        out.push((first ? lead : blank) + t);
        first = false;
      };
      for (const p of e.props) {
        line(`${p.prop} ${p.from?.display ?? "unset"} → ${p.to?.display ?? "unset"}`);
        // The breakpoint step names one width ("390px ≤ 576px"); for a range, name the condition.
        if (p.to) out.push(blank + "  ← " + p.to.steps.map((s) => (one ? s.label : s.label.replace(/\(\d+(?:\.\d+)?px ≤ /, "(≤ "))).join(" ← "));
      }
      // One width: absolute values. Several: the delta, which is what they share.
      if (e.geometry.length)
        line(e.geometry.map((x) => (one ? `${x.key} ${fmtPx(x.from)} → ${fmtPx(x.to)}` : `${x.key} ${signed(x.to - x.from)}`)).join("  "));
    }
    if (w.added.length) out.push(`  + shown after the edit: ${list(w.added)}`);
    if (w.removed.length) out.push(`  − hidden after the edit: ${list(w.removed)}`);
    const fresh = w.issuesAfter.filter((i) => !w.issuesBefore.some((b) => b.message === i.message));
    const fixed = w.issuesBefore.filter((i) => !w.issuesAfter.some((a) => a.message === i.message));
    for (const i of fresh) out.push(issueLine(i).replace(/^ {2}/, "  new "));
    for (const i of fixed) out.push(`  ✓ fixed: ${i.message}`);
    const moved = w.elements.filter((e) => approx.has(e.id)).length;
    if (moved) out.push(`  ≈ ${moved} of these box${moved === 1 ? " is" : "es are"} approximate: the direction is predicted, the exact pixels need a browser`);
    out.push("");
  }

  if (unchanged.length) {
    const approx = [...new Set(unchanged.flatMap((w) => w.approximate ?? []))];
    const at = widthRanges(unchanged.map((w) => w.width), all);
    if (!approx.length) out.push(`✓ unchanged at ${at}: no box moved, no property changed`);
    else
      out.push(
        `✓ unchanged at ${at} for every box predicted exactly`,
        `  ≈ not guaranteed for ${approx.length} approximate box${approx.length === 1 ? "" : "es"} (${list(approx)}): confirm those in a browser if they matter`,
      );
  } else if (!groups.size) out.push("✓ unchanged: no box moved, no property changed");
  return out.join("\n").trimEnd() + "\n";
}

export function formatExplain(e: Explanation): string {
  const out = [
    `#${e.id} <${e.tag}> at ${e.width}px${e.active.length ? ` (${e.active.join(", ")} active)` : ""}`,
    `  box ${fmtPx(e.box.x)},${fmtPx(e.box.y)} ${fmtPx(e.box.w)}×${fmtPx(e.box.h)} · style ${e.sourcePath}`,
    "",
  ];
  const w = Math.max(...e.props.map((p) => p.prop.length)) + 2;
  for (const p of e.props) {
    out.push(`  ${pad(p.prop, w)}${p.value}`);
    for (const s of [...p.chain].reverse()) out.push(`  ${" ".repeat(w)}  ${s.kind === "source" ? "set at" : "  from"} ${s.label}`);
    for (const o of p.overrides)
      out.push(`  ${" ".repeat(w)}  ${o.active ? "●" : "○"} when.${o.breakpoint} (${o.query}): ${o.value}  ${o.path}`);
  }
  if (e.lines) {
    out.push("", `  ${e.lines.length} line${e.lines.length > 1 ? "s" : ""}:`);
    for (const l of e.lines) out.push(`    │ ${l.text}  (${fmtPx(l.width)}px)`);
  }
  for (const a of e.assumptions) out.push(`  assumption: ${a}`);
  for (const i of e.issues) out.push(issueLine(i));
  return out.join("\n") + "\n";
}

/** Show absolute paths relative to the working directory, or by file name when they're elsewhere. */
export function shortenPaths(text: string): string {
  const cwd = process.cwd() + "/";
  return text.replace(/(?<![\w.])\/(?:[\w.@+-]+\/)+[\w.@+-]+/g, (p) => (p.startsWith(cwd) ? p.slice(cwd.length) : p.slice(p.lastIndexOf("/") + 1)));
}

/** "320–760px, 1280px" from the widths a finding occurs at, in the order they were checked. */
export function widthRanges(at: number[], all: number[]): string {
  if (at.length === all.length && all.length > 2) return `all ${all.length} widths`;
  const idx = [...new Set(at)].map((w) => all.indexOf(w)).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    parts.push(j - i >= 2 ? `${all[idx[i]]}–${all[idx[j]]}` : j > i ? `${all[idx[i]]}, ${all[idx[j]]}` : `${all[idx[i]]}`);
    i = j + 1;
  }
  return parts.join(", ") + "px";
}

export interface Coverage {
  widths: number;
  /** Box × width counts. */
  boxes: number;
  exact: number;
  approximate: number;
  /** Causes of approximate boxes, most common first (count = box × width). */
  reasons: { reason: string; count: number }[];
}

/** Normalize a ≈ reason to its root cause, so the same cause groups across boxes and widths. */
function rootCause(r: string): string {
  return shortenPaths(r)
    .replace(/^(?:moved|resized) by #[\w-]+: /, "")
    .replace(/(?:\S+\.(?:css|html|ya?ml)(?::\d+)?|\(\S+\.(?:css|html)(?::\d+)?\))\s*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // Keep the cause, drop the explanation: "display: inline-block: an inline-level box in block flow".
    .replace(/^(.{24,}?)(?:;| \().*$/, "$1")
    .slice(0, 90);
}

export function coverage(layouts: Layout[], impacts?: WidthImpact[]): Coverage {
  let boxes = 0;
  let approximate = 0;
  const reasons = new Map<string, number>();
  const add = (r: string) => reasons.set(rootCause(r), (reasons.get(rootCause(r)) ?? 0) + 1);
  for (const l of layouts) {
    const all = [...walk(l.boxes)];
    boxes += all.length;
    const imp = impacts?.find((i) => i.width === l.width);
    const uncertain = new Map((imp?.uncertain ?? []).map((u) => [u.id, u]));
    for (const b of all) {
      const u = uncertain.get(b.id);
      if (u || b.assumptions.length) {
        approximate++;
        const rs = u ? u.reasons : b.assumptions;
        add(rs.find((r) => !/^(?:moved|resized) by/.test(r)) ?? rs[0] ?? "unknown");
      }
    }
  }
  return {
    widths: layouts.length,
    boxes,
    exact: boxes - approximate,
    approximate,
    reasons: [...reasons].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
  };
}

/** The first thing to read: how much of the page Cadesa actually predicted. */
export function formatCoverage(c: Coverage): string {
  if (!c.boxes) return "coverage: Cadesa laid out 0 boxes on this page, so nothing was checked. Check it in a browser.\n";
  const pct = (n: number) => `${Math.round((n / c.boxes) * 100)}%`;
  const perWidth = Math.round(c.boxes / Math.max(1, c.widths));
  const out = [
    `coverage: ${perWidth} boxes × ${c.widths} width${c.widths === 1 ? "" : "s"} · ${pct(c.exact)} exact · ${pct(c.approximate)} approximate (≈)`,
  ];
  if (c.reasons.length)
    out.push(`  ≈ because: ${c.reasons.slice(0, 3).map((r) => `${r.reason} (×${r.count})`).join(" · ")}${c.reasons.length > 3 ? ` · +${c.reasons.length - 3} more causes` : ""}`);
  if (c.approximate > c.exact) out.push("  → most of this page isn't predicted exactly: treat what follows as leads and confirm it in a browser");
  return out.join("\n") + "\n";
}

export function formatCheck(findings: Finding[], widths: number[], cov?: Coverage, verify?: VerifyReport): string {
  const head = cov ? formatCoverage(cov) + "\n" : "";
  if (!findings.length) return shortenPaths(`${head}✓ no findings at ${describeWidths(widths)}\n${verify ? "\n" + formatVerify(verify) : ""}`);
  // One line per issue (same check, element, severity and edit path), listing the widths it occurs at.
  const groups = new Map<string, { first: Finding; all: Finding[]; widths: number[] }>();
  for (const f of findings) {
    const state = f.verified?.status === "not reproduced" ? "not reproduced" : [f.severity, f.inconclusive ? 1 : 0].join("|");
    const key = [f.check, f.id, state, f.path ?? ""].join("|");
    const g = groups.get(key) ?? { first: f, all: [], widths: [] };
    g.widths.push(f.width);
    g.all.push(f);
    groups.set(key, g);
  }
  const notReproduced = (f: Finding) => f.verified?.status === "not reproduced";
  const rank = (f: Finding) => (notReproduced(f) ? 3 : f.inconclusive ? 2 : f.severity === "error" ? 0 : 1);
  const sorted = [...groups.values()].sort((a, b) => rank(a.first) - rank(b.first));
  const out: string[] = [];
  let section = -1;
  for (const g of sorted) {
    const f = g.first;
    const r = rank(f);
    if (r !== section && r >= 2)
      out.push(
        "",
        r === 2
          ? `inconclusive (these boxes aren't predicted exactly; ${verify ? "Chromium couldn't decide them either" : "confirm in a browser, or run check with --verify"}):`
          : "not reproduced in Chromium (no problem there at the widths it loaded):",
      );
    section = r;
    const icon = notReproduced(f) ? "○" : f.inconclusive ? "?" : f.severity === "error" ? "✖" : "⚠";
    const msg = f.message.replace(/ \(inconclusive: this box isn't exactly predicted for the original CSS\)/, "");
    out.push(`${icon} [${f.check}] ${msg} · at ${widthRanges(g.widths, widths)}`);
    if (f.element) out.push(`    element: ${describeElement(f.element)}`);
    for (const s of f.source ?? []) {
      const [first, ...rest] = describeRules(s.rules);
      out.push(`    ${s.what}: ${first}`, ...rest.map((x) => `    ${" ".repeat(s.what.length + 2)}${x}`));
    }
    if (!f.element && f.path) out.push(`    edit: ${f.path}`);
    if (verify) out.push(`    chromium: ${verifiedLine(g.all, widths)}`);
  }
  const shown = sorted.filter((g) => !notReproduced(g.first));
  const conclusive = shown.filter((g) => !g.first.inconclusive);
  const errors = conclusive.filter((g) => g.first.severity === "error").length;
  const warnings = conclusive.length - errors;
  const inconclusive = shown.length - conclusive.length;
  const gone = sorted.length - shown.length;
  out.push(
    "",
    `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}${inconclusive ? `, ${inconclusive} inconclusive` : ""}${gone ? `, ${gone} not reproduced in Chromium` : ""} (distinct issues across ${describeWidths(widths)})`,
  );
  if (verify) out.push(formatVerify(verify).trimEnd());
  return shortenPaths(head + out.join("\n").replace(/^\n/, "") + "\n");
}

/** "confirmed at 320–560px (40×40px)" for one group of findings. */
function verifiedLine(fs: Finding[], all: number[]): string {
  const by = new Map<string, Finding[]>();
  for (const f of fs) if (f.verified) by.set(f.verified.status, [...(by.get(f.verified.status) ?? []), f]);
  const parts: string[] = [];
  for (const status of ["confirmed", "not reproduced", "predicted"]) {
    const g = by.get(status);
    if (!g) continue;
    const detail = g[0].verified!.detail;
    const at = g.length === fs.length && status !== "predicted" && fs.length === 1 ? "" : ` at ${widthRanges(g.map((f) => f.width), all)}`;
    parts.push(`${status === "predicted" ? "not checked" : status}${at}${detail ? ` (${detail})` : ""}`);
  }
  const also = fs[0].verified?.alsoAt;
  if (also?.length) parts.push(`Chromium also shows it at ${also.join(", ")}px`);
  return parts.join(" · ") || "not checked";
}

export function formatVerify(v: VerifyReport): string {
  const b = v.boxes;
  const out = [
    `verified in ${v.browser} at ${v.widths.length} width${v.widths.length === 1 ? "" : "s"} (${v.widths.length - v.sampled.length} with findings, ${v.sampled.length} without)`,
    `  ${[b.exact && `boxes marked exact: ${b.exact - b.exactDiffer} of ${b.exact} match Chromium within 0.5px`, b.approximate && `boxes marked ≈: ${b.approximate - b.approximateDiffer} of ${b.approximate} match`].filter(Boolean).join(" · ") || "no boxes to compare"}`,
    ...b.examples.map((e) => `    differs: ${e}`),
    ...v.notes.map((n) => `  ${n}`),
  ];
  return out.join("\n") + "\n";
}

export function formatImpact(impacts: WidthImpact[]): string {
  const out: string[] = ["box impact (≈ = may differ from the original CSS)"];
  for (const i of impacts) {
    out.push(`${i.width}px`);
    out.push(`  ✓ exact (${i.exact.length}): ${i.exact.map((x) => `#${x}`).join(" ") || "none"}`);
    for (const u of i.uncertain) {
      out.push(`  ≈ #${u.id} ${u.effects.filter((e) => e !== "paint").join("+")}`);
      for (const r of u.reasons.filter((r) => !r.startsWith("moved by") && !r.startsWith("resized by")).slice(0, 3)) out.push(`      ${r}`);
      const via = u.reasons.filter((r) => r.startsWith("moved by") || r.startsWith("resized by"));
      if (via.length) out.push(`      ${[...new Set(via.map((r) => r.split(":")[0]))].join(", ")}`);
    }
    for (const p of i.paintOnly) out.push(`  ◐ #${p.id} colors only: ${p.reasons[0]}`);
    for (const n of i.noEffect) out.push(`  · no effect in the default state: ${n}`);
  }
  return out.join("\n") + "\n";
}

export function formatLift(r: LiftResult, meta: { out?: string; impacts?: WidthImpact[] }): string {
  const s = r.stats;
  const out = [
    `lift ${r.file}: ${s.declarations - s.unlifted} of ${s.declarations} declarations lifted · ${s.components} component${s.components === 1 ? "" : "s"} · ${s.tokens} tokens · ${s.breakpoints} breakpoint${s.breakpoints === 1 ? "" : "s"}`,
  ];
  if (meta.out) out.push(`wrote ${meta.out}`);
  if (r.unlifted.length) {
    out.push("", "not lifted:");
    for (const u of r.unlifted)
      out.push(`  ${u.line ? `${r.file}:${u.line}` : r.file} ${u.selector}${u.decl ? ` { ${u.decl} }` : ""}`, `      ${u.kind}: ${u.reason}${u.when ? ` (${u.when.raw})` : ""}`);
  }
  if (meta.impacts) out.push("", formatImpact(meta.impacts).trimEnd());
  return out.join("\n") + "\n";
}

/** "390, 1280px", or "58 widths from 320 to 1440px" for a sweep. */
export function describeWidths(widths: number[]): string {
  return widths.length > 6 ? `${widths.length} widths from ${widths[0]} to ${widths[widths.length - 1]}px` : `${widths.join(", ")}px`;
}
