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
import { walk, type Box, type Layout } from "../engine/layout.js";
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
    const b = boxes.find((x) => x.fixtureLine === loc.node.line && x.tag === loc.node.tag);
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
  const sizeChange = (b: Box, why: string) => {
    subtree(b, "size", why);
    let cur = b;
    for (let p = parentOf.get(cur); p; cur = p, p = parentOf.get(cur)) {
      const i = p.children.indexOf(cur);
      const sibs = p.props.pattern?.value === "cluster" ? p.children.filter((c) => c !== cur) : p.children.slice(i + 1);
      for (const s of sibs) subtree(s, "position", `moved by #${b.id}: ${why}`);
      mark(p, "size", `resized by #${b.id}: ${why}`);
    }
    const roots = l.boxes;
    for (const r of roots.slice(roots.indexOf(cur) + 1)) subtree(r, "position", `moved by #${b.id}: ${why}`);
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
      else if (u.kind === "visual") subtree(b, "visual", why);
      else if (u.kind === "paint") (u.decl?.startsWith("color") ? subtree : mark)(b, "paint", why);
    }
  }

  // Browser defaults the original CSS never overrode (and Cadesa's reset would).
  const element = new Map(lifted.elements.map((e) => [e.className, e]));
  for (const loc of located) {
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
