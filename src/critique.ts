/**
 * Design critique: measurable signals that a page reads as muddled or generic. Not taste: each
 * finding is a fact about the source or the box tree (with numbers and the YAML path), offered as
 * a suggestion. Checks:
 *
 *   type-scale   adjacent font sizes too close to read as different levels; too many sizes
 *   hierarchy    a heading not clearly larger than the body text it introduces
 *   grouping     a group's inner gap not smaller than the gap around it (proximity)
 *   alignment    too many distinct left edges for content at one width
 *   palette      no accent at all (only greys), or several accents competing on actions
 *   tells        tracked uppercase labels, " · " meta strings, "→" appended to actions
 *   wrap         a cluster that still wraps at the widest width checked (rarely intended)
 */
import { walk, type Box, type Layout } from "./engine/layout.js";
import type { Fixture, FixtureNode } from "./fixture.js";
import { tokenKey, type Model } from "./model.js";
import { fmtPx } from "./resolve.js";

export interface Critique {
  check: "type-scale" | "hierarchy" | "grouping" | "alignment" | "palette" | "tells" | "wrap";
  message: string;
  /** YAML path to edit, when there is one. */
  path?: string;
  width?: number;
  id?: string;
}

const HEADING = /^h[1-6]$/;
const ACTION = new Set(["a", "button"]);

function hsl(hex: string) {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

/** A color that reads as a hue rather than a grey or near-black/white. */
const chromatic = (hex: string) => {
  const { s, l } = hsl(hex);
  return s > 0.35 && l > 0.15 && l < 0.85;
};

export function critique(model: Model, fixture: Fixture, layouts: Layout[]): Critique[] {
  const out: Critique[] = [];

  // ---- type scale (source)
  // Bands of sizes where each step is < 1.12×: they read as one level, so either merge them or
  // spread them into a real step.
  const sizes = [...new Set([...model.text.values()].map((r) => r.size.px))].sort((a, b) => a - b);
  let band: number[] = [];
  const flush = () => {
    if (band.length > 1) {
      const roles = [...model.text.values()].filter((r) => band.includes(r.size.px)).map((r) => `${r.name} ${fmtPx(r.size.px)}`);
      out.push({
        check: "type-scale",
        message: `font sizes ${band.map(fmtPx).join(", ")}px are within ${(band[band.length - 1] / band[0]).toFixed(2)}× of each other, too close to read as different levels (${roles.join(", ")}); use one size for that level, or make a real step (≥1.2×)`,
        path: "text",
      });
    }
    band = [];
  };
  for (const sz of sizes) {
    if (band.length && sz / band[band.length - 1] >= 1.12) flush();
    band.push(sz);
  }
  flush();
  if (sizes.length > 7)
    out.push({ check: "type-scale", message: `${sizes.length} distinct font sizes (${sizes.map(fmtPx).join(", ")}px); most pages read more clearly with 4–6`, path: "text" });

  // ---- palette (source + usage)
  const usedColors = new Map<string, Set<string>>(); // hex → where
  const actionBgs = new Map<string, string>(); // hex → path
  for (const l of layouts)
    for (const b of walk(l.boxes)) {
      if (b.props.background) usedColors.set(b.props.background.value, (usedColors.get(b.props.background.value) ?? new Set()).add(b.props.background.steps.at(-1)!.path));
      if (b.props.text) usedColors.set(b.props.text.value.color, (usedColors.get(b.props.text.value.color) ?? new Set()).add(`text.${b.props.text.value.role}.color`));
      if (ACTION.has(b.tag) && b.props.background && chromatic(b.props.background.value)) actionBgs.set(b.props.background.value, b.props.background.steps.at(-1)!.path);
    }
  if (usedColors.size && ![...usedColors.keys()].some(chromatic))
    out.push({
      check: "palette",
      message: `every color in use is a grey, near-black or near-white (${[...usedColors.keys()].join(", ")}); with no hue anywhere the page reads as unbranded. One accent, from the subject, on the main action is usually enough`,
      path: "tokens.color",
    });
  if (actionBgs.size > 1)
    out.push({
      check: "palette",
      message: `${actionBgs.size} different accent colors fill actions (${[...actionBgs.keys()].join(", ")}); competing accents blur which action matters most`,
      path: [...actionBgs.values()][1],
    });

  // ---- per width: hierarchy, grouping, alignment
  for (const l of layouts) {
    const boxes = [...walk(l.boxes)];
    const parentOf = new Map<Box, Box>();
    for (const b of boxes) for (const c of b.children) parentOf.set(c, b);

    // hierarchy: a heading vs the text that follows it in the same parent
    for (const b of boxes) {
      if (!HEADING.test(b.tag) || !b.props.text) continue;
      const p = parentOf.get(b);
      const sibs = p ? p.children : l.boxes;
      const next = sibs.slice(sibs.indexOf(b) + 1).find((x) => x.props.text && !HEADING.test(x.tag));
      if (!next) continue;
      const ratio = b.props.text.value.sizePx / next.props.text!.value.sizePx;
      const weightGap = b.props.text.value.weight - next.props.text!.value.weight;
      // A heading smaller than what follows is a deliberate inversion (e.g. a plan name over a big price).
      if (ratio >= 1 && ratio < 1.25 && weightGap < 200)
        out.push({
          check: "hierarchy",
          width: l.width,
          id: b.id,
          message: `#${b.id} <${b.tag}> is ${fmtPx(b.props.text.value.sizePx)}px/${b.props.text.value.weight} over #${next.id} at ${fmtPx(next.props.text!.value.sizePx)}px/${next.props.text!.value.weight} (${ratio.toFixed(2)}× larger): the heading barely stands out. Make it ≥1.25× larger or clearly heavier`,
          path: b.props.text.steps.at(-1)!.path,
        });
    }

    // grouping: an inner stack whose gap is not smaller than its parent stack's gap
    for (const b of boxes) {
      const p = parentOf.get(b);
      if (!p || p.props.pattern?.value !== "stack" || b.props.pattern?.value !== "stack") continue;
      if (b.props.background || b.props.border || b.props.backdrop) continue; // a visible container is the grouping
      const inner = b.props.gap?.value ?? 0;
      const outer = p.props.gap?.value ?? 0;
      if (b.children.length > 1 && outer > 0 && inner >= outer)
        out.push({
          check: "grouping",
          width: l.width,
          id: b.id,
          message: `#${b.id} groups its items ${fmtPx(inner)}px apart but sits ${fmtPx(outer)}px from its neighbours in #${p.id}: the group doesn't read as a group. Keep inner gaps smaller than outer ones`,
          path: b.props.gap?.steps.at(-1)?.path ?? b.sourcePath,
        });
    }

    // alignment: distinct left edges of text that starts a content column
    const edges = new Map<number, string[]>();
    // Text in a row of items, or inside a card (a visible container narrower than the page), is
    // meant to be inset; only page-column text should share edges.
    const inRow = (b: Box): boolean => {
      for (let p = parentOf.get(b); p; p = parentOf.get(p)) {
        if (p.props.pattern?.value === "cluster" || p.props.pattern?.value === "grid") return true;
        if ((p.props.background || p.props.border || p.props.backdrop) && p.w < l.width - 1) return true;
      }
      return false;
    };
    for (const b of boxes) {
      if (!b.props.text || b.props.textAlign?.value === "center" || ACTION.has(b.tag) || inRow(b)) continue;
      const x = Math.round(b.x);
      edges.set(x, [...(edges.get(x) ?? []), b.id]);
    }
    const xs = [...edges.keys()].sort((a, b) => a - b);
    const near = xs.slice(1).map((x, i) => [xs[i], x] as const).filter(([a, b]) => b - a >= 2 && b - a <= 48);
    const list = (x: number) => `x=${x}: #${edges.get(x)!.slice(0, 2).join(", #")}${edges.get(x)!.length > 2 ? "…" : ""}`;
    if (near.length)
      out.push({
        check: "alignment",
        width: l.width,
        message: `text edges almost line up at ${l.width}px: ${near.map(([a, b]) => `${list(a)} vs ${list(b)} (${b - a}px apart)`).join("; ")}. Near-misses read as mistakes; give the bands the same frame (maxWidth + padding)`,
      });
    else if (edges.size > 3)
      out.push({
        check: "alignment",
        width: l.width,
        message: `text starts at ${edges.size} different left edges at ${l.width}px (${xs.map(list).join("; ")}); a shared content column reads as designed`,
      });
  }

  // ---- clusters that wrap even at the widest width
  const widest = layouts.reduce((a, b) => (b.width > a.width ? b : a), layouts[0]);
  if (widest)
    for (const b of walk(widest.boxes)) {
      if (b.props.pattern?.value !== "cluster" || b.children.length < 2) continue;
      const rowCount = b.children.reduce((n, c, i) => (i > 0 && c.x <= b.children[i - 1].x ? n + 1 : n), 1);
      if (rowCount > 1) {
        const need = b.children.reduce((w, c) => w + c.w, 0) + (b.props.gap?.value ?? 0) * (b.children.length - 1);
        out.push({
          check: "wrap",
          width: widest.width,
          id: b.id,
          message: `#${b.id} wraps into ${rowCount} rows even at ${widest.width}px (its items need ${fmtPx(need)}px in one row, it has ${fmtPx(b.w)}px). If one row was intended, give it room or narrow an item`,
          path: b.sourcePath,
        });
      }
    }

  // ---- template tells (source + fixture copy)
  for (const r of model.text.values())
    if (r.transform === "uppercase" && (r.letterSpacing ?? 0) > 0.04 && r.size.px <= 14)
      out.push({
        check: "tells",
        message: `text role ${r.name} is small, tracked uppercase: the most common template label. Keep it only where the label carries structure the content needs`,
        path: r.path,
      });
  const texts: FixtureNode[] = [];
  const collect = (n: FixtureNode) => {
    texts.push(n);
    n.children.forEach(collect);
  };
  fixture.body.forEach(collect);
  for (const n of texts) {
    const own = n.children.length ? "" : n.text;
    if (/ · .+ · /.test(own))
      out.push({ check: "tells", id: n.fixtureId, message: `#${n.fixtureId ?? n.tag} joins facts with middle dots ("${own.slice(0, 50)}"); a template habit. Separate lines or a sentence read better` });
    if (ACTION.has(n.tag) && /\s[→›»]$/.test(own))
      out.push({ check: "tells", id: n.fixtureId, message: `#${n.fixtureId ?? n.tag} ends in an arrow ("${own}"); say what happens instead` });
  }

  void tokenKey;
  // The same finding at several widths is one finding.
  const seen = new Map<string, Critique>();
  for (const c of out) {
    const key = `${c.check}|${c.id ?? ""}|${c.message.replace(/ at \d+px/g, "")}`;
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()];
}
