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
const CONTROLS = new Set(["button", "input", "select", "textarea"]);

/** margin-inline: auto (from maxWidth) centers a box narrower than its cell; otherwise it starts at the left. */
const centered = (b: Box, cell: number) => (b.props.maxWidth && b.w < cell ? (cell - b.w) / 2 : 0);

/**
 * The height of one line box. Chromium multiplies a unitless line-height by the font size in
 * layout units (1/64 px, rounded to nearest) and rounds the product down to a layout unit; every
 * line of the text is that tall. (A product within 1/64000 px of a step counts as on it: lift
 * stores px line heights as 6-digit ratios.)
 */
export const lineHeightPx = (sizePx: number, lineHeight: number) => Math.floor((Math.round(sizePx * 64) / 64) * lineHeight * 64 + 1e-3) / 64;

/** A color that paints nothing (a background in it doesn't count as painted). */
function transparent(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (c === "transparent" || /^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/.test(c)) return true;
  const f = /^(?:rgba?|hsla?)\((.*)\)$/.exec(c);
  if (!f) return false;
  const args = f[1].includes("/") ? f[1].split("/").map((x) => x.trim()) : f[1].split(",").map((x) => x.trim());
  const alpha = f[1].includes("/") ? args[1] : args.length === 4 ? args[3] : undefined;
  return alpha !== undefined && parseFloat(alpha) === 0;
}

const insetsOf = (p: ResolvedProps) => {
  const border = p.border ? 1 : 0;
  return { x: (p.padding?.value.inline ?? 0) + border, y: (p.padding?.value.block ?? 0) + border };
};

interface Arrangement {
  rows: Box[][];
  /** Natural height of each row. */
  heights: number[];
  gap: number;
  align: "start" | "center" | "end" | "stretch";
  insetY: number;
}

export function layout(model: Model, fixture: Fixture, width: number): Layout {
  const issues: Issue[] = [];
  const arrangement = new WeakMap<Box, Arrangement>();
  /** Boxes the engine can't guarantee beyond their own assumptions and errors, and why. */
  const sources = new Map<Box, string>();
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
    // Chromium drops letter-spacing from text that has a U+202F (narrow no-break space) and no
    // letter: the run's script resolves to Mongolian, a cursive script, which is never spaced out.
    const unspaced = (s: string) => s.includes(" ") && !/\p{L}/u.test(s);
    // Only its ordinary spaces keep their letter-spacing.
    const spacesOnly = !!t.letterSpacing && unspaced(shown);
    if (t.letterSpacing && !spacesOnly && runs.length > 1 && runs.some(unspaced))
      assumptions.push("letter-spacing may be dropped from a paragraph that has a U+202F and no letters");
    // Contextual alternates change glyphs (and widths) depending on their neighbours: Inter draws
    // "*" and "@" differently between capitals, and "x" between digits as "×".
    const contextual = /[*@<>\\]/.test(shown) ? shown.match(/[*@<>\\]/)![0] : /\d ?[xX] ?\d/.test(shown) ? "x between digits" : undefined;
    if (contextual) assumptions.push(`text width is approximate: "${contextual}" has contextual forms that Cadesa doesn't measure`);
    // Whether a hanging space's kerning counts at a line end depends on the block that holds the
    // line: not when it paints a background, border or shadow (the text box itself; a <p> inside it
    // is its own, unpainted block) or its text is underlined. Under an underlined inline element
    // (<a href>, <u>...) it varies with where the element starts and ends, so both ways are tried
    // and the box is flagged when they disagree.
    const painted = (props.background && !transparent(props.background.value)) || props.backdrop || props.border || props.shadow;
    const meta = runs.map((_, i) => n.runMeta[i] ?? { inBlock: false, underlined: false });
    let ambiguous = false;
    // Each run (paragraph, list item, line after <br>) starts on a new line.
    return (maxWidth: number) => {
      const parts = runs.map((r, i) => {
        const opts = { letterSpacing: t.letterSpacing, spacesOnly, wrapAnywhere: t.wrapAnywhere };
        const plain = t.underline || (!!painted && !meta[i].inBlock);
        const a = layoutText(m!, r, t.sizePx, t.weight, maxWidth, { ...opts, hangKern: !plain });
        if (!plain && meta[i].underlined && !ambiguous) {
          const b = layoutText(m!, r, t.sizePx, t.weight, maxWidth, { ...opts, hangKern: false });
          if (b.lines.length !== a.lines.length || b.lines.some((l, k) => l.text !== a.lines[k].text) || Math.abs(b.minContent - a.minContent) > 1e-9) {
            ambiguous = true;
            assumptions.push("line breaks are approximate: a space at a line end inside underlined inline text (a link) changes the line's width");
          }
        }
        return a;
      });
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
      if (pw === undefined && props.aspect) w = avail; // aspect compiles to width: 100%
      else if (measureText) {
        // Flex item with flex-basis: auto → max-content, shrinking no further than min-content.
        const t = measureText(Infinity);
        // Intrinsic widths are rounded up to a layout unit, so the text fits the box it sizes.
        const up = (v: number) => Math.ceil(v * 64 - 1e-6) / 64;
        w = Math.max(Math.min(up(t.maxContent) + 2 * inset.x, avail), up(t.minContent) + 2 * inset.x);
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
    // box-sizing: border-box never makes a box narrower than its padding and border.
    w = Math.max(w, 2 * inset.x);
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
    const allKids = isText ? [] : n.children.map((k) => ({ node: k, ...childOf(k, c) }));
    const kids = allKids.filter((k) => k.comp !== null) as { node: FixtureNode; comp: Component; slot: string | undefined }[];
    const skipped = allKids.filter((k) => k.comp === null).map((k) => k.node);

    if (!isText && n.ownText && n.children.length) {
      issues.push({
        severity: "error",
        id,
        path: sourcePath,
        message: `#${id} has loose text ("${n.ownText.slice(0, 40)}") next to its child elements; the engine doesn't lay it out. Wrap it in a slot element`,
      });
    }
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

    /** Rows of children (grid rows, cluster lines, the layer cell) whose heights `arrange` distributes. */
    let rows: Box[][] | undefined;

    if (kids.length && pattern === "grid") {
      const min = props.min!.value;
      const cols = Math.max(1, Math.floor((innerW + gap + EPS) / (min + gap)));
      const colW = cols === 1 ? innerW : (innerW - gap * (cols - 1)) / cols;
      const measured = kids.map((k) => measure(k.node, k.comp, k.slot, colW, "grid"));
      rows = [];
      for (let r = 0; r < measured.length; r += cols) {
        const row = measured.slice(r, r + cols);
        row.forEach((b, i) => (b.x = i * (colW + gap) + centered(b, colW)));
        rows.push(row);
      }
    } else if (kids.length && pattern === "layer") {
      const measured = kids.map((k) => measure(k.node, k.comp, k.slot, innerW, "layer"));
      for (const b of measured) b.x = centered(b, innerW);
      rows = [measured];
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
      rows = [];
      let line: Box[] = [];
      let lineW = 0;
      for (const b of measured) {
        const needed = line.length ? lineW + gap + b.w : b.w;
        if (line.length && needed > innerW + EPS) {
          rows.push(line);
          line = [];
        }
        b.x = line.length ? lineW + gap : 0;
        lineW = b.x + b.w;
        line.push(b);
      }
      rows.push(line);
    } else if (isText && n.text) {
      const t = props.text!.value;
      const lineH = lineHeightPx(t.sizePx, t.lineHeight);
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
    if (rows) {
      children.push(...rows.flat());
      contentH = rows.reduce((s, r) => s + Math.max(...r.map((b) => b.h)), 0) + gap * (rows.length - 1);
    }

    // aspect: the height follows the width. Media elements take exactly that; other boxes grow if
    // their content needs more (aspect-ratio's automatic minimum size). In a stack (a column
    // flexbox) that minimum is capped by the max-width converted through the ratio.
    const media = MEDIA.has(n.tag);
    let h = props.height?.value ?? contentH + 2 * inset.y;
    if (props.aspect && !props.height) {
      const ratioH = w / props.aspect.value;
      const maxW = Math.min(props.maxWidth?.value ?? Infinity, props.measure?.value ?? Infinity);
      const contentMin = parent === "stack" ? Math.min(contentH + 2 * inset.y, maxW / props.aspect.value) : contentH + 2 * inset.y;
      h = media ? ratioH : Math.max(ratioH, contentMin);
    }
    h = Math.max(h, 2 * inset.y);
    // Without aspect (whose width: 100% wins), a media element with only a height takes its width
    // from its width attribute, or at the page level from the file's own ratio, instead of stretching.
    if (media && props.height && !props.aspect && typeof pw !== "number" && !props.maxWidth && parent !== "cluster") {
      if (n.attrs.width) assumptions.push(`its width comes from the width="${n.attrs.width}" attribute, not the layout; add aspect or a width token`);
      else if (parent === "page") assumptions.push("at the page level its width follows the image file; add aspect or a width token");
    }
    // A form control is as wide as its content unless something sets its width.
    if (parent === "page" && CONTROLS.has(n.tag) && typeof pw !== "number" && !props.maxWidth)
      assumptions.push(`a <${n.tag}> at the page level is as wide as its content; give it a width token or maxWidth`);
    if (media && !props.aspect && !props.height)
      issues.push({
        severity: "warning",
        id,
        path: sourcePath,
        message: `<${n.tag}> #${id} has no aspect or height, so its size depends on ${n.attrs.width || n.attrs.height ? "its width/height attributes and the file" : "the file"} and can't be predicted; add aspect: "16:9" (or height)`,
      });
    if (media && !props.aspect && !props.height) assumptions.push("its size depends on the image file (no aspect or height)");
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
    if (skipped.length)
      sources.set(box, `contains ${skipped.map((k) => `<${k.tag}>`).join(", ")} that the engine doesn't lay out`);
    if (rows) {
      arrangement.set(box, {
        rows,
        heights: rows.map((r) => Math.max(...r.map((b) => b.h))),
        gap,
        align: props.align?.value ?? (pattern === "cluster" ? "center" : "stretch"),
        insetY: inset.y,
      });
      arrange(box);
    }

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
   * Place the rows of a grid, cluster or layer inside its final height. A container taller than its
   * content (a fixed height, an aspect ratio, or stretched by its own parent) shares the extra
   * height equally between its rows: grid auto tracks stretch, and so do the lines of a wrapping
   * flex container (align-content: normal). Children are then aligned within their row.
   */
  function arrange(b: Box) {
    const a = arrangement.get(b);
    if (!a) return;
    const natural = a.heights.reduce((s, h) => s + h, 0) + a.gap * (a.rows.length - 1);
    const extra = Math.max(0, b.h - 2 * a.insetY - natural) / a.rows.length;
    let y = 0;
    a.rows.forEach((row, r) => {
      const rowH = a.heights[r] + extra;
      for (const c of row) {
        // stretch grows every item without a fixed height, aspect ratio or not.
        if (a.align === "stretch" && !c.props.height) grow(c, rowH);
        c.y = y + (a.align === "center" ? (rowH - c.h) / 2 : a.align === "end" ? rowH - c.h : 0);
      }
      y += rowH + a.gap;
    });
  }

  /** A box stretched taller after its own layout: its rows (if any) are placed again. */
  function grow(b: Box, newH: number) {
    if (newH <= b.h) return;
    b.h = newH;
    arrange(b);
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
  let unknownOnPage: string | undefined;
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
      unknownOnPage ??= `<${n.tag}> on the page isn't a Cadesa component; its height and margins are unknown`;
      continue;
    }
    const b = measure(n, c, undefined, width, "page");
    b.x = centered(b, width); // max-width + margin-inline: auto; otherwise left-aligned
    b.y = y;
    y += b.h;
    boxes.push(b);
  }
  // Its margins can collapse through empty boxes above it too, so every page-level box is unsure.
  if (unknownOnPage) for (const b of boxes) sources.set(b, unknownOnPage);

  // Uncertainty spreads: a box the engine can't guarantee (an assumption, an error, an element it
  // skipped) may have a different size, which moves its later siblings (every sibling in a cluster,
  // grid or layer, whose rows and lines it shares), resizes its parent, and so on up to the page.
  // Every box reached is flagged, so no prediction is presented as exact when it isn't.
  const parentOf = new Map<Box, Box>();
  for (const b of walk(boxes)) for (const k of b.children) parentOf.set(k, b);
  for (const b of walk(boxes)) {
    if (b.assumptions.length) sources.set(b, sources.get(b) ?? b.assumptions[0]);
    const e = issues.find((i) => i.severity === "error" && i.id === b.id);
    if (e) sources.set(b, sources.get(b) ?? e.message);
  }
  const flagged = new Map<Box, string>();
  const flag = (b: Box, why: string, deep: boolean) => {
    if (!flagged.has(b)) flagged.set(b, why);
    if (deep) for (const k of b.children) flag(k, why, true);
  };
  for (const [src, reason] of sources) {
    const why = `geometry depends on #${src.id}, which the engine can't guarantee (${reason})`;
    flag(src, `${reason}`, true);
    for (let b: Box | undefined = src; b; b = parentOf.get(b)) {
      const parent = parentOf.get(b);
      const sibs = parent ? parent.children : boxes;
      const loose = parent && parent.props.pattern?.value !== "stack";
      const i = sibs.indexOf(b);
      sibs.forEach((s, j) => (j > i || (loose && j !== i)) && flag(s, why, true));
      // A parent that is resized also moves its whole subtree when its own parent aligns it by size
      // (cluster lines, grid rows and the layer cell); in a stack or on the page it stays put.
      const grand = parent && parentOf.get(parent);
      if (parent) flag(parent, why, !!grand && grand.props.pattern?.value !== "stack");
    }
  }
  for (const [b, why] of flagged) if (!b.assumptions.length && !issues.some((i) => i.severity === "error" && i.id === b.id)) b.assumptions.push(why);

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
