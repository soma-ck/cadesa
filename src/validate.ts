import { closest, type Diagnostic } from "./diagnostics.js";
import type { PathSeg, Source } from "./load.js";
import {
  DEFAULT_PREFIX,
  LENGTH_CATEGORIES,
  PROP_ORDER,
  ROOT_FONT_PX,
  TOKEN_CATEGORIES,
  tokenKey,
  type Breakpoint,
  type Component,
  type Length,
  type Model,
  type Override,
  type Props,
  type Ref,
  type Slot,
  type TextRole,
  type Token,
  type TokenCategory,
} from "./model.js";

const IDENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const LENGTH = /^(?:\d+(?:\.\d+)?|\.\d+)(rem|px)$/;
const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const IDENT_HELP = "a lowercase kebab-case name, e.g. section-title";

const TOP_KEYS = ["version", "prefix", "tokens", "text", "breakpoints", "styles"];
const PREFIX = /^(?:[a-z][a-z0-9]*-)?$/;
const TEXT_KEYS = ["font", "size", "weight", "lineHeight", "color"];
const ROOT_PROPS = PROP_ORDER as string[];
const SLOT_PROPS = ROOT_PROPS.filter((p) => p !== "maxWidth");

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const show = (v: unknown) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));

export function parseLength(raw: string): Length {
  const m = LENGTH.exec(raw)!;
  const n = parseFloat(raw);
  return { raw, px: m[1] === "rem" ? n * ROOT_FONT_PX : n };
}

export function validate(src: Source): { model?: Model; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [...src.parseErrors];
  if (diagnostics.length) return { diagnostics };

  const err = (
    path: PathSeg[],
    message: string,
    extra: { expected?: string; got?: unknown; suggestion?: string; key?: boolean } = {},
  ) => {
    diagnostics.push({
      severity: "error",
      file: src.file,
      path: path.join("."),
      ...src.locate(path, { key: extra.key }),
      message,
      expected: extra.expected,
      got: extra.got === undefined ? undefined : show(extra.got),
      suggestion: extra.suggestion,
    });
  };

  const obj = (v: unknown, path: PathSeg[], what: string): Obj | undefined => {
    if (isObj(v)) return v;
    err(path, `expected ${what}`, { expected: "a mapping", got: v });
    return undefined;
  };

  const keys = (o: Obj, path: PathSeg[], allowed: string[]) => {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k))
        err([...path, k], `unknown key "${k}"`, {
          expected: `one of ${allowed.join(", ")}`,
          suggestion: closest(k, allowed),
          key: true,
        });
    }
  };

  const ident = (name: string, path: PathSeg[]) => {
    if (IDENT.test(name)) return true;
    err(path, `invalid name "${name}"`, { expected: IDENT_HELP, key: true });
    return false;
  };

  const data = src.data;
  const top = obj(data, [], "a Cascadio document");
  if (!top) return { diagnostics };
  keys(top, [], TOP_KEYS);
  if (top.version !== 1) err(["version"], "unsupported or missing version", { expected: "1", got: top.version });
  if (top.prefix !== undefined && (typeof top.prefix !== "string" || !PREFIX.test(top.prefix)))
    err(["prefix"], "invalid class prefix", { expected: 'a lowercase prefix ending in "-", or "" for none (default "ca-")', got: top.prefix });

  // ---- tokens
  const tokens = new Map<string, Token>();
  const tokensObj = top.tokens === undefined ? {} : obj(top.tokens, ["tokens"], "token categories");
  if (tokensObj) {
    keys(tokensObj, ["tokens"], TOKEN_CATEGORIES);
    for (const category of TOKEN_CATEGORIES) {
      const catPath = ["tokens", category];
      const cat = tokensObj[category] === undefined ? undefined : obj(tokensObj[category], catPath, `${category} tokens`);
      if (!cat) continue;
      for (const [name, value] of Object.entries(cat)) {
        const path = [...catPath, name];
        if (!ident(name, path)) continue;
        if (LENGTH_CATEGORIES.has(category)) {
          if (typeof value !== "string" || !LENGTH.test(value)) {
            err(path, `invalid ${category} length`, { expected: "a length in rem or px, e.g. 1.5rem", got: value });
            continue;
          }
          tokens.set(tokenKey(category, name), { category, name, path: path.join("."), raw: value, px: parseLength(value).px });
        } else if (category === "color") {
          if (typeof value !== "string" || !COLOR.test(value)) {
            err(path, "invalid color", { expected: 'a hex color, e.g. "#191b20"', got: value });
            continue;
          }
          tokens.set(tokenKey(category, name), { category, name, path: path.join("."), raw: value.toLowerCase() });
        } else {
          if (typeof value !== "string" || !value.trim()) {
            err(path, "invalid font", { expected: "a font-family list string", got: value });
            continue;
          }
          tokens.set(tokenKey(category, name), { category, name, path: path.join("."), raw: value.trim() });
        }
      }
    }
  }

  const text = new Map<string, TextRole>();

  const ref = (value: unknown, path: PathSeg[], kind: TokenCategory | "text"): Ref | undefined => {
    const names =
      kind === "text"
        ? [...text.keys()]
        : [...tokens.values()].filter((t) => t.category === kind).map((t) => t.name);
    const label = kind === "text" ? "text role" : `${kind} token`;
    const expected = names.length ? `one of ${names.join(", ")}` : `a ${label}, but none are defined`;
    if (typeof value !== "string") {
      err(path, `expected a ${label} name`, { expected, got: value });
      return undefined;
    }
    if (!names.includes(value)) {
      err(path, `unknown ${label} "${value}"`, { expected, got: value, suggestion: closest(value, names) });
      return undefined;
    }
    return { kind, name: value, path: path.join(".") };
  };

  // ---- text roles
  const textObj = top.text === undefined ? {} : obj(top.text, ["text"], "text roles");
  if (textObj) {
    for (const [name, value] of Object.entries(textObj)) {
      const path = ["text", name];
      if (!ident(name, path)) continue;
      const role = obj(value, path, "a text role");
      if (!role) continue;
      keys(role, path, TEXT_KEYS);
      let ok = true;
      for (const req of ["size", "weight", "lineHeight", "color"])
        if (role[req] === undefined) {
          err(path, `missing required key "${req}"`, { expected: TEXT_KEYS.join(", ") });
          ok = false;
        }
      if (!ok) continue;
      if (typeof role.size !== "string" || !LENGTH.test(role.size)) {
        err([...path, "size"], "invalid font size", { expected: "a length in rem or px", got: role.size });
        ok = false;
      }
      if (typeof role.weight !== "number" || !Number.isInteger(role.weight) || role.weight < 1 || role.weight > 1000) {
        err([...path, "weight"], "invalid font weight", { expected: "an integer from 1 to 1000", got: role.weight });
        ok = false;
      }
      if (typeof role.lineHeight !== "number" || role.lineHeight <= 0) {
        err([...path, "lineHeight"], "invalid line height", { expected: "a unitless number > 0, e.g. 1.5", got: role.lineHeight });
        ok = false;
      }
      const color = ref(role.color, [...path, "color"], "color");
      const font = role.font === undefined ? undefined : ref(role.font, [...path, "font"], "font");
      if (!ok || !color || (role.font !== undefined && !font)) continue;
      text.set(name, {
        name,
        path: path.join("."),
        font,
        size: parseLength(role.size as string),
        weight: role.weight as number,
        lineHeight: role.lineHeight as number,
        color,
      });
    }
  }

  // ---- breakpoints
  const breakpoints: Breakpoint[] = [];
  const bpObj = top.breakpoints === undefined ? {} : obj(top.breakpoints, ["breakpoints"], "breakpoints");
  if (bpObj) {
    for (const [name, value] of Object.entries(bpObj)) {
      const path = ["breakpoints", name];
      if (!ident(name, path)) continue;
      if (typeof value !== "string" || !LENGTH.test(value)) {
        err(path, "invalid breakpoint", { expected: "a max-width length in rem or px, e.g. 36rem", got: value });
        continue;
      }
      breakpoints.push({ name, path: path.join("."), length: parseLength(value) });
    }
  }

  // ---- props
  const props = (o: Obj, path: PathSeg[], allowed: string[]): Props => {
    const out: Props = {};
    for (const key of allowed) {
      const v = o[key];
      if (v === undefined) continue;
      const p = [...path, key];
      switch (key) {
        case "layout": {
          const l = obj(v, p, "a layout");
          if (!l) break;
          keys(l, p, ["pattern", "gap"]);
          if (l.pattern !== "stack" && l.pattern !== "cluster") {
            err([...p, "pattern"], l.pattern === undefined ? 'missing required key "pattern"' : "unsupported layout pattern", {
              expected: "stack or cluster",
              got: l.pattern,
              suggestion: typeof l.pattern === "string" ? closest(l.pattern, ["stack", "cluster"]) : undefined,
            });
            break;
          }
          const gap = l.gap === undefined ? undefined : ref(l.gap, [...p, "gap"], "space");
          if (l.gap !== undefined && !gap) break;
          out.layout = { path: p.join("."), pattern: l.pattern, gap };
          break;
        }
        case "padding": {
          if (isObj(v)) {
            keys(v, p, ["block", "inline"]);
            const block = v.block === undefined ? undefined : ref(v.block, [...p, "block"], "space");
            const inline = v.inline === undefined ? undefined : ref(v.inline, [...p, "inline"], "space");
            if (v.block === undefined && v.inline === undefined)
              err(p, "empty padding", { expected: "a space token, or { block, inline } space tokens" });
            else if ((v.block === undefined || block) && (v.inline === undefined || inline))
              out.padding = { path: p.join("."), block, inline };
          } else {
            const r = ref(v, p, "space");
            if (r) out.padding = { path: p.join("."), block: r, inline: r };
          }
          break;
        }
        case "background":
          out.background = ref(v, p, "color");
          break;
        case "border":
          out.border = ref(v, p, "color");
          break;
        case "radius":
          out.radius = ref(v, p, "radius");
          break;
        case "maxWidth":
          out.maxWidth = ref(v, p, "size");
          break;
        case "height":
          out.height = ref(v, p, "size");
          break;
        case "text":
          out.text = ref(v, p, "text");
          break;
        case "width":
          out.width = v === "fill" ? { keyword: "fill", path: p.join(".") } : ref(v, p, "size");
          break;
      }
    }
    return out;
  };

  // ---- styles
  const components = new Map<string, Component>();
  const stylesObj = top.styles === undefined ? {} : obj(top.styles, ["styles"], "component styles");
  if (stylesObj) {
    for (const [name, value] of Object.entries(stylesObj)) {
      const path = ["styles", name];
      if (!ident(name, path)) continue;
      const c = obj(value, path, "a component style");
      if (!c) continue;
      keys(c, path, ["intent", "slots", "when", ...ROOT_PROPS]);
      if (c.intent !== undefined && typeof c.intent !== "string")
        err([...path, "intent"], "invalid intent", { expected: "a sentence describing the design intent", got: c.intent });

      const slots = new Map<string, Slot>();
      const slotsObj = c.slots === undefined ? {} : obj(c.slots, [...path, "slots"], "slots");
      for (const [slotName, slotValue] of Object.entries(slotsObj ?? {})) {
        const sp = [...path, "slots", slotName];
        if (!ident(slotName, sp)) continue;
        const so = obj(slotValue, sp, "slot props");
        if (!so) continue;
        keys(so, sp, SLOT_PROPS);
        slots.set(slotName, { name: slotName, path: sp.join("."), props: props(so, sp, SLOT_PROPS) });
      }

      const when: Override[] = [];
      const whenObj = c.when === undefined ? {} : obj(c.when, [...path, "when"], "breakpoint overrides");
      const bpNames = breakpoints.map((b) => b.name);
      for (const [bp, ov] of Object.entries(whenObj ?? {})) {
        const wp = [...path, "when", bp];
        if (!bpNames.includes(bp)) {
          err(wp, `unknown breakpoint "${bp}"`, {
            expected: bpNames.length ? `one of ${bpNames.join(", ")}` : "a breakpoint, but none are defined",
            suggestion: closest(bp, bpNames),
            key: true,
          });
          continue;
        }
        const o = obj(ov, wp, "overrides");
        if (!o) continue;
        keys(o, wp, ["slots", ...ROOT_PROPS]);
        const slotOverrides = new Map<string, Props>();
        const so = o.slots === undefined ? {} : obj(o.slots, [...wp, "slots"], "slot overrides");
        for (const [slotName, slotValue] of Object.entries(so ?? {})) {
          const sp = [...wp, "slots", slotName];
          if (!slots.has(slotName)) {
            err(sp, `override for unknown slot "${slotName}"`, {
              expected: `a slot declared in ${[...path, "slots"].join(".")}: ${[...slots.keys()].join(", ")}`,
              suggestion: closest(slotName, slots.keys()),
              key: true,
            });
            continue;
          }
          const sv = obj(slotValue, sp, "slot overrides");
          if (!sv) continue;
          keys(sv, sp, SLOT_PROPS);
          slotOverrides.set(slotName, props(sv, sp, SLOT_PROPS));
        }
        when.push({ breakpoint: bp, path: wp.join("."), props: props(o, wp, ROOT_PROPS), slots: slotOverrides });
      }
      // Overrides apply in breakpoint declaration order, matching the emitted @media order.
      when.sort((a, b) => bpNames.indexOf(a.breakpoint) - bpNames.indexOf(b.breakpoint));

      components.set(name, {
        name,
        path: path.join("."),
        intent: typeof c.intent === "string" ? c.intent : undefined,
        props: props(c, path, ROOT_PROPS),
        slots,
        when,
      });
    }
  }

  if (diagnostics.length) return { diagnostics };
  const prefix = typeof top.prefix === "string" ? top.prefix : DEFAULT_PREFIX;
  return { model: { file: src.file, prefix, tokens, text, breakpoints, components }, diagnostics };
}
