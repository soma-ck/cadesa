import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { isAuto, tokenKey, type Component, type MarginSide, type Model, type PageSides, type Props, type Ref, type Unsettable } from "./model.js";

/** The package version, read from package.json (works from src/ under tsx and from lib/). */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const varName = (r: { kind: string; name: string }) => `--ca-${r.kind}-${r.name}`;
const v = (r: Ref) => `var(${varName(r)})`;

const FLEX_ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", baseline: "baseline" } as const;
const GRID_ALIGN = { start: "start", center: "center", end: "end", stretch: "stretch", baseline: "baseline" } as const;
const JUSTIFY = { start: "flex-start", end: "flex-end", center: "center", between: "space-between", around: "space-around", evenly: "space-evenly" } as const;

interface Ctx {
  /** The element is a text leaf in some state (text set, layout never set). */
  leafText: boolean;
  /** What applies once this rule does: the base props with every override up to this one merged in. */
  eff: Props;
  /** A component root's base rule. */
  rootBase: boolean;
  /** The element has a height in some state. */
  height: boolean;
  /** A rule that applies whenever this one does sets aspect. */
  aspectBefore: boolean;
  /** A rule that applies whenever this one does (the base, or a wider override) makes it a layer. */
  layerBefore: boolean;
  /** Some state of the element has a text role that never wraps (so every text rule states white-space). */
  nowrap: boolean;
  /** Some state of the element sets a cluster's justify (so every cluster rule states it). */
  justify: boolean;
}

function decls(model: Model, p: Props, ctx: Ctx): string[] {
  const out: string[] = [];
  // A root without a layout is a block, whatever its tag: the engine never lays out inline boxes.
  if (ctx.rootBase && !p.layout) out.push("display: block");
  if (p.layout) {
    const l = p.layout;
    const gap = `gap: ${l.gap ? v(l.gap) : "0"}`;
    // A percentage gap is between columns only.
    const rowGap = l.rowGap ? [`row-gap: ${v(l.rowGap)}`] : l.gap?.kind === "size" ? ["row-gap: 0"] : [];
    // Block flow: children stack in normal flow and their vertical margins collapse.
    if (l.pattern === "flow") out.push("display: block");
    else if (l.pattern === "table")
      out.push(
        "display: table",
        `border-collapse: ${l.collapse ? "collapse" : "separate"}`,
        `border-spacing: ${l.gap ? v(l.gap) : "0"} ${l.rowGap ? v(l.rowGap) : l.gap ? v(l.gap) : "0"}`,
        `table-layout: ${l.fixed ? "fixed" : "auto"}`,
        `min-width: ${l.min ? v(l.min) : "0"}`,
      );
    else if (l.pattern === "stack" || l.pattern === "cluster") {
      const stack = l.pattern === "stack";
      out.push(
        "display: flex",
        `flex-direction: ${stack ? "column" : "row"}`,
        `flex-wrap: ${stack || l.wrap === false ? "nowrap" : "wrap"}`,
        `align-items: ${stack ? FLEX_ALIGN[l.align ?? "stretch"] : FLEX_ALIGN[l.align ?? "center"]}`,
        gap,
        ...rowGap,
      );
      // A stack restates flex-start when another state of the element is a justified cluster.
      if (l.justify || ctx.justify) out.push(`justify-content: ${stack ? "flex-start" : JUSTIFY[l.justify ?? "start"]}`);
    } else {
      // grid: columns auto-fill the row, each at least `min` (never wider than the row) and sharing
      // what's left equally. layer: one cell; every child is placed in it (see the child rule).
      // Explicit columns: each track as CSS writes it, runs of the same track as repeat().
      const tracks = (l.columns ?? []).map((t) => ("size" in t ? v(t.size) : t.auto ? `${t.fr}fr` : `minmax(0, ${t.fr}fr)`));
      const template = tracks.length > 1 && tracks.every((t) => t === tracks[0]) ? `repeat(${tracks.length}, ${tracks[0]})` : tracks.join(" ");
      out.push(
        "display: grid",
        l.pattern === "grid"
          ? l.template
            ? `grid-template-columns: ${l.template.columns ?? "none"}`
            : l.columns
              ? `grid-template-columns: ${template}`
              : `grid-template-columns: repeat(auto-fill, minmax(min(${v(l.min!)}, 100%), 1fr))`
          : "grid-template-columns: minmax(0, 1fr)",
        ...(l.template
          ? [
              `grid-template-rows: ${l.template.rows ?? "none"}`,
              `grid-template-areas: ${l.template.areas ? l.template.areas.map((a) => JSON.stringify(a)).join(" ") : "none"}`,
              `grid-auto-columns: ${l.template.autoColumns ?? "auto"}`,
              `grid-auto-rows: ${l.template.autoRows ?? "auto"}`,
              `grid-auto-flow: ${l.template.flow ?? "row"}${l.template.dense ? " dense" : ""}`,
              `justify-content: ${l.template.justifyContent ?? "normal"}`,
              `align-content: ${l.template.alignContent ?? "normal"}`,
            ]
          : []),
        `align-items: ${GRID_ALIGN[l.align ?? "stretch"]}`,
        `justify-items: ${GRID_ALIGN[l.justifyItems ?? "stretch"]}`,
        l.pattern === "grid" ? gap : "gap: 0",
        ...rowGap,
      );
    }
  }
  const unset = (k: Unsettable) => p.unset?.[k] !== undefined;
  if (p.padding) {
    const { top, right, bottom, left } = p.padding;
    const side = (r?: Ref) => (r ? v(r) : "0");
    const same = (a?: Ref, b?: Ref) => a?.name === b?.name;
    out.push(
      same(top, bottom) && same(left, right)
        ? top && left && top.name === left.name
          ? `padding: ${v(top)}`
          : `padding: ${side(top)} ${side(left)}`
        : `padding: ${side(top)} ${side(right)} ${side(bottom)} ${side(left)}`,
    );
  } else if (unset("padding")) out.push("padding: 0");
  if (p.margin) {
    // Every side, so an override replaces the whole margin. With maxWidth (margin-inline: auto),
    // only top and bottom: the validator rejects inline margins next to it.
    const side = (r?: MarginSide) => (isAuto(r) ? "auto" : r ? v(r) : "0");
    const m = p.margin;
    if (ctx.eff.maxWidth) out.push(`margin-top: ${side(m.top)}`, `margin-bottom: ${side(m.bottom)}`);
    else out.push(`margin: ${side(m.top)} ${side(m.right)} ${side(m.bottom)} ${side(m.left)}`);
  } else if (unset("margin")) out.push(...(ctx.eff.maxWidth ? ["margin-top: 0", "margin-bottom: 0"] : ["margin: 0"]));
  // background-color, not the shorthand: an override that changes only the color must not erase a backdrop.
  if (p.background) out.push(`background-color: ${v(p.background)}`);
  else if (unset("background")) out.push("background-color: transparent");
  if (p.backdrop)
    out.push(`background-image: ${v(p.backdrop)}`, "background-size: cover", "background-position: center", "background-repeat: no-repeat");
  else if (unset("backdrop")) out.push("background-image: none");
  if (p.border) {
    const b = p.border;
    if (!b.sides) out.push(`border: 1px solid ${v(b.color)}`);
    else {
      const w = (r?: Ref) => (r ? v(r) : "0");
      out.push("border-style: solid", `border-color: ${v(b.color)}`, `border-width: ${w(b.sides.top)} ${w(b.sides.right)} ${w(b.sides.bottom)} ${w(b.sides.left)}`);
    }
  } else if (unset("border")) out.push("border-width: 0");
  if (p.shadow) out.push(`box-shadow: ${v(p.shadow)}`);
  else if (unset("shadow")) out.push("box-shadow: none");
  if (p.radius) out.push(`border-radius: ${v(p.radius)}`);
  else if (unset("radius")) out.push("border-radius: 0");
  if (p.transform) out.push(`transform: ${p.transform.value}`, `transform-origin: ${p.transform.origin ?? "50% 50%"}`, ...(p.transform.preserve3d ? ["transform-style: preserve-3d"] : []));
  else if (unset("transform")) out.push("transform: none");
  if (p.perspective) out.push(`perspective: ${p.perspective.value}px`, `perspective-origin: ${p.perspective.origin ?? "50% 50%"}`);
  // max-width + auto margins. width: 100% so a flex or grid parent doesn't shrink-wrap the box
  // (auto margins switch off stretching). maxWidth and measure share max-width: when both apply
  // (in this rule or merged from an earlier one), the smaller wins.
  const e = ctx.eff;
  /** flex without a grow factor: a box with a width neither grows nor shrinks, one without shrinks; shrink sets its factor. */
  const flexOf = (sized: boolean) => (e.shrink ? `0 ${e.shrink.value} auto` : sized ? "none" : "0 1 auto");
  // A width the box sets itself (a size, or fit): maxWidth then only caps it.
  const fixedWidth = !!e.width && (!("keyword" in e.width) || e.width.keyword !== "fill");
  if (p.maxWidth || p.measure || unset("maxWidth") || unset("measure")) {
    if (p.maxWidth && !fixedWidth) out.push("width: 100%");
    const caps = [e.maxWidth, e.measure].filter((r): r is Ref => !!r).map(v);
    out.push(`max-width: ${caps.length > 1 ? `min(${caps.join(", ")})` : caps[0] ?? "none"}`);
    if (p.maxWidth) out.push("margin-inline: auto");
    else if (unset("maxWidth")) {
      // Back to the box's own width and inline margins.
      if (!e.width && !e.aspect) out.push("width: auto");
      const m = e.margin;
      const side = (r?: MarginSide) => (isAuto(r) ? "auto" : r ? v(r) : "0");
      out.push(`margin-left: ${side(m?.left)}`, `margin-right: ${side(m?.right)}`);
    }
  }
  if (p.width) {
    // fill: the full width of the parent. Not align-self: stretch, which in a grid or layer stretches
    // the height instead. fit: shrink-to-fit (its content's width, at most the parent's).
    if ("keyword" in p.width) out.push(`width: ${p.width.keyword === "fit" ? "fit-content" : p.width.keyword === "fill" ? "100%" : p.width.keyword}`, "align-self: auto", `flex: ${flexOf(true)}`);
    else out.push(`width: ${v(p.width)}`, "align-self: auto", `flex: ${flexOf(true)}`);
  } else if (unset("width")) out.push(`width: ${e.maxWidth || e.aspect ? "100%" : "auto"}`, `flex: ${flexOf(false)}`);
  // grow: flex-grow from a basis of 0 (equal shares) or auto (its own size); with a width it never
  // shrinks (unless shrink says so). Restated after a width in the same rule, whose flex would
  // otherwise switch it off.
  if (e.grow && (p.grow || p.width || unset("width") || p.shrink)) out.push(`flex: ${e.grow.value} ${e.shrink?.value ?? (e.width ? 0 : 1)} ${e.grow.basis === "zero" ? "0px" : "auto"}`);
  else if (unset("grow") || (p.shrink && !p.width && !unset("width"))) out.push(`flex: ${flexOf(!!e.width)}`);
  // min-height too: a column flex parent shorter than its content would otherwise shrink the box.
  // With a minHeight, the larger of the two (CSS's used height when both apply).
  const minOf = (h?: Ref, m?: Ref) => (h && m ? `max(${v(h)}, ${v(m)})` : h ? v(h) : m ? v(m) : "auto");
  if (p.height) out.push(`height: ${v(p.height)}`, `min-height: ${minOf(p.height, e.minHeight)}`);
  else if (unset("height")) out.push("height: auto", `min-height: ${minOf(undefined, e.minHeight)}`);
  if (p.minHeight && !p.height) out.push(`min-height: ${minOf(e.height, p.minHeight)}`);
  else if (unset("minHeight") && !p.height && !unset("height")) out.push(`min-height: ${minOf(e.height, undefined)}`);
  if (unset("aspect")) out.push("aspect-ratio: auto", ...(e.width || e.maxWidth ? [] : ["width: auto"]));
  // A height that replaces an aspect from a wider rule also undoes what aspect set.
  if (p.height && !p.aspect && ctx.aspectBefore) out.push("aspect-ratio: auto", ...(e.width || e.maxWidth ? [] : ["width: auto"]));
  // width: 100% + height: auto beat <img width/height> attributes, so the slot sizes the image.
  if (p.aspect)
    out.push(...(e.width || e.maxWidth ? [] : ["width: 100%"]), `aspect-ratio: ${p.aspect.raw}`, "height: auto", ...(ctx.height ? ["min-height: auto"] : []));
  if (p.fit) out.push(`object-fit: ${p.fit.value}`);
  if (p.overflow) out.push(`overflow-x: ${p.overflow.x}`, `overflow-y: ${p.overflow.y}`);
  if (p.contain) out.push(`contain: ${p.contain.raw}`);
  if (p.float) out.push(`float: ${p.float.value}`);
  if (p.clear) out.push(`clear: ${p.clear.value}`);
  if (p.root?.value) out.push("display: flow-root");
  if (p.part) {
    const DISPLAY = { caption: "table-caption", column: "table-column", "column-group": "table-column-group", header: "table-header-group", body: "table-row-group", footer: "table-footer-group", row: "table-row", cell: "table-cell" } as const;
    out.push(`display: ${DISPLAY[p.part.value]}`);
    if (p.part.value === "cell") out.push(`vertical-align: ${p.part.align ?? "baseline"}`);
    if (p.part.value === "caption") out.push(`caption-side: ${p.part.side ?? "top"}`);
  }
  if (p.position) {
    const ps = p.position;
    out.push(`position: ${ps.type}`, ...(["top", "right", "bottom", "left"] as const).map((k) => `${k}: ${ps[k] ? v(ps[k]!) : "auto"}`), ...(ps.height ? [`height: ${v(ps.height)}`] : []));
  }
  // A fixed-height text box centers its lines vertically. align-content on a block container keeps
  // inline formatting intact (display: flex would split <strong> etc. into separate items).
  if (p.height && ctx.leafText) out.push("align-content: center");
  if (p.text) {
    const role = model.text.get(p.text.name)!;
    if (role.font) out.push(`font-family: ${v(role.font)}`);
    out.push(
      `font-size: ${role.size.raw}`,
      `font-weight: ${role.weight}`,
      `line-height: ${role.lineHeight}`,
      `color: ${v(role.color)}`,
    );
    // Always set, never left to the reset: descendants (<p>, <a>, <strong>) inherit them.
    out.push(`letter-spacing: ${role.letterSpacing !== undefined ? `${role.letterSpacing}em` : "normal"}`);
    out.push(`text-transform: ${role.transform ?? "none"}`);
    if (role.style === "italic") out.push("font-style: italic");
    out.push(`overflow-wrap: ${role.wrap === "anywhere" || role.wrap === "break-word" ? role.wrap : "normal"}`);
    // white-space: nowrap; restated on the inline content (the reset sets white-space: normal on every element).
    if (role.wrap === "none" || ctx.nowrap) out.push(`white-space: ${role.wrap === "none" ? "nowrap" : "normal"}`);
    if (role.decoration) out.push(`text-decoration: ${role.decoration}`);
  }
  if (p.textAlign) out.push(`text-align: ${p.textAlign.value}`);
  // Last: its own alignment wins over the align-self: auto a width emits.
  if (p.place) {
    const pl = p.place;
    const SELF: Record<string, string> = { start: "start", center: "center", end: "end", stretch: "stretch" };
    out.push(`grid-row: ${pl.row ?? "auto"}`, `grid-column: ${pl.column ?? "auto"}`, ...(pl.align ? [`align-self: ${SELF[pl.align]}`] : []), ...(pl.justify ? [`justify-self: ${SELF[pl.justify]}`] : []));
  }
  return out;
}

function rule(selector: string, body: string[], indent = ""): string {
  if (!body.length) return "";
  return `${indent}${selector} {\n${body.map((d) => `${indent}  ${d};`).join("\n")}\n${indent}}\n`;
}

/** Rules for one element's props: its own rule, plus a child rule when it is a layer. */
function rules(model: Model, selector: string, p: Props, ctx: Ctx, indent = ""): string[] {
  const out = [rule(selector, decls(model, p, ctx), indent)];
  if (p.layout?.pattern === "layer") out.push(rule(`${selector} > *`, ["grid-area: 1 / 1"], indent));
  // An override that turns a layer into another pattern must release its children from the one cell.
  else if (p.layout && ctx.layerBefore) out.push(rule(`${selector} > *`, ["grid-area: auto"], indent));
  // A flow's children are blocks, whatever their tag (a <span> or <a> slot would otherwise be
  // inline). No specificity, so a child's own display (flex, grid) still wins.
  if (p.layout?.pattern === "flow") out.push(rule(`:where(${selector} > *)`, ["display: block"], indent));
  // A text box that never wraps: its inline content (<a>, <strong>) doesn't either (the reset sets white-space: normal on every element).
  if (p.text && ctx.leafText && model.text.get(p.text.name)!.wrap === "none") out.push(rule(`${selector} :where(*)`, ["white-space: inherit"], indent));
  return out.filter(Boolean);
}

/** Every token a component uses, in token declaration order (so output is stable). */
function usedTokens(model: Model, c: Component): string[] {
  const used = new Set<string>();
  const visit = (p: Props) => {
    const refs: (Ref | undefined)[] = [
      p.layout?.gap,
      p.layout?.rowGap,
      p.position?.top,
      p.position?.right,
      p.position?.bottom,
      p.position?.left,
      p.position?.height,
      p.layout?.min,
      ...(p.layout?.columns ?? []).map((t) => ("size" in t ? t.size : undefined)),
      p.padding?.top,
      p.padding?.right,
      p.padding?.bottom,
      p.padding?.left,
      isAuto(p.margin?.top) ? undefined : p.margin?.top,
      isAuto(p.margin?.right) ? undefined : p.margin?.right,
      isAuto(p.margin?.bottom) ? undefined : p.margin?.bottom,
      isAuto(p.margin?.left) ? undefined : p.margin?.left,
      p.background,
      p.backdrop,
      p.border?.color,
      p.border?.sides?.top,
      p.border?.sides?.right,
      p.border?.sides?.bottom,
      p.border?.sides?.left,
      p.shadow,
      p.radius,
      p.maxWidth,
      p.measure,
      p.width && !("keyword" in p.width) ? p.width : undefined,
      p.height,
      p.minHeight,
    ];
    for (const r of refs) if (r) used.add(tokenKey(r.kind, r.name));
    if (p.text) {
      const role = model.text.get(p.text.name)!;
      used.add(tokenKey("color", role.color.name));
      if (role.font) used.add(tokenKey("font", role.font.name));
    }
  };
  visit(c.props);
  for (const s of c.slots.values()) visit(s.props);
  for (const w of c.when) {
    visit(w.props);
    for (const s of w.slots.values()) visit(s);
  }
  return [...model.tokens.keys()].filter((k) => used.has(k));
}

const RESET = [
  "margin: 0",
  "padding: 0",
  "border: 0 solid",
  "box-sizing: border-box",
  "font: inherit",
  "color: inherit",
  "background: transparent",
  "font-kerning: normal",
  "word-spacing: normal",
  "text-indent: 0",
  "white-space: normal",
  "word-break: normal",
  "hyphens: manual",
  "list-style: none",
];

/** Compile a validated model to CSS. Pure and deterministic: same model, same bytes. */
export function compile(model: Model): string {
  const parts: string[] = [
    // No version here: the same source compiles to the same bytes across Cadesa releases.
    `/* Generated by Cadesa from ${basename(model.file)}. Edit the source, not this file. */\n`,
  ];
  if (model.page?.background) {
    const t = model.tokens.get(tokenKey("color", model.page.background.name))!;
    parts.push(rule(":root", [`${varName(model.page.background)}: ${t.raw}`, `background-color: ${v(model.page.background)}`]));
  }
  // The body's margin and padding, and the root element's insets (as its padding), each with its tokens.
  const pageRule = (sel: string, list: [string, PageSides | undefined][]) => {
    const refs = list.flatMap(([, s]) => (s ? [s.top, s.right, s.bottom, s.left] : [])).filter((r): r is Ref => !!r);
    const vars = [...new Map(refs.map((r) => [r.name, r])).values()].map((r) => `${varName(r)}: ${model.tokens.get(tokenKey(r.kind, r.name))!.raw}`);
    const decls = list.filter(([, s]) => s).map(([prop, s]) => `${prop}: ${[s!.top, s!.right, s!.bottom, s!.left].map((r) => (r ? v(r) : "0")).join(" ")}`);
    if (decls.length) parts.push(rule(sel, [...vars, ...decls]));
  };
  pageRule("html", [["padding", model.page?.outer]]);
  if (model.page?.clipX) parts.push(rule("html", ["overflow-x: hidden"]));
  pageRule("body", [["margin", model.page?.margin], ["padding", model.page?.padding]]);
  // Every reset comes first. A nested component's root rule (.ca-child) has the same specificity as
  // its parent's reset (.ca-parent :where(*)), so it must come later in the file to win.
  for (const c of model.components.values()) {
    const root = `.${model.prefix}${c.name}`;
    parts.push(rule(`${root},\n${root} :where(*)`, RESET));
  }
  for (const c of model.components.values()) {
    const root = `.${model.prefix}${c.name}`;
    const slotSel = (s: string) => `${root} .${model.prefix}${c.name}__${s}`;
    const header = c.intent ? `/* ${c.name}: ${c.intent.replace(/\*\//g, "* /")} */\n` : `/* ${c.name} */\n`;
    const vars = usedTokens(model, c).map((k) => {
      const t = model.tokens.get(k)!;
      return `${varName({ kind: t.category, name: t.name })}: ${t.raw}`;
    });
    // Overrides are sorted widest breakpoint first, so when override k applies, so do 0..k-1.
    const ctx = (slot: string | undefined, upTo: number): Ctx => {
      const states = [slot ? c.slots.get(slot)!.props : c.props, ...c.when.map((w) => (slot ? w.slots.get(slot) : w.props))];
      const all = states.filter(Boolean) as Props[];
      const eff: Props = {};
      for (const s of states.slice(0, upTo + 2))
        if (s) {
          Object.assign(eff, s);
          for (const k of Object.keys(s.unset ?? {})) delete eff[k as keyof Props];
        }
      delete eff.unset;
      return {
        leafText: all.some((p) => p.text) && !all.some((p) => p.layout),
        height: all.some((p) => p.height),
        layerBefore: states.slice(0, upTo + 1).some((s) => s?.layout?.pattern === "layer"),
        aspectBefore: states.slice(0, upTo + 1).some((s) => s?.aspect),
        eff,
        justify: all.some((p) => p.layout?.justify),
        nowrap: all.some((p) => p.text && model.text.get(p.text.name)!.wrap === "none"),
        rootBase: !slot && upTo === -1,
      };
    };
    const [rootRule, ...rootExtra] = rules(model, root, c.props, ctx(undefined, -1));
    const withVars = rule(root, [...vars, ...decls(model, c.props, ctx(undefined, -1))]);
    parts.push(header + (withVars || rootRule || ""), ...rootExtra);
    for (const s of c.slots.values()) parts.push(...rules(model, slotSel(s.name), s.props, ctx(s.name, -1)));

    c.when.forEach((w, k) => {
      const bp = model.breakpoints.find((b) => b.name === w.breakpoint)!;
      const inner = [
        ...rules(model, root, w.props, ctx(undefined, k), "  "),
        ...[...w.slots].flatMap(([s, p]) => rules(model, slotSel(s), p, ctx(s, k), "  ")),
      ];
      if (inner.length) parts.push(`@media (max-width: ${bp.length.raw}) {\n${inner.join("\n")}}\n`);
    });
  }
  return parts.filter(Boolean).join("\n");
}
