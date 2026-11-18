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
  type LayoutProp,
  type Model,
  type Override,
  type Props,
  type Ref,
  type Slot,
  type TextRole,
  type Token,
  type TokenCategory,
} from "./model.js";

// kebab-case or camelCase; no underscores (BEM's "__" separates component and slot).
const IDENT = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;
const LENGTH = /^(?:\d+(?:\.\d+)?|\.\d+)(rem|px)$/;
const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const IDENT_HELP = "a name of letters, digits and hyphens starting with a letter, e.g. section-title or sectionTitle";

/** Lengths as people write them: "1.5rem", "16px", 16 (px), "16" (px). Returns CSS ("16px") or undefined. */
function asLength(v: unknown): string | undefined {
  if (typeof v === "number" && v >= 0 && isFinite(v)) return `${v}px`;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (LENGTH.test(t)) return t;
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t)) return `${t}px`;
  return undefined;
}

const NAMED_COLORS: Record<string, string> = { white: "#ffffff", black: "#000000", transparent: "#00000000" };

/** Colors as people write them: hex, rgb()/rgba(), white/black/transparent. Returns lowercase hex. */
function asColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (COLOR.test(s)) return s;
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  const m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+(\d*\.?\d+%?))?\s*\)$/.exec(s);
  if (!m) return undefined;
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return `#${h(+m[1])}${h(+m[2])}${h(+m[3])}${a >= 1 ? "" : h(a * 255)}`;
}

const TOP_KEYS = ["version", "prefix", "tokens", "text", "breakpoints", "page", "styles"];
const PAINT = /^(?:(?:repeating-)?(?:linear|radial|conic)-gradient|url|image-set)\(/;
const PREFIX = /^(?:[a-z][a-z0-9]*-)?$/;
const TEXT_KEYS = ["font", "size", "weight", "lineHeight", "color", "decoration", "letterSpacing", "transform", "wrap"];
const ROOT_PROPS = PROP_ORDER as string[];
const SLOT_PROPS = ROOT_PROPS;

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
      if (k === "maxWidth" && ROOT_PROPS.includes(k) && !allowed.includes(k))
        err([...path, k], "maxWidth is only allowed on a component root", {
          expected: `one of ${allowed.join(", ")}; to keep a slot inside its parent, use width: fill (or a smaller size token)`,
          key: true,
        });
      else if (!allowed.includes(k))
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
  const top = obj(data, [], "a Cadesa document");
  if (!top) return { diagnostics };
  keys(top, [], TOP_KEYS);
  // version defaults to 1; anything else is a future format this release can't read.
  if (top.version !== undefined && top.version !== 1) err(["version"], "unsupported version", { expected: "1 (or leave it out)", got: top.version });
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
          const len = asLength(value);
          if (!len) {
            err(path, `invalid ${category} length`, { expected: "a length in rem or px, e.g. 1.5rem or 24px (a plain number is px)", got: value });
            continue;
          }
          tokens.set(tokenKey(category, name), { category, name, path: path.join("."), raw: len, px: parseLength(len).px });
        } else if (category === "color") {
          const hex = asColor(value);
          if (!hex) {
            err(path, "invalid color", { expected: 'a hex or rgb() color, e.g. "#191b20" or "rgb(25, 27, 32)"', got: value });
            continue;
          }
          tokens.set(tokenKey(category, name), { category, name, path: path.join("."), raw: hex });
        } else if (category === "paint") {
          if (typeof value !== "string" || !PAINT.test(value.trim())) {
            err(path, "invalid paint", { expected: 'a background-image value: a gradient or url(), e.g. "linear-gradient(#000a, #0000), url(hero.jpg)"', got: value });
            continue;
          }
          tokens.set(tokenKey(category, name), { category, name, path: path.join("."), raw: value.trim() });
        } else {
          if (typeof value !== "string" || !value.trim()) {
            err(path, `invalid ${category}`, { expected: category === "font" ? "a font-family list string" : 'a box-shadow value, e.g. "0 8px 24px #0002"', got: value });
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
      const literal = kind !== "text" && (LENGTH.test(value) || COLOR.test(value) || /^\d/.test(value));
      err(path, literal ? `"${value}" is a literal; values are token names` : `unknown ${label} "${value}"`, {
        expected: literal ? `${expected}, or declare it first: tokens.${kind}.<name>: ${value}` : expected,
        got: value,
        suggestion: literal ? undefined : closest(value, names),
      });
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
      const sizeRaw = asLength(role.size);
      if (!sizeRaw) {
        err([...path, "size"], "invalid font size", { expected: "a length in rem or px, e.g. 1rem or 16px (a plain number is px)", got: role.size });
        ok = false;
      }
      const WEIGHTS: Record<string, number> = { normal: 400, bold: 700 };
      const weight =
        typeof role.weight === "number" ? role.weight : typeof role.weight === "string" ? WEIGHTS[role.weight.trim()] ?? Number(role.weight) : NaN;
      if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
        err([...path, "weight"], "invalid font weight", { expected: "an integer from 1 to 1000, or normal/bold", got: role.weight });
        ok = false;
      }
      // Line height: a ratio (1.5), or "24px"/"1.5rem"/"150%", converted to the ratio CSS will use.
      let lineHeight = NaN;
      if (typeof role.lineHeight === "number") lineHeight = role.lineHeight;
      else if (typeof role.lineHeight === "string") {
        const t = role.lineHeight.trim();
        if (/^\d*\.?\d+%$/.test(t)) lineHeight = parseFloat(t) / 100;
        else if (/^\d*\.?\d+$/.test(t)) lineHeight = parseFloat(t);
        else if (LENGTH.test(t) && sizeRaw) lineHeight = Math.round((parseLength(t).px / parseLength(sizeRaw).px) * 1e6) / 1e6;
      }
      if (!(lineHeight > 0)) {
        err([...path, "lineHeight"], "invalid line height", { expected: 'a ratio like 1.5, or a length like "24px" or "150%"', got: role.lineHeight });
        ok = false;
      }
      if (role.letterSpacing !== undefined && (typeof role.letterSpacing !== "number" || role.letterSpacing < -0.2 || role.letterSpacing > 1)) {
        err([...path, "letterSpacing"], "invalid letter spacing", { expected: "a number of em between -0.2 and 1, e.g. 0.08", got: role.letterSpacing });
        ok = false;
      }
      if (role.wrap !== undefined && role.wrap !== "anywhere" && role.wrap !== "normal") {
        err([...path, "wrap"], "invalid wrap", { expected: "anywhere (long words may break between letters) or normal", got: role.wrap });
        ok = false;
      }
      if (role.transform !== undefined && role.transform !== "uppercase" && role.transform !== "none") {
        err([...path, "transform"], "invalid text transform", { expected: "uppercase or none", got: role.transform });
        ok = false;
      }
      if (role.decoration !== undefined && role.decoration !== "none" && role.decoration !== "underline") {
        err([...path, "decoration"], "invalid text decoration", { expected: "none or underline", got: role.decoration });
        ok = false;
      }
      const color = ref(role.color, [...path, "color"], "color");
      const font = role.font === undefined ? undefined : ref(role.font, [...path, "font"], "font");
      if (!ok || !color || (role.font !== undefined && !font)) continue;
      text.set(name, {
        name,
        path: path.join("."),
        font,
        size: parseLength(sizeRaw!),
        weight,
        lineHeight,
        decoration: role.decoration as "none" | "underline" | undefined,
        letterSpacing: role.letterSpacing as number | undefined,
        transform: role.transform as "uppercase" | "none" | undefined,
        wrap: role.wrap as "anywhere" | "normal" | undefined,
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
      const len = asLength(value);
      if (!len) {
        err(path, "invalid breakpoint", { expected: "a max-width length in rem or px, e.g. 36rem or 576px", got: value });
        continue;
      }
      breakpoints.push({ name, path: path.join("."), length: parseLength(len) });
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
          keys(l, p, ["pattern", "gap", "align", "min"]);
          const PATTERNS = ["stack", "cluster", "grid", "layer"];
          if (!PATTERNS.includes(l.pattern as string)) {
            err([...p, "pattern"], l.pattern === undefined ? 'missing required key "pattern"' : "unsupported layout pattern", {
              expected: "stack, cluster, grid or layer",
              got: l.pattern,
              suggestion: typeof l.pattern === "string" ? closest(l.pattern, PATTERNS) : undefined,
            });
            break;
          }
          let min: Ref | undefined;
          if (l.pattern === "grid") {
            if (l.min === undefined) {
              err(p, 'a grid needs "min": the minimum column width (a size token)', { expected: "layout: { pattern: grid, min: <size token>, gap: <space token> }" });
              break;
            }
            min = ref(l.min, [...p, "min"], "size");
            if (!min) break;
          } else if (l.min !== undefined) {
            err([...p, "min"], "min only applies to a grid", { expected: "remove min, or use pattern: grid" });
            break;
          }
          const gap = l.gap === undefined ? undefined : ref(l.gap, [...p, "gap"], "space");
          if (l.gap !== undefined && !gap) break;
          if (l.align !== undefined && (l.pattern === "stack" || !["start", "center", "end", "stretch"].includes(l.align as string))) {
            err([...p, "align"], l.pattern === "stack" ? "align doesn't apply to a stack (stack children always stretch)" : "invalid align", {
              expected: "start, center, end or stretch",
              got: l.align,
            });
            break;
          }
          out.layout = { path: p.join("."), pattern: l.pattern as LayoutProp["pattern"], gap, align: l.align as LayoutProp["align"], min };
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
        case "measure":
          out.measure = ref(v, p, "size");
          break;
        case "height":
          out.height = ref(v, p, "size");
          break;
        case "text":
          out.text = ref(v, p, "text");
          break;
        case "width":
          if (v === "fill") out.width = { keyword: "fill", path: p.join(".") };
          else if (typeof v === "string" && /^(?:100%|auto|stretch|full)$/.test(v))
            err(p, `width "${v}" is spelled fill in Cadesa`, {
              expected: "fill (stretch across the parent stack), or a size token",
              got: v,
              suggestion: '"fill"',
            });
          else out.width = ref(v, p, "size");
          break;
        case "backdrop":
          out.backdrop = ref(v, p, "paint");
          break;
        case "shadow":
          out.shadow = ref(v, p, "shadow");
          break;
        case "aspect": {
          const m = typeof v === "number" ? [String(v), String(v), "1"] : typeof v === "string" ? /^\s*([\d.]+)\s*[:/]\s*([\d.]+)\s*$/.exec(v) : null;
          const ratio = m ? parseFloat(m[1]) / parseFloat(m[2]) : NaN;
          if (!m || !(ratio > 0) || !isFinite(ratio)) err(p, "invalid aspect", { expected: 'a width:height ratio, e.g. "16:9" or 1.5', got: v });
          else out.aspect = { value: ratio, raw: typeof v === "number" ? String(v) : `${m[1]} / ${m[2]}`, path: p.join(".") };
          break;
        }
        case "fit":
          if (v === "cover" || v === "contain") out.fit = { value: v, path: p.join(".") };
          else err(p, "invalid fit", { expected: "cover or contain", got: v });
          break;
        case "textAlign":
          if (v === "start" || v === "center" || v === "end") out.textAlign = { value: v, path: p.join(".") };
          else err(p, "invalid textAlign", { expected: "start, center or end", got: v });
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
      // Desktop-first: overrides apply widest breakpoint first, so the narrowest active one wins,
      // whatever order the breakpoints are declared in. The emitted @media order matches.
      const bpPx = (n: string) => breakpoints.find((b) => b.name === n)!.length.px;
      when.sort((a, b) => bpPx(b.breakpoint) - bpPx(a.breakpoint) || bpNames.indexOf(a.breakpoint) - bpNames.indexOf(b.breakpoint));

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
  for (const c of components.values())
    for (const [where, p] of [
      [c.path, c.props] as const,
      ...[...c.slots.values()].map((s) => [s.path, s.props] as const),
      ...c.when.flatMap((w) => [[w.path, w.props] as const, ...[...w.slots].map(([s, p]) => [`${w.path}.slots.${s}`, p] as const)]),
    ])
      if (p.aspect && p.height) err([...where.split("."), "aspect"], "aspect and height both set the height", { expected: "keep one of them" });

  let page: Model["page"];
  if (top.page !== undefined) {
    const po = obj(top.page, ["page"], "page settings");
    if (po) {
      keys(po, ["page"], ["background"]);
      page = { path: "page", background: po.background === undefined ? undefined : ref(po.background, ["page", "background"], "color") };
    }
  }

  const prefix = typeof top.prefix === "string" ? top.prefix : DEFAULT_PREFIX;
  if (diagnostics.length) return { diagnostics };
  return { model: { file: src.file, prefix, tokens, text, breakpoints, components, page }, diagnostics };
}
