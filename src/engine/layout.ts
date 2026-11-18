/**
 * The Cascadio reference layout engine.
 *
 * Cascadio's layout semantics are defined here, without a browser. The language is
 * deliberately small (no cascade, no inheritance, two layout patterns, explicit tokens),
 * so the box tree is fully determined by source + fixture + viewport width.
 *
 * Stage A scope: boxes whose size comes from tokens or from stretching. Text boxes are
 * assumed to be one line tall (fontSize × lineHeight). Text measurement and wrapping is
 * Stage B and is reported as an assumption on every text box.
 */
import { closest } from "../diagnostics.js";
import type { Fixture, FixtureNode } from "../fixture.js";
import type { Component, Model, Pattern } from "../model.js";
import { activeBreakpoints, fmtPx, resolveElement, type ResolvedProps } from "../resolve.js";

const EPS = 0.001;

export interface Box {
  id: string;
  tag: string;
  component: string;
  slot?: string;
  /** Editable YAML path for this element's style. */
  sourcePath: string;
  fixtureLine?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  props: ResolvedProps;
  text?: string;
  /** Px this box's children extend past its content box horizontally. */
  overflowX?: number;
  assumptions: string[];
  children: Box[];
}

export interface Issue {
  severity: "error" | "warning";
  id: string;
  message: string;
  path?: string;
  suggestion?: string;
}

export interface Layout {
  width: number;
  active: string[];
  boxes: Box[];
  issues: Issue[];
}

type ParentKind = "page" | Pattern;

export function layout(model: Model, fixture: Fixture, width: number): Layout {
  const issues: Issue[] = [];
  let auto = 0;
  const idOf = (n: FixtureNode) => n.fixtureId ?? `${n.tag}#${++auto}`;

  function measure(n: FixtureNode, c: Component, slot: string | undefined, avail: number, parent: ParentKind): Box {
    const id = idOf(n);
    const props = resolveElement(model, c, slot, width);
    const sourcePath = slot ? `${c.path}.slots.${slot}` : c.path;
    const assumptions: string[] = [];

    // ---- width
    let w: number;
    const pw = props.width?.value;
    if (typeof pw === "number") w = pw;
    else if (parent === "cluster") {
      issues.push({
        severity: "error",
        id,
        path: sourcePath,
        message: `#${id} sits in a cluster but has no width; content-sized boxes need text measurement (Stage B). Give it a size token width.`,
      });
      w = 0;
    } else w = avail; // page block or stack: stretch
    if (props.maxWidth && w > props.maxWidth.value) w = props.maxWidth.value;

    const pad = props.padding?.value ?? 0;
    const border = props.border ? 1 : 0;
    const inset = pad + border;
    const inner = Math.max(0, w - 2 * inset);

    // ---- children
    const children: Box[] = [];
    const kids = n.children.map((k) => ({ node: k, slot: slotOf(k, c) })).filter((k) => k.slot !== null) as {
      node: FixtureNode;
      slot: string;
    }[];
    let contentH = 0;
    const pattern = props.pattern?.value;
    const gap = props.gap?.value ?? 0;

    if (kids.length && !pattern) {
      issues.push({
        severity: "error",
        id,
        path: sourcePath,
        message: `#${id} has child slots but no layout; add layout: { pattern: stack | cluster }`,
      });
    }

    if (kids.length && pattern === "stack") {
      let y = 0;
      kids.forEach((k, i) => {
        const b = measure(k.node, c, k.slot, inner, "stack");
        b.x = 0;
        b.y = y;
        y += b.h + (i < kids.length - 1 ? gap : 0);
        children.push(b);
      });
      contentH = y;
    } else if (kids.length && pattern === "cluster") {
      const measured = kids.map((k) => measure(k.node, c, k.slot, inner, "cluster"));
      let line: Box[] = [];
      let lineW = 0;
      let y = 0;
      const flush = () => {
        const lh = Math.max(...line.map((b) => b.h));
        let x = 0;
        for (const b of line) {
          b.x = x;
          b.y = y + (lh - b.h) / 2; // align-items: center
          x += b.w + gap;
        }
        y += lh;
        line = [];
        lineW = 0;
      };
      for (const b of measured) {
        const needed = line.length ? lineW + gap + b.w : b.w;
        if (line.length && needed > inner + EPS) {
          flush();
          y += gap; // row-gap
        }
        lineW = line.length ? lineW + gap + b.w : b.w;
        line.push(b);
        children.push(b);
      }
      if (line.length) flush();
      contentH = y;
    } else if (props.text) {
      const t = props.text.value;
      contentH = t.sizePx * t.lineHeight;
      if (!props.height) assumptions.push("text height assumes a single line (text measurement is Stage B)");
    }

    const h = props.height?.value ?? contentH + 2 * inset;
    const box: Box = {
      id,
      tag: n.tag,
      component: c.name,
      slot,
      sourcePath,
      fixtureLine: n.line,
      x: 0,
      y: 0,
      w,
      h,
      props,
      text: n.children.length ? undefined : n.text || undefined,
      assumptions,
      children,
    };

    const widest = Math.max(0, ...children.map((b) => b.x + b.w));
    if (widest > inner + EPS) {
      box.overflowX = widest - inner;
      const culprit = children.find((b) => b.x + b.w > inner + EPS)!;
      issues.push({
        severity: "warning",
        id,
        path: culprit.props.width?.steps.at(-1)?.path ?? culprit.sourcePath,
        message: `#${culprit.id} overflows #${id} by ${fmtPx(box.overflowX)}px at ${width}px`,
      });
    }
    return box;
  }

  /** The slot name of a fixture element inside component `c`, or null (reported) if it can't be laid out. */
  function slotOf(n: FixtureNode, c: Component): string | null {
    const prefix = `ca-${c.name}__`;
    const cls = n.classes.find((k) => k.startsWith(prefix));
    if (!cls) {
      issues.push({
        severity: "error",
        id: idOf(n),
        message: `<${n.tag}> inside .ca-${c.name} has no ${prefix}<slot> class; the engine only lays out declared slots`,
      });
      return null;
    }
    const slot = cls.slice(prefix.length);
    if (!c.slots.has(slot)) {
      issues.push({
        severity: "error",
        id: n.fixtureId ?? n.tag,
        path: `${c.path}.slots`,
        message: `fixture uses slot "${slot}" but ${c.path}.slots does not declare it`,
        suggestion: closest(slot, c.slots.keys()),
      });
      return null;
    }
    return slot;
  }

  const boxes: Box[] = [];
  let y = 0;
  for (const n of fixture.body) {
    const cls = n.classes.find((k) => k.startsWith("ca-") && !k.includes("__"));
    const c = cls ? model.components.get(cls.slice(3)) : undefined;
    if (!c) {
      issues.push({
        severity: "error",
        id: idOf(n),
        message: cls
          ? `fixture uses .${cls} but styles.${cls.slice(3)} is not declared`
          : `<${n.tag}> at the page level has no Cascadio component class`,
        suggestion: cls ? closest(cls.slice(3), model.components.keys()) : undefined,
      });
      continue;
    }
    const b = measure(n, c, undefined, width, "page");
    b.x = b.w < width ? (width - b.w) / 2 : 0; // max-width + margin-inline: auto
    b.y = y;
    y += b.h;
    boxes.push(b);
  }

  // Convert relative positions to page coordinates.
  const place = (b: Box, ox: number, oy: number) => {
    b.x += ox;
    b.y += oy;
    const inset = (b.props.padding?.value ?? 0) + (b.props.border ? 1 : 0);
    for (const k of b.children) place(k, b.x + inset, b.y + inset);
  };
  for (const b of boxes) place(b, 0, 0);

  return { width, active: activeBreakpoints(model, width).map((b) => b.name), boxes, issues };
}

export function* walk(boxes: Box[]): Generator<Box> {
  for (const b of boxes) {
    yield b;
    yield* walk(b.children);
  }
}
