import {
  PROP_ORDER,
  tokenKey,
  type Breakpoint,
  type Component,
  type Model,
  type Pattern,
  type Props,
  type Ref,
} from "./model.js";

/** One link in the chain that explains where a computed value came from. */
export interface Step {
  kind: "token" | "text" | "when" | "source";
  label: string;
  path: string;
}

export interface Resolved<T> {
  value: T;
  display: string;
  /** Most specific first: token → active breakpoint → the YAML field to edit. */
  steps: Step[];
}

export interface ResolvedText {
  role: string;
  font?: string;
  sizePx: number;
  weight: number;
  lineHeight: number;
  color: string;
  /** px */
  letterSpacing: number;
  uppercase: boolean;
}

export interface ResolvedProps {
  pattern?: Resolved<Pattern>;
  min?: Resolved<number>;
  aspect?: Resolved<number>;
  fit?: Resolved<"cover" | "contain">;
  backdrop?: Resolved<string>;
  shadow?: Resolved<string>;
  align?: Resolved<"start" | "center" | "end" | "stretch">;
  textAlign?: Resolved<"start" | "center" | "end">;
  gap?: Resolved<number>;
  padding?: Resolved<{ block: number; inline: number }>;
  background?: Resolved<string>;
  border?: Resolved<string>;
  radius?: Resolved<number>;
  maxWidth?: Resolved<number>;
  measure?: Resolved<number>;
  width?: Resolved<number | "fill">;
  height?: Resolved<number>;
  text?: Resolved<ResolvedText>;
}

export const fmtPx = (n: number) => `${Math.round(n * 100) / 100}`;

export function activeBreakpoints(model: Model, width: number): Breakpoint[] {
  return model.breakpoints.filter((b) => width <= b.length.px);
}

export function resolveElement(model: Model, component: Component, slot: string | undefined, width: number): ResolvedProps {
  const active = new Set(activeBreakpoints(model, width).map((b) => b.name));
  const layers: { props: Props; when?: Step }[] = [];
  const base = slot === undefined ? component.props : component.slots.get(slot)?.props;
  if (base) layers.push({ props: base });
  for (const ov of component.when) {
    if (!active.has(ov.breakpoint)) continue;
    const props = slot === undefined ? ov.props : ov.slots.get(slot);
    if (!props) continue;
    const bp = model.breakpoints.find((b) => b.name === ov.breakpoint)!;
    layers.push({
      props,
      when: { kind: "when", label: `when.${bp.name} (${width}px ≤ ${fmtPx(bp.length.px)}px)`, path: bp.path },
    });
  }

  const out: ResolvedProps = {};
  for (const key of PROP_ORDER) {
    let layer: (typeof layers)[number] | undefined;
    for (const l of layers) if (l.props[key] !== undefined) layer = l;
    if (!layer) continue;
    const pre = layer.when ? [layer.when] : [];
    const src = (path: string): Step => ({ kind: "source", label: path, path });

    const tokenStep = (r: Ref): Step => {
      const t = model.tokens.get(tokenKey(r.kind, r.name))!;
      return { kind: "token", label: `${r.kind}.${r.name} = ${t.raw}`, path: t.path };
    };
    const lengthOf = (r: Ref): Resolved<number> => {
      const t = model.tokens.get(tokenKey(r.kind, r.name))!;
      return { value: t.px!, display: `${fmtPx(t.px!)}px`, steps: [tokenStep(r), ...pre, src(r.path)] };
    };
    const colorOf = (r: Ref): Resolved<string> => {
      const t = model.tokens.get(tokenKey(r.kind, r.name))!;
      return { value: t.raw, display: t.raw, steps: [tokenStep(r), ...pre, src(r.path)] };
    };

    const p = layer.props;
    switch (key) {
      case "layout": {
        const l = p.layout!;
        out.pattern = { value: l.pattern, display: l.pattern, steps: [...pre, src(`${l.path}.pattern`)] };
        out.gap = l.gap ? lengthOf(l.gap) : { value: 0, display: "0px (no gap)", steps: [...pre, src(l.path)] };
        if (l.pattern !== "stack") {
          const def = l.pattern === "cluster" ? "center" : "stretch";
          const a = l.align ?? def;
          out.align = { value: a, display: l.align ? a : `${def} (default)`, steps: [...pre, src(l.align ? `${l.path}.align` : l.path)] };
        }
        if (l.min) out.min = lengthOf(l.min);
        break;
      }
      case "textAlign": {
        const t = p.textAlign!;
        out.textAlign = { value: t.value, display: t.value, steps: [...pre, src(t.path)] };
        break;
      }
      case "padding": {
        const { block, inline, path } = p.padding!;
        const b = block ? lengthOf(block) : undefined;
        const i = inline ? lengthOf(inline) : undefined;
        const value = { block: b?.value ?? 0, inline: i?.value ?? 0 };
        const tokens = [b, i].filter((x) => x).map((x) => x!.steps[0]);
        out.padding = {
          value,
          display: value.block === value.inline ? `${fmtPx(value.block)}px` : `${fmtPx(value.block)}px ${fmtPx(value.inline)}px`,
          steps: [...tokens.filter((t, k) => tokens.findIndex((u) => u.path === t.path) === k), ...pre, src(path)],
        };
        break;
      }
      case "radius":
      case "measure":
      case "maxWidth":
      case "height":
        out[key] = lengthOf(p[key]!);
        break;
      case "background":
      case "border":
        out[key] = colorOf(p[key]!);
        break;
      case "backdrop":
      case "shadow": {
        const r = p[key]!;
        const t = model.tokens.get(tokenKey(r.kind, r.name))!;
        out[key] = { value: t.raw, display: `${r.name}`, steps: [tokenStep(r), ...pre, src(r.path)] };
        break;
      }
      case "aspect": {
        const a = p.aspect!;
        out.aspect = { value: a.value, display: a.raw, steps: [...pre, src(a.path)] };
        break;
      }
      case "fit": {
        const f = p.fit!;
        out.fit = { value: f.value, display: f.value, steps: [...pre, src(f.path)] };
        break;
      }
      case "width": {
        const w = p.width!;
        out.width =
          "keyword" in w
            ? { value: "fill", display: "fill", steps: [...pre, src(w.path)] }
            : lengthOf(w);
        break;
      }
      case "text": {
        const r = p.text!;
        const role = model.text.get(r.name)!;
        const color = model.tokens.get(tokenKey("color", role.color.name))!;
        const font = role.font ? model.tokens.get(tokenKey("font", role.font.name))!.raw : undefined;
        out.text = {
          value: {
            role: role.name,
            font,
            sizePx: role.size.px,
            weight: role.weight,
            lineHeight: role.lineHeight,
            color: color.raw,
            letterSpacing: (role.letterSpacing ?? 0) * role.size.px,
            uppercase: role.transform === "uppercase",
          },
          display: `${role.name} (${fmtPx(role.size.px)}px/${role.lineHeight}, ${role.weight})`,
          steps: [{ kind: "text", label: `text.${role.name}`, path: role.path }, ...pre, src(r.path)],
        };
        break;
      }
    }
  }
  return out;
}

export function explainChain(r: Resolved<unknown>): string {
  return [r.display, ...r.steps.map((s) => s.label)].join(" ← ");
}
