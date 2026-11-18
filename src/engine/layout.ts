/**
 * The Cadesa reference layout engine.
 *
 * Cadesa's layout semantics are defined here, without a browser. The language is
 * deliberately small (no cascade, no inheritance, two layout patterns, explicit tokens),
 * so the box tree is fully determined by source + fixture + viewport width.
 *
 * Text is measured with bundled font metrics (see text.ts). Text in a font Cadesa has not
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
  /** The page background from the source, if declared. */
  page?: { background: string; path: string };
}

type ParentKind = "page" | Pattern;
const MEDIA = new Set(["img", "video", "picture", "svg", "canvas", "iframe", "object", "embed"]);

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
    const runs = (n.runs.length ? n.runs : [n.text]).map((r) => (t.uppercase ? r.toUpperCase() : r));
    const shown = runs.join(" ");
    const why = !m
      ? `font "${(t.font ?? "inherited").split(",")[0]}" has no Cadesa metrics; run cadesa metrics <font-file>`
      : m.unsupported(shown).length
        ? `characters outside the measured set: ${m.unsupported(shown).map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ")}`
        : m.weightIssue(t.weight);
    if (why) {
      assumptions.push(`text height assumes a single line (${why})`);
      return undefined;
    }
    // Each run (paragraph, list item, line after <br>) starts on a new line.
    return (maxWidth: number) => {
      const parts = runs.map((r) => layoutText(m!, r, t.sizePx, t.weight, maxWidth, { letterSpacing: t.letterSpacing, wrapAnywhere: t.wrapAnywhere }));
      const widest = parts.reduce((a, b) => (b.minContent > a.minContent ? b : a));
      return {
        lines: parts.flatMap((p) => p.lines),
        maxContent: Math.max(...parts.map((p) => p.maxContent)),
        minContent: widest.minContent,
        widestPiece: widest.widestPiece,
      };
    };
  }

  function measure(n: FixtureNode, c: Component, slot: string | undefined, avail: number, parent: ParentKind): Box {
    const id = idOf(n);
    const props = resolveElement(model, c, slot, width);
    const sourcePath = slot ? `${c.path}.slots.${slot}` : c.path;
    const assumptions: string[] = [];
    const inset = insetsOf(props);

    // Children that are Cadesa slots; anything else inside a text box is inline text.
    const classed = n.children.filter((k) => k.classes.some((cl) => cl.startsWith(model.prefix) && (cl.startsWith(`${model.prefix}${c.name}__`) || model.components.has(cl.slice(model.prefix.length)))));
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
    } else w = avail; // page block, stack, grid cell, layer: stretch
    if (props.maxWidth && w > props.maxWidth.value) w = props.maxWidth.value;
    if (props.measure && w > props.measure.value) w = props.measure.value;
    if (props.maxWidth && parent === "cluster")
      issues.push({
        severity: "error",
        id,
        path: props.maxWidth.steps.at(-1)!.path,
        message: `#${id} has maxWidth inside a cluster; its auto margins would push the row apart. Use a width token instead`,
      });

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
      : (n.children.map((k) => ({ node: k, ...childOf(k, c) })).filter((k) => k.comp !== null) as {
          node: FixtureNode;
          comp: Component;
          slot: string | undefined;
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
        message: `#${id} has child slots but no layout; add layout: { pattern: stack | cluster | grid | layer }`,
      });
    }

    /** margin-inline: auto centers a box narrower than its cell. */
    const centered = (b: Box, cell: number) => (b.props.maxWidth && b.w < cell ? (cell - b.w) / 2 : 0);
    /** Cross-axis alignment within a row of height `rowH` (grid rows, the layer cell). */
    const alignIn = (b: Box, rowH: number, align: string) => {
      if (align === "stretch" && !b.props.height && !b.props.aspect) grow(b, rowH);
      return align === "center" ? (rowH - b.h) / 2 : align === "end" ? rowH - b.h : 0;
    };

    if (kids.length && pattern === "grid") {
      const min = props.min!.value;
      const cols = Math.max(1, Math.floor((innerW + gap + EPS) / (min + gap)));
      const colW = cols === 1 ? innerW : (innerW - gap * (cols - 1)) / cols;
      const align = props.align?.value ?? "stretch";
      const measured = kids.map((k) => measure(k.node, k.comp, k.slot, colW, "grid"));
      let y = 0;
      for (let r = 0; r < measured.length; r += cols) {
        const row = measured.slice(r, r + cols);
        const rowH = Math.max(...row.map((b) => b.h));
        row.forEach((b, i) => {
          const dy = alignIn(b, rowH, align);
          b.x = i * (colW + gap) + centered(b, colW);
          b.y = y + dy;
          children.push(b);
        });
        y += rowH + (r + cols < measured.length ? gap : 0);
      }
      contentH = y;
    } else if (kids.length && pattern === "layer") {
      const align = props.align?.value ?? "stretch";
      const measured = kids.map((k) => measure(k.node, k.comp, k.slot, innerW, "layer"));
      const rowH = Math.max(...measured.map((b) => b.h));
      for (const b of measured) {
        const dy = alignIn(b, rowH, align);
        b.x = centered(b, innerW);
        b.y = dy;
        children.push(b);
      }
      contentH = rowH;
    } else if (kids.length && pattern === "stack") {
      let y = 0;
      kids.forEach((k, i) => {
        const b = measure(k.node, k.comp, k.slot, innerW, "stack");
        b.x = centered(b, innerW);
        b.y = y;
        y += b.h + (i < kids.length - 1 ? gap : 0);
        children.push(b);
      });
      contentH = y;
    } else if (kids.length && pattern === "cluster") {
      const measured = kids.map((k) => measure(k.node, k.comp, k.slot, innerW, "cluster"));
      let line: Box[] = [];
      let lineW = 0;
      let y = 0;
      const align = props.align?.value ?? "center";
      const flush = () => {
        const lh = Math.max(...line.map((b) => b.h));
        let x = 0;
        for (const b of line) {
          // align-items. stretch only grows items without a fixed height.
          if (align === "stretch" && !b.props.height) grow(b, lh);
          b.x = x;
          b.y = y + (align === "start" || align === "stretch" ? 0 : align === "end" ? lh - b.h : (lh - b.h) / 2);
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

    // aspect: the height follows the width. Media elements take exactly that; other boxes grow if
    // their content needs more (aspect-ratio's automatic minimum size).
    const media = MEDIA.has(n.tag);
    let h = props.height?.value ?? contentH + 2 * inset.y;
    if (props.aspect && !props.height) h = media ? w / props.aspect.value : Math.max(w / props.aspect.value, contentH + 2 * inset.y);
    if (media && !props.aspect && !props.height)
      issues.push({
        severity: "warning",
        id,
        path: sourcePath,
        message: `<${n.tag}> #${id} has no aspect or height, so its size depends on ${n.attrs.width || n.attrs.height ? "its width/height attributes and the file" : "the file"} and can't be predicted; add aspect: "16:9" (or height)`,
      });
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

  /**
   * A box stretched taller after its own layout. Stack, cluster and grid content stays top-aligned;
   * a layer re-aligns its children in the taller cell (center and end move, stretch grows).
   */
  function grow(b: Box, newH: number) {
    const delta = newH - b.h;
    if (delta <= 0) return;
    b.h = newH;
    if (b.props.pattern?.value !== "layer") return;
    const align = b.props.align?.value ?? "stretch";
    for (const c of b.children) {
      if (align === "stretch" && !c.props.height && !c.props.aspect) grow(c, c.h + delta);
      else if (align === "center") c.y += delta / 2;
      else if (align === "end") c.y += delta;
    }
  }

  /**
   * What a child element of component `c` is: one of c's slots, or the root of another (nested)
   * component. Null (reported) if it can't be laid out.
   */
  function childOf(n: FixtureNode, c: Component): { comp: Component | null; slot: string | undefined } {
    const prefix = `${model.prefix}${c.name}__`;
    const slotCls = n.classes.find((k) => k.startsWith(prefix));
    const nested = n.classes
      .filter((k) => k.startsWith(model.prefix) && !k.includes("__"))
      .map((k) => model.components.get(k.slice(model.prefix.length)))
      .find(Boolean);
    if (slotCls && nested) {
      issues.push({
        severity: "error",
        id: idOf(n),
        message: `<${n.tag}> is both .${slotCls} and the root of .${model.prefix}${nested.name}; mixing a slot and a component on one element isn't modelled. Wrap the component in the slot element instead.`,
      });
      return { comp: null, slot: undefined };
    }
    if (nested) return { comp: nested, slot: undefined };
    const slot = slotOf(n, c);
    return { comp: slot === null ? null : c, slot: slot ?? undefined };
  }

  /** The slot name of a fixture element inside component `c`, or null (reported) if it can't be laid out. */
  function slotOf(n: FixtureNode, c: Component): string | null {
    const prefix = `${model.prefix}${c.name}__`;
    const cls = n.classes.find((k) => k.startsWith(prefix));
    if (!cls) {
      issues.push({
        severity: "error",
        id: idOf(n),
        message: `<${n.tag}> inside .${model.prefix}${c.name} has no ${prefix}<slot> class and isn't another component's root; the engine only lays out declared slots and components`,
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
    const p = model.prefix;
    const candidates = n.classes.filter((k) => k.startsWith(p) && !k.includes("__")).map((k) => k.slice(p.length));
    const name = candidates.find((k) => model.components.has(k));
    const c = name ? model.components.get(name) : undefined;
    if (!c) {
      const guess = p ? candidates[0] : undefined;
      issues.push({
        severity: "error",
        id: idOf(n),
        message: guess
          ? `fixture uses .${p}${guess} but styles.${guess} is not declared`
          : `<${n.tag}> at the page level has no Cadesa component class`,
        suggestion: guess ? closest(guess, model.components.keys()) : undefined,
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

  const pageBg = model.page?.background;
  return {
    width,
    active: activeBreakpoints(model, width).map((b) => b.name),
    boxes,
    issues,
    page: pageBg ? { background: model.tokens.get(`color.${pageBg.name}`)!.raw, path: pageBg.path } : undefined,
  };
}

export function* walk(boxes: Box[]): Generator<Box> {
  for (const b of boxes) {
    yield b;
    yield* walk(b.children);
  }
}
