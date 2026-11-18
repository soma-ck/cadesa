import { parse as parseYaml } from "yaml";
import { CadesaError, type Diagnostic } from "./diagnostics.js";
import { layout, walk, type Box, type Issue, type Layout } from "./engine/layout.js";
import type { Fixture } from "./fixture.js";
import type { Source } from "./load.js";
import type { Model } from "./model.js";
import type { Resolved, ResolvedProps } from "./resolve.js";
import { validate } from "./validate.js";

export function modelOf(src: Source): Model {
  const { model, diagnostics } = validate(src);
  if (!model) throw new CadesaError(diagnostics);
  return model;
}

export function render(model: Model, fixture: Fixture, widths: number[]): Layout[] {
  return widths.map((w) => layout(model, fixture, w));
}

// ---------------------------------------------------------------- whatif

export interface Change {
  path: string;
  value: unknown;
}

export function parseSet(spec: string): Change {
  const i = spec.indexOf("=");
  if (i <= 0) throw new Error(`--set expects path=value, got "${spec}"`);
  return { path: spec.slice(0, i).trim(), value: parseYaml(spec.slice(i + 1)) };
}

function getIn(data: unknown, segs: string[]): unknown {
  let cur = data;
  for (const s of segs) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[s] : undefined;
  return cur;
}

function setIn(data: Record<string, unknown>, segs: string[], value: unknown) {
  let cur = data;
  for (const s of segs.slice(0, -1)) {
    if (!cur[s] || typeof cur[s] !== "object") cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

export interface PropDiff {
  prop: keyof ResolvedProps;
  from?: Resolved<unknown>;
  to?: Resolved<unknown>;
}

export interface ElementDiff {
  id: string;
  sourcePath: string;
  geometry: { key: "x" | "y" | "w" | "h"; from: number; to: number }[];
  props: PropDiff[];
}

export interface WidthDiff {
  width: number;
  activeBefore: string[];
  activeAfter: string[];
  elements: ElementDiff[];
  issuesBefore: Issue[];
  issuesAfter: Issue[];
}

export interface WhatIf {
  changes: { path: string; from: unknown; to: unknown }[];
  widths: WidthDiff[];
}

const PROPS: (keyof ResolvedProps)[] = [
  "pattern",
  "align",
  "min",
  "textAlign",
  "aspect",
  "fit",
  "backdrop",
  "shadow",
  "gap",
  "padding",
  "background",
  "border",
  "radius",
  "maxWidth",
  "measure",
  "width",
  "height",
  "text",
];

const sig = (r?: Resolved<unknown>) => (r ? JSON.stringify([r.value, r.steps.map((s) => s.path)]) : "");

export function diffLayouts(a: Layout, b: Layout): WidthDiff {
  const before = new Map<string, Box>([...walk(a.boxes)].map((x) => [x.id, x]));
  const elements: ElementDiff[] = [];
  for (const nb of walk(b.boxes)) {
    const ob = before.get(nb.id);
    if (!ob) continue;
    const geometry = (["x", "y", "w", "h"] as const)
      .filter((k) => Math.abs(ob[k] - nb[k]) > 0.001)
      .map((k) => ({ key: k, from: ob[k], to: nb[k] }));
    const props = PROPS.filter((p) => sig(ob.props[p]) !== sig(nb.props[p])).map((p) => ({
      prop: p,
      from: ob.props[p] as Resolved<unknown> | undefined,
      to: nb.props[p] as Resolved<unknown> | undefined,
    }));
    if (geometry.length || props.length) elements.push({ id: nb.id, sourcePath: nb.sourcePath, geometry, props });
  }
  return {
    width: a.width,
    activeBefore: a.active,
    activeAfter: b.active,
    elements,
    issuesBefore: a.issues,
    issuesAfter: b.issues,
  };
}

/** Apply edits to the source in memory and report what moves at every width. Nothing is written. */
export function whatif(src: Source, fixture: Fixture, widths: number[], changes: Change[]): WhatIf {
  const before = modelOf(src);
  const data = structuredClone(src.data) as Record<string, unknown>;
  const applied = changes.map((c) => {
    const segs = c.path.split(".");
    const from = getIn(data, segs);
    setIn(data, segs, c.value);
    return { path: c.path, from, to: c.value };
  });
  const after = modelOf({ ...src, data });
  return {
    changes: applied,
    widths: widths.map((w) => diffLayouts(layout(before, fixture, w), layout(after, fixture, w))),
  };
}

export type { Diagnostic };
