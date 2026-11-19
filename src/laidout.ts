/**
 * How many of a page's elements Cadesa didn't lay out: a browser shows them, but no box of the
 * prediction (and so no finding) covers them. Text inside a text box, and what's inside an image,
 * an SVG or a form control, count as laid out with their box; elements hidden (display: none)
 * don't count either way.
 */
import { walk, type Layout } from "./engine/layout.js";
import { REPLACED_BLOCK, stateAt, type El, type PageLift } from "./lift/page.js";

export interface NotLaidOut {
  /** Elements shown in a browser that no box covers, at the width where there are most. */
  count: number;
  /** Elements in the page's body. */
  total: number;
  width: number;
  /** Why, most common first. */
  causes: { cause: string; count: number }[];
}

const CONTROL = new Set(["input", "select", "textarea", "button"]);

/** Why `el` has no box at state `si`, or undefined when it's laid out (or hidden). */
function why(el: El, si: number, boxes: Set<string>): string | undefined {
  // What an ancestor decides: hidden, out of flow, a text box (inline content), one box for a table.
  for (let a = el.parent; a; a = a.parent) {
    const r = a.roles[si];
    if (r === "hidden" || r === "text") return undefined;
    if (r === "out") return "out of flow: position absolute or fixed, or a float";
    if (r === "leaf") return REPLACED_BLOCK.has(a.tag) || CONTROL.has(a.tag) ? undefined : "inside a table, laid out as one box";
  }
  const r = el.roles[si];
  if (!r) return "inside an element whose content isn't laid out";
  if (r === "hidden") return undefined;
  if (r === "out") return "out of flow: position absolute or fixed, or a float";
  return el.id && boxes.has(el.id) ? undefined : "no box of its own";
}

export function notLaidOut(lift: PageLift, layouts: Layout[]): NotLaidOut | undefined {
  const els = lift.elements.els.filter((e) => e.anonymous === undefined);
  if (!els.length || !layouts.length) return undefined;
  let worst: NotLaidOut | undefined;
  for (const l of layouts) {
    const si = lift.states.indexOf(stateAt(lift.states, l.width));
    const boxes = new Set([...walk(l.boxes)].map((b) => b.id));
    const causes = new Map<string, number>();
    for (const el of els) {
      const c = why(el, si, boxes);
      if (c) causes.set(c, (causes.get(c) ?? 0) + 1);
    }
    const count = [...causes.values()].reduce((a, b) => a + b, 0);
    if (!worst || count > worst.count)
      worst = { count, total: els.length, width: l.width, causes: [...causes].sort((a, b) => b[1] - a[1]).map(([cause, count]) => ({ cause, count })) };
  }
  return worst;
}
