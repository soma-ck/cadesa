import { walk, type Box, type Issue, type Layout } from "./engine/layout.js";
import { isAuto, tokenKey, type MarginSide, type Model, type Props, type Unsettable } from "./model.js";
import { fmtPx, type Resolved, type ResolvedProps } from "./resolve.js";

export interface PropExplanation {
  prop: keyof ResolvedProps;
  value: string;
  chain: { kind: string; label: string; path: string }[];
  /** Breakpoint overrides that set this property for this element, active or not. */
  overrides: { breakpoint: string; query: string; active: boolean; value: string; path: string }[];
}

export interface Explanation {
  width: number;
  active: string[];
  id: string;
  tag: string;
  sourcePath: string;
  box: { x: number; y: number; w: number; h: number };
  props: PropExplanation[];
  lines?: { text: string; width: number }[];
  assumptions: string[];
  issues: Issue[];
}

const PROP_OF: Record<keyof ResolvedProps, keyof Props> = {
  pattern: "layout",
  gap: "layout",
  align: "layout",
  min: "layout",
  columns: "layout",
  rowGap: "layout",
  justifyItems: "layout",
  textAlign: "textAlign",
  aspect: "aspect",
  fit: "fit",
  backdrop: "backdrop",
  shadow: "shadow",
  padding: "padding",
  margin: "margin",
  background: "background",
  border: "border",
  radius: "radius",
  maxWidth: "maxWidth",
  measure: "measure",
  width: "width",
  height: "height",
  minHeight: "minHeight",
  text: "text",
  justify: "layout",
  wrap: "layout",
  grow: "grow",
  overflow: "overflow",
};

function describe(model: Model, p: Props, prop: keyof ResolvedProps): { value: string; path: string } | undefined {
  const key = PROP_OF[prop];
  const v = p[key];
  // An override that removes it (`maxWidth: none`).
  const removed = p.unset?.[key as Unsettable];
  if (removed !== undefined && !v) return { value: "none (removed)", path: removed };
  if (!v) return undefined;
  const tok = (r: { kind: string; name: string }) => {
    const t = model.tokens.get(tokenKey(r.kind, r.name))!;
    return `${r.name} (${t.px !== undefined ? `${fmtPx(t.px)}px` : t.raw})`;
  };
  switch (prop) {
    case "pattern":
      return { value: p.layout!.pattern, path: `${p.layout!.path}.pattern` };
    case "gap":
      return { value: p.layout!.gap ? tok(p.layout!.gap) : "0 (no gap)", path: p.layout!.path };
    case "align":
      return p.layout!.pattern === "stack" || p.layout!.pattern === "flow" ? undefined : { value: p.layout!.align ?? (p.layout!.pattern === "cluster" ? "center (default)" : "stretch (default)"), path: p.layout!.path };
    case "min":
      return p.layout!.min ? { value: tok(p.layout!.min), path: p.layout!.min.path } : undefined;
    case "aspect":
      return { value: p.aspect!.raw, path: p.aspect!.path };
    case "fit":
      return { value: p.fit!.value, path: p.fit!.path };
    case "overflow":
      return { value: p.overflow!.raw, path: p.overflow!.path };
    case "textAlign":
      return { value: p.textAlign!.value, path: p.textAlign!.path };
    case "padding": {
      const { top, right, bottom, left, path } = p.padding!;
      const side = (r?: { kind: string; name: string }) => (r ? tok(r) : "0");
      const value =
        top && [right, bottom, left].every((r) => r?.name === top.name)
          ? tok(top)
          : `top ${side(top)}, right ${side(right)}, bottom ${side(bottom)}, left ${side(left)}`;
      return { value, path };
    }
    case "margin": {
      const m = p.margin!;
      const side = (r?: MarginSide) => (isAuto(r) ? "auto" : r ? tok(r) : "0");
      return { value: `top ${side(m.top)}, right ${side(m.right)}, bottom ${side(m.bottom)}, left ${side(m.left)}`, path: m.path };
    }
    case "border": {
      const b = p.border!;
      if (!b.sides) return { value: `1px ${tok(b.color)}`, path: b.path };
      const side = (r?: { kind: string; name: string }) => (r ? tok(r) : "0");
      return { value: `${tok(b.color)}; top ${side(b.sides.top)}, right ${side(b.sides.right)}, bottom ${side(b.sides.bottom)}, left ${side(b.sides.left)}`, path: b.path };
    }
    case "wrap":
      return p.layout!.pattern === "cluster" ? { value: p.layout!.wrap === false ? "false (one line)" : "true (default)", path: p.layout!.path } : undefined;
    case "justify":
      return p.layout!.pattern === "cluster" ? { value: p.layout!.justify ?? "start (default)", path: p.layout!.path } : undefined;
    case "grow":
      return { value: `${p.grow!.value}${p.grow!.basis === "zero" ? " (from zero)" : ""}`, path: p.grow!.path };
    case "width":
      return "keyword" in p.width! ? { value: p.width!.keyword, path: p.width!.path } : { value: tok(p.width!), path: p.width!.path };
    case "text":
      return { value: p.text!.name, path: p.text!.path };
    default: {
      const r = v as { kind: string; name: string; path: string };
      return { value: tok(r), path: r.path };
    }
  }
}

export function explain(model: Model, layout: Layout, id: string): Explanation | undefined {
  const box: Box | undefined = [...walk(layout.boxes)].find((b) => b.id === id);
  if (!box) return undefined;
  const c = model.components.get(box.component)!;
  const props: PropExplanation[] = [];
  for (const prop of Object.keys(PROP_OF) as (keyof ResolvedProps)[]) {
    const r = box.props[prop] as Resolved<unknown> | undefined;
    const overrides = c.when.flatMap((ov) => {
      const p = box.slot === undefined ? ov.props : ov.slots.get(box.slot);
      const d = p && describe(model, p, prop);
      if (!d) return [];
      const bp = model.breakpoints.find((b) => b.name === ov.breakpoint)!;
      return [
        {
          breakpoint: bp.name,
          query: `max-width: ${bp.length.raw} (${fmtPx(bp.length.px)}px)`,
          active: layout.active.includes(bp.name),
          ...d,
        },
      ];
    });
    if (!r && !overrides.length) continue;
    props.push({
      prop,
      value: r ? r.display : "unset",
      chain: r ? r.steps.map((s) => ({ kind: s.kind, label: s.label, path: s.path })) : [],
      overrides,
    });
  }
  return {
    width: layout.width,
    active: layout.active,
    id: box.id,
    tag: box.tag,
    sourcePath: box.sourcePath,
    box: { x: box.x, y: box.y, w: box.w, h: box.h },
    props,
    lines: box.lines,
    assumptions: box.assumptions,
    issues: layout.issues.filter((i) => i.id === id || i.message.includes(`#${id} `)),
  };
}
