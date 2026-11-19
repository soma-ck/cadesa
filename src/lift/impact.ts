/**
 * Box-level uncertainty for lifted CSS.
 *
 * A declaration lift couldn't map is not just "x% coverage": a `:hover` rule can't move anything
 * in the default state, while `min-width` on one flex child can move all of its siblings. For each
 * width, this marks every box whose geometry the engine can no longer guarantee, and why.
 *
 * Propagation (conservative: may flag too much, never too little):
 *   size change of B   → B and its subtree; later siblings in a stack (all siblings in a cluster)
 *                        move; each ancestor resizes; repeat upward.
 *   visual offset of B → B and its subtree only.
 *   paint              → no geometry; contrast checks on B (and its text subtree) become inconclusive.
 *   state (:hover)     → nothing in the default state.
 */
import { containingBlock, walk, type Box, type Layout } from "../engine/layout.js";
import { insets } from "../resolve.js";
import type { Fixture, FixtureNode } from "../fixture.js";
import type { LiftResult, Unlifted } from "./lift.js";
import { locate, match, type Located } from "./selectors.js";

export type Effect = "size" | "position" | "visual" | "paint";

export interface BoxImpact {
  id: string;
  effects: Effect[];
  reasons: string[];
}

export interface WidthImpact {
  width: number;
  /** Boxes whose geometry the engine still predicts exactly. */
  exact: string[];
  /** Boxes whose geometry may differ from the original CSS. */
  uncertain: BoxImpact[];
  /** Boxes whose geometry is exact but whose colors are not fully known. */
  paintOnly: BoxImpact[];
  /** Records with no effect in the default state at this width. */
  noEffect: string[];
}

const UA_MARGIN = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "dd", "blockquote", "figure", "pre", "hr", "fieldset", "menu"]);
const UA_BOLD = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "th", "strong", "b"]);
const UA_CONTROL = new Set(["button", "input", "select", "textarea"]);

const where = (u: Unlifted) => `${u.file}${u.line ? `:${u.line}` : ""}`;
export const describeUnlifted = (u: Unlifted) => `${where(u)} ${u.decl ? `${u.decl.split(";")[0]}` : u.selector}: ${u.reason}`;

/** A cluster's children, line by line (a line starts where an item is left of the one before). */
export function linesOf(b: Box): Box[][] {
  const out: Box[][] = [];
  let prevRight = -Infinity;
  for (const c of b.children) {
    if (!out.length || c.x < prevRight - 0.001) out.push([]);
    out.at(-1)!.push(c);
    prevRight = c.x + c.w;
  }
  return out;
}

/** A cluster taller than its lines (a set height, an aspect ratio, or stretched): its lines share the extra height. */
function stretched(b: Box): boolean {
  const lines = linesOf(b);
  const m = (c: Box) => (c.props.margin?.value.top ?? 0) + c.h + (c.props.margin?.value.bottom ?? 0);
  const natural = lines.reduce((t, ln) => t + Math.max(0, ...ln.map(m)), 0) + (b.props.gap?.value ?? 0) * (lines.length - 1);
  const i = insets(b.props);
  return !!b.props.height || !!b.props.aspect || b.h > natural + i.top + i.bottom + 0.001;
}

/** Absolutely positioned or fixed: out of flow. */
const outOfFlow = (b: Box) => b.props.position?.value.type === "absolute" || b.props.position?.value.type === "fixed";

/** A box that places rows inside its height (stretching it moves its children). */
const placesRows = (b: Box) => /^(cluster|grid|layer)$/.test(b.props.pattern?.value ?? "") || (b.props.pattern?.value === "stack" && b.children.some((c) => c.props.grow));

function applies(u: Unlifted, width: number) {
  if (!u.when) return true;
  if (u.when.maxPx !== undefined && width > u.when.maxPx) return false;
  if (u.when.minPx !== undefined && width < u.when.minPx) return false;
  return true;
}

/** The state (widest-first breakpoint px, Infinity = base) whose declarations apply at `width`. */
function stateFor(states: number[], width: number) {
  return states.filter((s) => s >= width).sort((a, b) => a - b)[0] ?? Infinity;
}

export function impact(lifted: LiftResult, fixture: Fixture, layouts: Layout[]): WidthImpact[] {
  const located = locate(fixture.body);
  return layouts.map((l) => impactAt(lifted, located, l));
}

function impactAt(lifted: LiftResult, located: Located[], l: Layout): WidthImpact {
  const width = l.width;
  const boxes = [...walk(l.boxes)];
  const boxOf = new Map<FixtureNode, Box>();
  for (const loc of located) {
    // By id when the element has one: several elements of a tag can share a source line (minified or captured HTML).
    const b = loc.node.fixtureId ? boxes.find((x) => x.id === loc.node.fixtureId && x.tag === loc.node.tag) : boxes.find((x) => x.fixtureLine === loc.node.line && x.tag === loc.node.tag);
    if (b) boxOf.set(loc.node, b);
  }
  const parentOf = new Map<Box, Box>();
  for (const b of boxes) for (const c of b.children) parentOf.set(c, b);

  const marks = new Map<Box, Map<string, Effect>>();
  const mark = (b: Box, e: Effect, why: string) => {
    const m = marks.get(b) ?? new Map<string, Effect>();
    if (m.get(why) !== "size") m.set(why, e);
    marks.set(b, m);
  };
  const subtree = (b: Box, e: Effect, why: string) => {
    for (const x of walk([b])) mark(x, e, why);
  };
  /**
   * heightOnly: only the box's height is unknown (its width, and how its content is laid out, are
   * known). Then only what is below it moves: in a cluster, later lines, and on its own line the
   * items aligned by height (center, end) or stretched to it (only their own box, unless they
   * place rows inside it).
   */
  const sizeChange = (b: Box, why: string, heightOnly = false) => {
    if (heightOnly) {
      mark(b, "size", why);
      // Its rows (grid rows, cluster lines, a stack's growing items) share its height: what's in them moves and stretches.
      if (placesRows(b)) for (const k of b.children) subtree(k, "size", `stretched with #${b.id}: ${why}`);
    }
    else subtree(b, "size", why);
    let cur = b;
    for (let p = parentOf.get(cur); p; cur = p, p = parentOf.get(cur)) {
      // An absolutely positioned or fixed box neither moves its siblings nor resizes its parent.
      if (outOfFlow(cur)) return;
      const moved = `moved by #${b.id}: ${why}`;
      const pattern = p.props.pattern?.value;
      // A table's cells share its columns and rows: a change in one may move and resize all of it.
      // Only its row's height changes (its cells' too) and what's below moves when the change can't
      // reach the columns (table-layout: fixed reads widths only, or only a height changes) and no
      // row's height moves another's (no rowspan, no height the rows share).
      if ((p.props.part && !/^(cell|caption)$/.test(p.props.part.value.part)) || pattern === "table") {
        let t: Box | undefined = p;
        while (t && t.props.pattern?.value !== "table") t = parentOf.get(t);
        if (t) {
          let row: Box | undefined = cur.props.part?.value.part === "row" ? cur : p.props.part?.value.part === "row" ? p : undefined;
          const section = row && parentOf.get(row);
          const parts = [...walk([t])];
          const fixed = !!t.props.table?.value.fixed && !!t.props.width && t.props.width.value !== "fit";
          const shared = !!t.props.height || !!t.props.minHeight || parts.some((x) => (x.props.part?.value.part === "cell" && x.attrs?.rowspan !== undefined && !/^\s*1?\s*$/.test(x.attrs.rowspan)) || (/^(header|body|footer)$/.test(x.props.part?.value.part ?? "") && !!x.props.height));
          if (!row || !section || !section.props.part || shared || !(heightOnly || fixed)) row = undefined;
          if (row && section) {
            subtree(row, "size", `resized with #${b.id}: ${why}`);
            for (const r of section.children.slice(section.children.indexOf(row) + 1)) subtree(r, "position", moved);
            mark(section, "size", `resized by #${b.id}: ${why}`);
            for (const s of t.children.slice(t.children.indexOf(section) + 1)) subtree(s, s.props.part?.value.part?.startsWith("column") ? "size" : "position", moved);
            mark(t, "size", `resized by #${b.id}: ${why}`);
          } else subtree(t, "size", `resized with #${b.id}: ${why}`);
          p = t;
          continue;
        }
      }
      const i = p.children.indexOf(cur);
      const grows = pattern === "stack" && p.children.some((c) => c.props.grow);
      if (heightOnly && pattern === "cluster" && !stretched(p)) {
        const lines = linesOf(p);
        const li = lines.findIndex((ln) => ln.includes(cur));
        const align = p.props.align?.value ?? "center";
        lines.forEach((ln, k) => {
          for (const s of ln) {
            if (s === cur || k < li || outOfFlow(s)) continue;
            if (k > li || align === "center" || align === "end") subtree(s, "position", moved);
            else if (align === "stretch" && !s.props.height) (placesRows(s) ? subtree : mark)(s, "size", `stretched with #${b.id}: ${why}`);
          }
        });
      } else {
        const shared = pattern === "cluster" || grows;
        const sibs = shared ? p.children.filter((c) => c !== cur) : p.children.slice(i + 1);
        for (const s of sibs) if (!outOfFlow(s)) subtree(s, "position", moved);
      }
      mark(p, "size", `resized by #${b.id}: ${why}`);
    }
    const roots = l.boxes;
    if (outOfFlow(cur)) return;
    for (const r of roots.slice(roots.indexOf(cur) + 1)) if (!outOfFlow(r)) subtree(r, "position", `moved by #${b.id}: ${why}`);
  };

  const noEffect: string[] = [];
  const targetsOf = (u: Unlifted): { loc: Located; state: boolean; pseudo: boolean }[] => {
    if (u.className) return located.filter((x) => x.node.classes.includes(u.className!)).map((loc) => ({ loc, state: false, pseudo: false }));
    if (!u.decl) return [];
    return located
      .map((loc) => ({ loc, r: match(u.selector, loc) }))
      .filter((x) => x.r.matches)
      .map((x) => ({ loc: x.loc, state: x.r.state, pseudo: x.r.pseudoElement }));
  };

  for (const u of lifted.unlifted) {
    if (!applies(u, width) || u.kind === "none") continue;
    const why = describeUnlifted(u);
    const targets = targetsOf(u);
    if (u.kind === "state" || (targets.length && targets.every((t) => t.state))) {
      noEffect.push(why);
      continue;
    }
    for (const t of targets) {
      const b = boxOf.get(t.loc.node);
      if (!b) continue;
      if (u.kind === "geometry" || u.kind === "text" || t.pseudo) sizeChange(b, why);
      else if (u.kind === "height") sizeChange(b, why, true);
      else if (u.kind === "visual") subtree(b, "visual", why);
      else if (u.kind === "paint") (u.decl?.startsWith("color") ? subtree : mark)(b, "paint", why);
    }
  }

  // Browser defaults the original CSS never overrode (and Cadesa's reset would).
  const element = new Map(lifted.elements.map((e) => [e.className, e]));
  for (const loc of lifted.uaInCascade ? [] : located) {
    const b = boxOf.get(loc.node);
    if (!b) continue;
    const block = lifted.prefix + b.component;
    const reset = lifted.resets.get(block) ?? new Set<string>();
    const cls = b.slot ? `${block}__${b.slot}` : block;
    const e = element.get(cls);
    const decls = e ? e.states.get(stateFor([...e.states.keys()], width))! : new Map();
    const has = (p: string) => decls.has(p) || reset.has(p.replace(/-(top|right|bottom|left)(?=$|-)/, ""));
    const tag = loc.node.tag;
    const src = lifted.file;
    if (UA_MARGIN.has(tag) && ["top", "right", "bottom", "left"].some((k) => !has(`margin-${k}`)))
      sizeChange(b, `${src}: <${tag}> keeps the browser's default margin (no margin set); Cadesa's reset removes it`);
    if (UA_CONTROL.has(tag)) {
      if (["top", "right", "bottom", "left"].some((k) => !has(`padding-${k}`)))
        sizeChange(b, `${src}: <${tag}> keeps the browser's default padding`);
      if (["top", "right", "bottom", "left"].some((k) => !has(`border-${k}-width`)))
        sizeChange(b, `${src}: <${tag}> keeps the browser's default border`);
    }
    if (b.props.text && UA_BOLD.has(tag) && !has("font-weight"))
      sizeChange(b, `${src}: <${tag}> is bold by default; no font-weight is set, Cadesa assumes 400`);
    if (b.props.width && typeof b.props.width.value === "number" && !has("box-sizing") && !UA_CONTROL.has(tag) && (b.props.padding || b.props.border))
      sizeChange(b, `${src}: box-sizing is content-box here; Cadesa sizes border-box`);
  }

  // An absolutely positioned box moves and resizes with its containing block (the nearest
  // positioned ancestor) and, without offsets, with its parent.
  for (const b of boxes) {
    if (!outOfFlow(b) || marks.has(b)) continue;
    let cb: Box | undefined;
    for (let a = parentOf.get(b); a; a = parentOf.get(a))
      if (containingBlock(a, b.props.position!.value.type)) {
        cb = a;
        break;
      }
    const pos = b.props.position!.value;
    const atStatic = (pos.left === undefined && pos.right === undefined) || (pos.top === undefined && pos.bottom === undefined);
    const dep = [cb, atStatic ? parentOf.get(b) : undefined].find((a) => a && [...(marks.get(a)?.values() ?? [])].length);
    if (dep) subtree(b, "position", `moved by #${dep.id}: ${[...marks.get(dep)!.keys()][0].replace(/^(moved|resized) by #\S+: /, "")}`);
  }

  const exact: string[] = [];
  const uncertain: BoxImpact[] = [];
  const paintOnly: BoxImpact[] = [];
  for (const b of boxes) {
    const m = marks.get(b);
    if (!m) {
      exact.push(b.id);
      continue;
    }
    const geo = [...m].filter(([, e]) => e !== "paint");
    const paint = [...m].filter(([, e]) => e === "paint");
    const effects = [...new Set([...m.values()])];
    if (geo.length) uncertain.push({ id: b.id, effects, reasons: geo.map(([r]) => r) });
    else exact.push(b.id);
    if (!geo.length && paint.length) paintOnly.push({ id: b.id, effects: ["paint"], reasons: paint.map(([r]) => r) });
  }
  return { width, exact, uncertain, paintOnly, noEffect: [...new Set(noEffect)] };
}
