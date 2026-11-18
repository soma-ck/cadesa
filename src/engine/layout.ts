/**
 * The Cascadio reference layout engine.
 *
 * Cascadio's layout semantics are defined here, without a browser. The language is
 * deliberately small (no cascade, no inheritance, two layout patterns, explicit tokens),
 * so the box tree is fully determined by source + fixture + viewport width.
 *
 * Text is measured with bundled font metrics (see text.ts). Text in a font Cascadio has not
 * measured falls back to a one-line assumption, which every report flags.
 */
import { closest } from "../diagnostics.js";
import type { Fixture, FixtureNode } from "../fixture.js";
import type { Component, Model, Pattern } from "../model.js";
import { activeBreakpoints, fmtPx, resolveElement, type ResolvedProps } from "../resolve.js";
import { layoutText, metricsFor, type Line } from "./text.js";

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
  /** Laid-out lines, with widths in px, when the text could be measured. */
  lines?: Line[];
  /** Px this box's content extends past its content box horizontally. */
  overflowX?: number;
  /** Px this box's content extends past its fixed height. */
  overflowY?: number;
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

const insetsOf = (p: ResolvedProps) => {
  const border = p.border ? 1 : 0;
  return { x: (p.padding?.value.inline ?? 0) + border, y: (p.padding?.value.block ?? 0) + border };
};

export function layout(model: Model, fixture: Fixture, width: number): Layout {
  const issues: Issue[] = [];
  let auto = 0;
  const idOf = (n: FixtureNode) => n.fixtureId ?? `${n.tag}#${++auto}`;

  /** Measure the text of a leaf box. Returns undefined when the font has no metrics. */
  function text(n: FixtureNode, props: ResolvedProps, id: string, assumptions: string[]) {
    const t = props.text!.value;
    const m = metricsFor(t.font);
    const why = !m
      ? `font "${(t.font ?? "inherited").split(",")[0]}" has no Cascadio metrics`
      : m.unsupported(n.text).length
        ? `characters outside the measured set: ${m.unsupported(n.text).join(" ")}`
        : undefined;
    if (why) {
      assumptions.push(`text height assumes a single line (${why})`);
      return undefined;
    }
    return (maxWidth: number) => layoutText(m!, n.text, t.sizePx, t.weight, maxWidth);
  }

  function measure(n: FixtureNode, c: Component, slot: string | undefined, avail: number, parent: ParentKind): Box {
    const id = idOf(n);
    const props = resolveElement(model, c, slot, width);
    const sourcePath = slot ? `${c.path}.slots.${slot}` : c.path;
    const assumptions: string[] = [];
    const inset = insetsOf(props);

    // Children that are Cascadio slots; anything else inside a text box is inline text.
    const classed = n.children.filter((k) => k.classes.some((cl) => cl.startsWith("ca-")));
    const isText = !!props.text && classed.length === 0;
    const measureText = isText && n.text ? text(n, props, id, assumptions) : undefined;

    // ---- width
    let w: number;
    const pw = props.width?.value;
    if (typeof pw === "number") w = pw;
    else if (parent === "cluster") {
      if (pw === "fill") {
        issues.push({
          severity: "error",
          id,
          path: props.width!.steps.at(-1)!.path,
          message: `#${id} has width: fill inside a cluster; fill only stretches inside a stack`,
        });
      }
      if (measureText) {
        // Flex item with flex-basis: auto → max-content, shrinking no further than min-content.
        const t = measureText(Infinity);
        w = Math.max(Math.min(t.maxContent + 2 * inset.x, avail), t.minContent + 2 * inset.x);
      } else {
        issues.push({
          severity: "error",
          id,
          path: sourcePath,
          message: `#${id} sits in a cluster without a width, and its content can't be measured; give it a size token width`,
        });
        w = 0;
      }
    } else w = avail; // page block or stack: stretch
    if (props.maxWidth && w > props.maxWidth.value) w = props.maxWidth.value;

    const innerW = Math.max(0, w - 2 * inset.x);

    // ---- content
    const children: Box[] = [];
    let contentH = 0;
    let contentW = 0;
    let lines: Line[] | undefined;
    const pattern = props.pattern?.value;
    const gap = props.gap?.value ?? 0;
    const kids = isText
      ? []
      : (n.children.map((k) => ({ node: k, slot: slotOf(k, c) })).filter((k) => k.slot !== null) as {
          node: FixtureNode;
          slot: string;
        }[]);

    if (!isText && n.text && !n.children.length) {
      issues.push({
        severity: "error",
        id,
        path: sourcePath,
        message: `#${id} contains text but has no text role; add text: <role> so it can be measured`,
      });
    }

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
        const b = measure(k.node, c, k.slot, innerW, "stack");
        b.y = y;
        y += b.h + (i < kids.length - 1 ? gap : 0);
        children.push(b);
      });
      contentH = y;
    } else if (kids.length && pattern === "cluster") {
      const measured = kids.map((k) => measure(k.node, c, k.slot, innerW, "cluster"));
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
        if (line.length && needed > innerW + EPS) {
          flush();
          y += gap; // row-gap
        }
        lineW = line.length ? lineW + gap + b.w : b.w;
        line.push(b);
        children.push(b);
      }
      if (line.length) flush();
      contentH = y;
    } else if (isText && n.text) {
      const t = props.text!.value;
      const lineH = t.sizePx * t.lineHeight;
      if (measureText) {
        const tl = measureText(innerW);
        lines = tl.lines;
        contentH = lines.length * lineH;
        contentW = Math.max(...lines.map((l) => l.width));
        if (tl.minContent > innerW + 0.5) {
          issues.push({
            severity: "warning",
            id,
            path: props.text!.steps.at(-1)!.path,
            message: `"${tl.widestPiece}" in #${id} can't wrap and overflows by ${fmtPx(tl.minContent - innerW)}px at ${width}px`,
          });
        }
      } else contentH = lineH;
    }

    const h = props.height?.value ?? contentH + 2 * inset.y;
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
      text: isText ? n.text || undefined : undefined,
      lines,
      assumptions,
      children,
    };

    const widest = Math.max(contentW, ...children.map((b) => b.x + b.w));
    if (widest > innerW + 0.5 && children.length) {
      box.overflowX = widest - innerW;
      const culprit = children.find((b) => b.x + b.w > innerW + EPS)!;
      issues.push({
        severity: "warning",
        id,
        path: culprit.props.width?.steps.at(-1)?.path ?? culprit.sourcePath,
        message: `#${culprit.id} overflows #${id} by ${fmtPx(box.overflowX)}px at ${width}px`,
      });
    } else if (widest > innerW + 0.5) box.overflowX = widest - innerW;
    if (props.height && contentH > props.height.value - 2 * inset.y + 0.5) {
      box.overflowY = contentH - (props.height.value - 2 * inset.y);
      issues.push({
        severity: "warning",
        id,
        path: props.height.steps.at(-1)!.path,
        message: `content of #${id} needs ${fmtPx(contentH + 2 * inset.y)}px but its height is ${fmtPx(props.height.value)}px at ${width}px${lines ? ` (${lines.length} lines)` : ""}`,
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
    const inset = insetsOf(b.props);
    for (const k of b.children) place(k, b.x + inset.x, b.y + inset.y);
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
