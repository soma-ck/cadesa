import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { tokenKey, type Component, type Model, type Props, type Ref } from "./model.js";

/** The package version, read from package.json (works from src/ under tsx and from lib/). */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const varName = (r: { kind: string; name: string }) => `--ca-${r.kind}-${r.name}`;
const v = (r: Ref) => `var(${varName(r)})`;

const FLEX_ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" } as const;
const GRID_ALIGN = { start: "start", center: "center", end: "end", stretch: "stretch" } as const;

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
}

function decls(model: Model, p: Props, ctx: Ctx): string[] {
  const out: string[] = [];
  // A root without a layout is a block, whatever its tag: the engine never lays out inline boxes.
  if (ctx.rootBase && !p.layout) out.push("display: block");
  if (p.layout) {
    const l = p.layout;
    const gap = `gap: ${l.gap ? v(l.gap) : "0"}`;
    // Block flow: children stack in normal flow and their vertical margins collapse.
    if (l.pattern === "flow") out.push("display: block");
    else if (l.pattern === "stack" || l.pattern === "cluster") {
      const stack = l.pattern === "stack";
      out.push(
        "display: flex",
        `flex-direction: ${stack ? "column" : "row"}`,
        `flex-wrap: ${stack ? "nowrap" : "wrap"}`,
        `align-items: ${stack ? "stretch" : FLEX_ALIGN[l.align ?? "center"]}`,
        gap,
      );
    } else {
      // grid: columns auto-fill the row, each at least `min` (never wider than the row) and sharing
      // what's left equally. layer: one cell; every child is placed in it (see the child rule).
      out.push(
        "display: grid",
        l.pattern === "grid"
          ? `grid-template-columns: repeat(auto-fill, minmax(min(${v(l.min!)}, 100%), 1fr))`
          : "grid-template-columns: minmax(0, 1fr)",
        `align-items: ${GRID_ALIGN[l.align ?? "stretch"]}`,
        "justify-items: stretch",
        l.pattern === "grid" ? gap : "gap: 0",
      );
    }
  }
  if (p.padding) {
    const { block, inline } = p.padding;
    out.push(
      block && inline && block.name === inline.name
        ? `padding: ${v(block)}`
        : `padding: ${block ? v(block) : "0"} ${inline ? v(inline) : "0"}`,
    );
  }
  if (p.margin) {
    // Every side, so an override replaces the whole margin. With maxWidth (margin-inline: auto),
    // only top and bottom: the validator rejects inline margins next to it.
    const side = (r?: Ref) => (r ? v(r) : "0");
    const m = p.margin;
    if (ctx.eff.maxWidth) out.push(`margin-top: ${side(m.top)}`, `margin-bottom: ${side(m.bottom)}`);
    else out.push(`margin: ${side(m.top)} ${side(m.right)} ${side(m.bottom)} ${side(m.left)}`);
  }
  // background-color, not the shorthand: an override that changes only the color must not erase a backdrop.
  if (p.background) out.push(`background-color: ${v(p.background)}`);
  if (p.backdrop)
    out.push(`background-image: ${v(p.backdrop)}`, "background-size: cover", "background-position: center", "background-repeat: no-repeat");
  if (p.border) out.push(`border: 1px solid ${v(p.border)}`);
  if (p.shadow) out.push(`box-shadow: ${v(p.shadow)}`);
  if (p.radius) out.push(`border-radius: ${v(p.radius)}`);
  // max-width + auto margins. width: 100% so a flex or grid parent doesn't shrink-wrap the box
  // (auto margins switch off stretching). maxWidth and measure share max-width: when both apply
  // (in this rule or merged from an earlier one), the smaller wins.
  const e = ctx.eff;
  const fixedWidth = !!e.width && !("keyword" in e.width);
  if (p.maxWidth || p.measure) {
    if (p.maxWidth && !fixedWidth) out.push("width: 100%");
    const caps = [e.maxWidth, e.measure].filter((r): r is Ref => !!r).map(v);
    out.push(`max-width: ${caps.length > 1 ? `min(${caps.join(", ")})` : caps[0]}`);
    if (p.maxWidth) out.push("margin-inline: auto");
  }
  if (p.width) {
    // fill: the full width of the parent. Not align-self: stretch, which in a grid or layer stretches
    // the height instead.
    if ("keyword" in p.width) out.push("width: 100%", "align-self: auto", "flex: none");
    else out.push(`width: ${v(p.width)}`, "align-self: auto", "flex: none");
  }
  // min-height too: a column flex parent shorter than its content would otherwise shrink the box.
  if (p.height) out.push(`height: ${v(p.height)}`, `min-height: ${v(p.height)}`);
  // A height that replaces an aspect from a wider rule also undoes what aspect set.
  if (p.height && !p.aspect && ctx.aspectBefore) out.push("aspect-ratio: auto", ...(e.width || e.maxWidth ? [] : ["width: auto"]));
  // width: 100% + height: auto beat <img width/height> attributes, so the slot sizes the image.
  if (p.aspect)
    out.push(...(e.width || e.maxWidth ? [] : ["width: 100%"]), `aspect-ratio: ${p.aspect.raw}`, "height: auto", ...(ctx.height ? ["min-height: auto"] : []));
  if (p.fit) out.push(`object-fit: ${p.fit.value}`);
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
    out.push(`overflow-wrap: ${role.wrap ?? "normal"}`);
    if (role.decoration) out.push(`text-decoration: ${role.decoration}`);
  }
  if (p.textAlign) out.push(`text-align: ${p.textAlign.value}`);
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
  return out.filter(Boolean);
}

/** Every token a component uses, in token declaration order (so output is stable). */
function usedTokens(model: Model, c: Component): string[] {
  const used = new Set<string>();
  const visit = (p: Props) => {
    const refs: (Ref | undefined)[] = [
      p.layout?.gap,
      p.layout?.min,
      p.padding?.block,
      p.padding?.inline,
      p.margin?.top,
      p.margin?.right,
      p.margin?.bottom,
      p.margin?.left,
      p.background,
      p.backdrop,
      p.border,
      p.shadow,
      p.radius,
      p.maxWidth,
      p.measure,
      p.width && !("keyword" in p.width) ? p.width : undefined,
      p.height,
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
      for (const s of states.slice(0, upTo + 2)) if (s) Object.assign(eff, s);
      return {
        leafText: all.some((p) => p.text) && !all.some((p) => p.layout),
        height: all.some((p) => p.height),
        layerBefore: states.slice(0, upTo + 1).some((s) => s?.layout?.pattern === "layer"),
        aspectBefore: states.slice(0, upTo + 1).some((s) => s?.aspect),
        eff,
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
