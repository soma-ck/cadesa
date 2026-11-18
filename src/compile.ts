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
  /** The element has a maxWidth in some state. */
  maxWidth: boolean;
}

function decls(model: Model, p: Props, ctx: Ctx): string[] {
  const out: string[] = [];
  if (p.layout) {
    const l = p.layout;
    const gap = `gap: ${l.gap ? v(l.gap) : "0"}`;
    if (l.pattern === "stack" || l.pattern === "cluster") {
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
  // background-color, not the shorthand: an override that changes only the color must not erase a backdrop.
  if (p.background) out.push(`background-color: ${v(p.background)}`);
  if (p.backdrop)
    out.push(`background-image: ${v(p.backdrop)}`, "background-size: cover", "background-position: center", "background-repeat: no-repeat");
  if (p.border) out.push(`border: 1px solid ${v(p.border)}`);
  if (p.shadow) out.push(`box-shadow: ${v(p.shadow)}`);
  if (p.radius) out.push(`border-radius: ${v(p.radius)}`);
  // max-width + auto margins. width: 100% so a flex or grid parent doesn't shrink-wrap the box
  // (auto margins switch off stretching).
  if (p.maxWidth) out.push(...(p.width && !("keyword" in p.width) ? [] : ["width: 100%"]), `max-width: ${v(p.maxWidth)}`, "margin-inline: auto");
  if (p.measure) out.push(`max-width: ${v(p.measure)}`);
  if (p.width) {
    if ("keyword" in p.width) out.push(ctx.maxWidth ? "width: 100%" : "width: auto", "align-self: stretch", "flex: none");
    else out.push(`width: ${v(p.width)}`, "align-self: auto", "flex: none");
  }
  if (p.height) out.push(`height: ${v(p.height)}`);
  // width: 100% + height: auto beat <img width/height> attributes, so the slot sizes the image.
  if (p.aspect) out.push(...(p.width || p.maxWidth ? [] : ["width: 100%"]), `aspect-ratio: ${p.aspect.raw}`, "height: auto");
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
    if (role.letterSpacing !== undefined) out.push(`letter-spacing: ${role.letterSpacing}em`);
    if (role.transform) out.push(`text-transform: ${role.transform}`);
    if (role.wrap) out.push(`overflow-wrap: ${role.wrap}`);
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
  "letter-spacing: normal",
  "word-spacing: normal",
  "text-indent: 0",
  "text-transform: none",
  "white-space: normal",
  "overflow-wrap: normal",
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
    const ctx = (slot?: string): Ctx => {
      const all = [slot ? c.slots.get(slot)!.props : c.props, ...c.when.map((w) => (slot ? w.slots.get(slot) : w.props)).filter(Boolean)] as Props[];
      return { leafText: all.some((p) => p.text) && !all.some((p) => p.layout), maxWidth: all.some((p) => p.maxWidth) };
    };
    const [rootRule, ...rootExtra] = rules(model, root, c.props, ctx());
    const withVars = rule(root, [...vars, ...decls(model, c.props, ctx())]);
    parts.push(header + (withVars || rootRule || ""), ...rootExtra);
    for (const s of c.slots.values()) parts.push(...rules(model, slotSel(s.name), s.props, ctx(s.name)));

    for (const w of c.when) {
      const bp = model.breakpoints.find((b) => b.name === w.breakpoint)!;
      const inner = [
        ...rules(model, root, w.props, ctx(), "  "),
        ...[...w.slots].flatMap(([s, p]) => rules(model, slotSel(s), p, ctx(s), "  ")),
      ];
      if (inner.length) parts.push(`@media (max-width: ${bp.length.raw}) {\n${inner.join("\n")}}\n`);
    }
  }
  return parts.filter(Boolean).join("\n");
}
