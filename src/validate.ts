import { closest, type Diagnostic } from "./diagnostics.js";
import { lengthExpr } from "./fluid.js";
import { originOf, originOf3, transformList4 } from "./engine/transform.js";
import { parseAreas, parseLinePair, parseTrackList } from "./engine/grid.js";
import type { PathSeg, Source } from "./load.js";
import {
  DEFAULT_PREFIX,
  LENGTH_CATEGORIES,
  OVERFLOWS,
  parseContain,
  parsePart,
  relative,
  PROP_ORDER,
  ROOT_FONT_PX,
  TOKEN_CATEGORIES,
  tokenKey,
  UNSETTABLE,
  type BorderProp,
  type Breakpoint,
  type Component,
  type MarginSide,
  type Overflow,
  type PositionType,
  type PaddingProp,
  type Unsettable,
  type Length,
  type LayoutProp,
  type MarginProp,
  type Model,
  type Override,
  type Props,
  type Ref,
  type GridTrack,
  type GridTemplateProp,
  type PlaceProp,
  type Slot,
  type TextRole,
  type Token,
  type TokenCategory,
} from "./model.js";

// kebab-case or camelCase; no underscores (BEM's "__" separates component and slot).
const IDENT = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;
const LENGTH = /^(?:\d+(?:\.\d+)?|\.\d+)(rem|px)$/;
/** A space token may be negative (a negative margin pulls the box outward). */
const SIGNED = /^-?(?:\d+(?:\.\d+)?|\.\d+)(rem|px)$/;
const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const IDENT_HELP = "a name of letters, digits and hyphens starting with a letter, e.g. section-title or sectionTitle";

/** Lengths as people write them: "1.5rem", "16px", 16 (px), "16" (px). Returns CSS ("16px") or undefined. */
function asLength(v: unknown, signed = false): string | undefined {
  if (typeof v === "number" && (v >= 0 || signed) && isFinite(v)) return `${v}px`;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (LENGTH.test(t) || (signed && SIGNED.test(t))) return t;
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t) || (signed && /^-(?:\d+(?:\.\d+)?|\.\d+)$/.test(t))) return `${t}px`;
  return undefined;
}

/** A percentage size token: "50%", "33.333%" (0–100). Returns the number or undefined. */
function asPercent(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)%\s*$/.exec(v);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return n > 0 && n <= 100 ? n : undefined;
}

/** A percentage for padding or margins (of the containing block's width): any finite value, negative too (margins). */
function asSidePercent(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^\s*(-?(?:\d+(?:\.\d+)?|\.\d+))%\s*$/.exec(v);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return isFinite(n) && Math.abs(n) <= 10000 ? n : undefined;
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
const TEXT_KEYS = ["font", "size", "weight", "lineHeight", "color", "decoration", "letterSpacing", "transform", "style", "wrap", "breaks"];
const ROOT_PROPS = PROP_ORDER as string[];
const SLOT_PROPS = ROOT_PROPS;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const show = (v: unknown) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));

export function parseLength(raw: string): Length {
  const m = SIGNED.exec(raw)!;
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
        const pct = category === "size" ? (asPercent(value) ?? asSidePercent(value)) : undefined;
        if (pct !== undefined) {
          tokens.set(tokenKey(category, name), { category, name, path: path.join("."), raw: `${pct}%`, pct });
        } else if (LENGTH_CATEGORIES.has(category)) {
          const len = asLength(value, category === "space");
          const fl = !len && typeof value === "string" ? lengthExpr(value) : undefined;
          if (fl?.fluid) {
            tokens.set(tokenKey(category, name), { category, name, path: path.join("."), raw: fl.css, px: fl.at(1280), fluid: fl.at });
            continue;
          }
          // A size with percentages of the parent's width in calc(), min(), max() or clamp().
          const withPct = !len && !fl && category === "size" && typeof value === "string" ? lengthExpr(value, { pct: true }) : undefined;
          if (withPct?.pct) {
            tokens.set(tokenKey(category, name), { category, name, path: path.join("."), raw: withPct.css, calc: withPct.pct });
            continue;
          }
          if (!len) {
            err(path, `invalid ${category} length`, {
              expected: `a length in rem or px, e.g. 1.5rem or 24px (a plain number is px), or one that follows the viewport width, e.g. "clamp(16px, 8px + 2vw, 32px)"${category === "size" ? ', or a percentage of the parent\'s width, e.g. "50%" or "min(440px, 100%)"' : category === "space" ? "; negative for a margin that pulls the box outward" : ""}`,
              got: value,
            });
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

  /** A size token that must be a fixed length (a percentage of the width can't size it). */
  const fixedRef = (value: unknown, path: PathSeg[], what: string): Ref | undefined => {
    const r = ref(value, path, "size");
    if (r && relative(tokens.get(tokenKey("size", r.name))!)) {
      err(path, `"${r.name}" is a percentage; ${what} needs a length`, { expected: "a size token in px or rem", got: value });
      return undefined;
    }
    return r;
  };

  /**
   * Grid column tracks: a count (3: three equal columns, minmax(0, 1fr) each) or a list of a size
   * token (a fixed column), "<n>fr" (CSS's <n>fr: at least its items' min-content width) or
   * "minmax(0, <n>fr)" (a share of what's left, however narrow); "repeat(<n>, <track>)" repeats one.
   */
  /** A grid template as CSS writes it: track lists, areas, implicit tracks, dense flow and content alignment. */
  const gridTemplate = (v: unknown, path: PathSeg[]): GridTemplateProp | undefined => {
    const o = obj(v, path, "a grid template");
    if (!o) return undefined;
    keys(o, path, ["columns", "rows", "areas", "autoColumns", "autoRows", "dense", "flow", "justifyContent", "alignContent"]);
    const out: GridTemplateProp = {};
    let ok = true;
    for (const k of ["columns", "rows", "autoColumns", "autoRows"] as const) {
      if (o[k] === undefined) continue;
      if (k === "columns" && o[k] === "subgrid") {
        out.columns = "subgrid";
        continue;
      }
      const l = typeof o[k] === "string" ? parseTrackList(o[k] as string) : undefined;
      if (!l || (k.startsWith("auto") && (l.repeat || !l.tracks.length))) {
        err([...path, k], `invalid ${k}`, { expected: 'a CSS track list, e.g. "1fr auto 1fr", "repeat(3, minmax(0, 1fr))" or "[full-start] 16px [content-start] 1fr"', got: o[k] });
        ok = false;
      } else out[k] = o[k] as string;
    }
    if (o.areas !== undefined) {
      const rows = Array.isArray(o.areas) && o.areas.every((r) => typeof r === "string") ? (o.areas as string[]) : undefined;
      if (!rows || !parseAreas(rows)) {
        err([...path, "areas"], "invalid areas", { expected: 'one string per row, every row as many cells, each name a rectangle, e.g. ["head head", "side main"]', got: o.areas });
        ok = false;
      } else out.areas = rows;
    }
    if (o.dense !== undefined) {
      if (typeof o.dense !== "boolean") {
        err([...path, "dense"], "invalid dense", { expected: "true or false", got: o.dense });
        ok = false;
      } else if (o.dense) out.dense = true;
    }
    if (o.flow !== undefined) {
      if (o.flow !== "row" && o.flow !== "column") {
        err([...path, "flow"], "invalid flow", { expected: "row or column", got: o.flow });
        ok = false;
      } else if (o.flow === "column") out.flow = "column";
    }
    const CONTENT = ["start", "center", "end", "stretch", "space-between", "space-around", "space-evenly"];
    for (const k of ["justifyContent", "alignContent"] as const) {
      if (o[k] === undefined) continue;
      if (!CONTENT.includes(o[k] as string)) {
        err([...path, k], `invalid ${k}`, { expected: CONTENT.join(", "), got: o[k] });
        ok = false;
      } else out[k] = o[k] as string;
    }
    return ok ? out : undefined;
  };

  const gridTracks = (v: unknown, path: PathSeg[]): GridTrack[] | undefined => {
    const expected = 'a column count (3), or a list of size tokens and "1fr" / "minmax(0, 1fr)" tracks, e.g. [sidebar, "minmax(0, 1fr)"]';
    if (typeof v === "number") {
      if (Number.isInteger(v) && v >= 1 && v <= 1000) return Array.from({ length: v }, () => ({ fr: 1, auto: false }));
      err(path, "invalid column count", { expected, got: v });
      return undefined;
    }
    if (!Array.isArray(v) || !v.length) {
      err(path, "invalid columns", { expected, got: v });
      return undefined;
    }
    const out: GridTrack[] = [];
    for (const [i, item] of v.entries()) {
      const q = [...path, i];
      const one = (x: unknown): GridTrack | undefined => {
        if (typeof x === "string") {
          const fr = /^(\d*\.?\d+)fr$/.exec(x.trim());
          if (fr && parseFloat(fr[1]) > 0) return { fr: parseFloat(fr[1]), auto: true };
          const mm = /^minmax\(\s*0(?:px)?\s*,\s*(\d*\.?\d+)fr\s*\)$/.exec(x.trim());
          if (mm && parseFloat(mm[1]) > 0) return { fr: parseFloat(mm[1]), auto: false };
        }
        const r = ref(x, q, "size");
        return r ? { size: r } : undefined;
      };
      const rep = typeof item === "string" ? /^repeat\(\s*(\d+)\s*,\s*(.+)\)$/.exec(item.trim()) : null;
      const n = rep ? parseInt(rep[1]) : 1;
      const t = one(rep ? rep[2] : item);
      if (!t) return undefined;
      if (!(n >= 1 && n <= 1000)) {
        err(q, "invalid repeat count", { expected, got: item });
        return undefined;
      }
      for (let k = 0; k < n; k++) out.push(t);
    }
    return out;
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
      // A size that follows the viewport width (clamp(), vw) is measured at each width.
      const sizeFluid = typeof role.size === "string" && !asLength(role.size) ? lengthExpr(role.size) : undefined;
      const sizeRaw = asLength(role.size) ?? (sizeFluid?.fluid ? sizeFluid.css : undefined);
      if (!sizeRaw) {
        err([...path, "size"], "invalid font size", { expected: 'a length in rem or px, e.g. 1rem or 16px (a plain number is px), or one that follows the viewport width, e.g. "clamp(1rem, 0.5rem + 2vw, 2rem)"', got: role.size });
        ok = false;
      }
      const sizeLength = (): Length => (sizeFluid?.fluid ? { raw: sizeFluid.css, px: sizeFluid.at(1280), fluid: sizeFluid.at } : parseLength(sizeRaw!));
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
        else if (LENGTH.test(t) && sizeRaw && !sizeFluid?.fluid) lineHeight = Math.round((parseLength(t).px / parseLength(sizeRaw).px) * 1e6) / 1e6;
      }
      if (!(lineHeight > 0)) {
        err([...path, "lineHeight"], "invalid line height", { expected: 'a ratio like 1.5, or a length like "24px" or "150%"', got: role.lineHeight });
        ok = false;
      }
      if (role.letterSpacing !== undefined && (typeof role.letterSpacing !== "number" || role.letterSpacing < -0.2 || role.letterSpacing > 1)) {
        err([...path, "letterSpacing"], "invalid letter spacing", { expected: "a number of em between -0.2 and 1, e.g. 0.08", got: role.letterSpacing });
        ok = false;
      }
      if (role.wrap !== undefined && !["anywhere", "break-word", "none", "normal"].includes(role.wrap as string)) {
        err([...path, "wrap"], "invalid wrap", { expected: "anywhere (long words may break between letters), break-word (the same, but a word's width still counts whole), none (never wraps) or normal", got: role.wrap });
        ok = false;
      }
      if (role.breaks !== undefined && !["all", "anywhere", "normal"].includes(role.breaks as string)) {
        err([...path, "breaks"], "invalid breaks", { expected: "all (lines break between the letters of any word, word-break: break-all), anywhere (between any two characters, line-break: anywhere) or normal", got: role.breaks });
        ok = false;
      }
      if (role.transform !== undefined && role.transform !== "uppercase" && role.transform !== "none") {
        err([...path, "transform"], "invalid text transform", { expected: "uppercase or none", got: role.transform });
        ok = false;
      }
      if (role.style !== undefined && role.style !== "italic" && role.style !== "normal") {
        err([...path, "style"], "invalid font style", { expected: "italic or normal", got: role.style });
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
        size: sizeLength(),
        weight,
        lineHeight,
        decoration: role.decoration as "none" | "underline" | undefined,
        letterSpacing: role.letterSpacing as number | undefined,
        transform: role.transform as "uppercase" | "none" | undefined,
        ...(role.style === "italic" && { style: "italic" as const }),
        wrap: role.wrap as TextRole["wrap"],
        ...(role.breaks !== undefined && role.breaks !== "normal" && { breaks: role.breaks as "all" | "anywhere" }),
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
  /** A space token that must not be negative (padding, gaps, border widths). */
  const spaceRef = (value: unknown, path: PathSeg[], what: string): Ref | undefined => {
    const r = ref(value, path, "space");
    if (r && tokens.get(tokenKey("space", r.name))!.px! < 0) {
      err(path, `"${r.name}" is negative; ${what} can't be`, { expected: "a space token of 0 or more (only margins may be negative)", got: value });
      return undefined;
    }
    return r;
  };
  /**
   * A padding or margin side: a space token, or a size token that is a percentage of the containing
   * block's width ("7%", "calc(5% + 8px)"); padding can't be negative.
   */
  const sideRef = (value: unknown, path: PathSeg[], what: string, signed: boolean): Ref | undefined => {
    const t = typeof value === "string" && !tokens.has(tokenKey("space", value)) ? tokens.get(tokenKey("size", value)) : undefined;
    if (t && relative(t)) {
      if (!signed && t.pct !== undefined && t.pct < 0) {
        err(path, `"${t.name}" is negative; ${what} can't be`, { expected: "a token of 0 or more (only margins may be negative)", got: value });
        return undefined;
      }
      return ref(value, path, "size");
    }
    return signed ? ref(value, path, "space") : spaceRef(value, path, what);
  };
  /** Per-side space tokens: { top, right, bottom, left } and the { block, inline } axes (a side beats its axis). */
  const sideRefs = (v: Obj, p: PathSeg[], what: string, one: (value: unknown, path: PathSeg[]) => Ref | undefined) => {
    const SIDES = ["top", "right", "bottom", "left"] as const;
    const axis = (k: "block" | "inline") => (v[k] === undefined ? undefined : one(v[k], [...p, k]));
    const block = axis("block");
    const inline = axis("inline");
    let ok = (v.block === undefined || !!block) && (v.inline === undefined || !!inline);
    const out: { top?: Ref; right?: Ref; bottom?: Ref; left?: Ref } = {};
    for (const s of SIDES) {
      const own = v[s] === undefined ? undefined : one(v[s], [...p, s]);
      if (v[s] !== undefined && !own) ok = false;
      const r = own ?? (s === "top" || s === "bottom" ? block : inline);
      if (r) out[s] = r;
    }
    void what;
    return ok ? out : undefined;
  };

  const props = (o: Obj, path: PathSeg[], allowed: string[], override = false): Props => {
    const out: Props = {};
    for (const key of allowed) {
      const v = o[key];
      if (v === undefined) continue;
      const p = [...path, key];
      if (v === "none" && (UNSETTABLE as readonly string[]).includes(key)) {
        if (!override) err(p, `${key}: none only applies in a breakpoint override`, { expected: `leave ${key} out (the default is none), or give it in when.<breakpoint> to remove a wider value` });
        else out.unset = { ...out.unset, [key as Unsettable]: p.join(".") };
        continue;
      }
      switch (key) {
        case "layout": {
          const l = obj(v, p, "a layout");
          if (!l) break;
          keys(l, p, ["pattern", "gap", "align", "min", "columns", "justify", "wrap", "rowGap", "template", "collapse", "fixed"]);
          const PATTERNS = ["stack", "cluster", "grid", "layer", "flow", "table"];
          if (!PATTERNS.includes(l.pattern as string)) {
            err([...p, "pattern"], l.pattern === undefined ? 'missing required key "pattern"' : "unsupported layout pattern", {
              expected: "stack, cluster, grid, layer, flow or table",
              got: l.pattern,
              suggestion: typeof l.pattern === "string" ? closest(l.pattern, PATTERNS) : undefined,
            });
            break;
          }
          let min: Ref | undefined;
          let columns: GridTrack[] | undefined;
          let template: GridTemplateProp | undefined;
          if (l.pattern === "grid" && l.template !== undefined) {
            if (l.min !== undefined || l.columns !== undefined) {
              err(p, 'a grid takes "min", "columns" or "template", only one of them', { expected: "layout: { pattern: grid, template: { columns: \"1fr auto 1fr\" } }" });
              break;
            }
            template = gridTemplate(l.template, [...p, "template"]);
            if (!template) break;
          } else if (l.template !== undefined) {
            err([...p, "template"], "template only applies to a grid", { expected: "remove template, or use pattern: grid" });
            break;
          } else if (l.pattern === "grid") {
            if ((l.min === undefined) === (l.columns === undefined)) {
              err(p, l.min === undefined ? 'a grid needs "min" (the minimum column width, a size token) or "columns" (its column tracks)' : 'a grid takes "min" or "columns", not both', {
                expected: "layout: { pattern: grid, min: <size token>, gap: <space token> }, or layout: { pattern: grid, columns: 3 } (or [<size token>, 1fr, ...])",
              });
              break;
            }
            if (l.min !== undefined) {
              min = fixedRef(l.min, [...p, "min"], "the grid's minimum column width");
              if (!min) break;
            } else {
              columns = gridTracks(l.columns, [...p, "columns"]);
              if (!columns) break;
            }
          } else if (l.pattern === "table" && l.min !== undefined && l.columns === undefined) {
            // A table's min-width: it is never narrower.
            min = fixedRef(l.min, [...p, "min"], "the table's minimum width");
            if (!min) break;
          } else if (l.min !== undefined || l.columns !== undefined) {
            const k = l.min !== undefined ? "min" : "columns";
            err([...p, k], `${k} only applies to a grid${k === "min" ? " or a table" : ""}`, { expected: `remove ${k}, or use pattern: grid` });
            break;
          }
          if (l.pattern === "flow" && l.gap !== undefined) {
            err([...p, "gap"], "a flow has no gap (block flow spaces its children with their margins)", { expected: "remove gap, or give the children margin: { top/bottom }, or use pattern: stack" });
            break;
          }
          // A cluster's or grid's gap between columns may be a percentage of its width (a size token).
          const pctGap = typeof l.gap === "string" && (l.pattern === "cluster" || l.pattern === "grid") && tokens.get(tokenKey("size", l.gap))?.pct !== undefined && !tokens.has(tokenKey("space", l.gap));
          const gap = l.gap === undefined ? undefined : pctGap ? ref(l.gap, [...p, "gap"], "size") : spaceRef(l.gap, [...p, "gap"], "a gap");
          if (l.gap !== undefined && !gap) break;
          if (l.rowGap !== undefined && l.pattern !== "grid" && l.pattern !== "cluster" && l.pattern !== "table") {
            err([...p, "rowGap"], "rowGap only applies to a grid, a cluster or a table (the gap between its rows)", { expected: "remove rowGap, or use gap" });
            break;
          }
          const badTable = (["collapse", "fixed"] as const).find((k) => l[k] !== undefined && (l.pattern !== "table" || typeof l[k] !== "boolean"));
          if (badTable) {
            err([...p, badTable], l.pattern !== "table" ? `${badTable} only applies to a table` : `invalid ${badTable}`, { expected: badTable === "collapse" ? "true (collapsed borders, border-collapse: collapse) or false" : "true (table-layout: fixed) or false", got: l[badTable] });
            break;
          }
          if (l.align !== undefined && l.pattern === "table") {
            err([...p, "align"], "align doesn't apply to a table (each cell's part says where its content sits)", { expected: "remove align, or give the cells part: \"cell top\" (middle, bottom, baseline)" });
            break;
          }
          // A grid's gap between rows may be a percentage of its height (a size token): 0 while its rows are sized, then of its final height.
          const pctRowGap = typeof l.rowGap === "string" && l.pattern === "grid" && tokens.get(tokenKey("size", l.rowGap))?.pct !== undefined && !tokens.has(tokenKey("space", l.rowGap));
          const rowGap = l.rowGap === undefined ? undefined : pctRowGap ? ref(l.rowGap, [...p, "rowGap"], "size") : spaceRef(l.rowGap, [...p, "rowGap"], "a gap");
          if (l.rowGap !== undefined && !rowGap) break;
          // A stack's align: where its children sit across it (stretch, or as wide as their content).
          if (l.align !== undefined && (l.pattern === "flow" || !["start", "center", "end", "stretch", ...(l.pattern === "cluster" ? ["baseline"] : [])].includes(l.align as string))) {
            err([...p, "align"], l.pattern === "flow" ? `align doesn't apply to a ${l.pattern} (its children always stretch)` : "invalid align", {
              expected: l.pattern === "cluster" ? "start, center, end, stretch or baseline" : "start, center, end or stretch",
              got: l.align,
            });
            break;
          }
          const JUSTIFY = ["start", "end", "center", "between", "around", "evenly"];
          if (l.justify !== undefined && l.pattern === "grid" && !["start", "center", "end", "stretch"].includes(l.justify as string)) {
            err([...p, "justify"], "invalid justify for a grid (where each item sits across its column)", { expected: "start, center, end or stretch", got: l.justify });
            break;
          }
          if (l.justify !== undefined && l.pattern !== "grid" && (l.pattern !== "cluster" || !JUSTIFY.includes(l.justify as string))) {
            err([...p, "justify"], l.pattern !== "cluster" ? "justify only applies to a cluster (where each line's free space goes) or a grid (where items sit in their column)" : "invalid justify", {
              expected: "start, end, center, between, around or evenly",
              got: l.justify,
              suggestion: typeof l.justify === "string" ? closest(l.justify.replace(/^space-/, ""), JUSTIFY) : undefined,
            });
            break;
          }
          if (l.wrap !== undefined && (l.pattern !== "cluster" || typeof l.wrap !== "boolean")) {
            err([...p, "wrap"], l.pattern !== "cluster" ? "wrap only applies to a cluster" : "invalid wrap", { expected: "true (items wrap onto new lines; the default) or false (one line; items shrink to fit)", got: l.wrap });
            break;
          }
          out.layout = {
            path: p.join("."),
            pattern: l.pattern as LayoutProp["pattern"],
            gap,
            align: l.align as LayoutProp["align"],
            ...(rowGap && { rowGap }),
            min,
            ...(columns && { columns }),
            ...(template && { template }),
            ...(l.justify !== undefined && l.pattern === "grid" && { justifyItems: l.justify as LayoutProp["justifyItems"] }),
            ...(l.justify !== undefined && l.pattern !== "grid" && { justify: l.justify as LayoutProp["justify"] }),
            ...(l.wrap === false && { wrap: false }),
            ...(l.collapse === true && { collapse: true }),
            ...(l.fixed === true && { fixed: true }),
          };
          break;
        }
        case "padding": {
          if (isObj(v)) {
            keys(v, p, ["block", "inline", "top", "right", "bottom", "left"]);
            if (!Object.keys(v).length) {
              err(p, "empty padding", { expected: "a space token, { block, inline } or { top, right, bottom, left } space tokens" });
              break;
            }
            const sides = sideRefs(v, p, "padding", (x, q) => sideRef(x, q, "padding", false));
            if (sides) out.padding = { path: p.join("."), ...sides } as PaddingProp;
          } else {
            const r = sideRef(v, p, "padding", false);
            if (r) out.padding = { path: p.join("."), top: r, right: r, bottom: r, left: r };
          }
          break;
        }
        case "margin": {
          const SIDES = ["top", "right", "bottom", "left"] as const;
          if (isObj(v)) {
            keys(v, p, ["block", "inline", ...SIDES]);
            if (!Object.keys(v).length) {
              err(p, "empty margin", { expected: "a space token, { block, inline } or { top, right, bottom, left } space tokens" });
              break;
            }
            // auto: it takes the line's free space, or centers a narrower box. Top and bottom: in a
            // stack, cluster or grid (in block flow an auto top or bottom margin is 0).
            const one = (value: unknown, q: PathSeg[]): MarginSide | undefined => {
              if (value === "auto") return { auto: true, path: q.join(".") };
              return sideRef(value, q, "a margin", true);
            };
            const axis = (k: "block" | "inline") => (v[k] === undefined ? undefined : one(v[k], [...p, k]));
            const block = axis("block");
            const inline = axis("inline");
            const m: MarginProp = { path: p.join(".") };
            let ok = (v.block === undefined || !!block) && (v.inline === undefined || !!inline);
            for (const s of SIDES) {
              const own = v[s] === undefined ? undefined : one(v[s], [...p, s]);
              if (v[s] !== undefined && !own) ok = false;
              const r = own ?? (s === "top" || s === "bottom" ? block : inline);
              if (r) (m as unknown as Record<string, MarginSide>)[s] = r;
            }
            if (ok) out.margin = m;
          } else if (v === "auto") {
            const a = { auto: true as const, path: p.join(".") };
            out.margin = { path: p.join("."), top: a, right: a, bottom: a, left: a };
          } else {
            const r = sideRef(v, p, "a margin", true);
            if (r) out.margin = { path: p.join("."), top: r, right: r, bottom: r, left: r };
          }
          break;
        }
        case "background":
          out.background = ref(v, p, "color");
          break;
        case "border": {
          if (isObj(v)) {
            keys(v, p, ["color", "width", "top", "right", "bottom", "left"]);
            const color = ref(v.color, [...p, "color"], "color");
            const width = v.width === undefined ? undefined : spaceRef(v.width, [...p, "width"], "a border width");
            if (v.width !== undefined && !width) break;
            let ok = !!color;
            const sides: NonNullable<BorderProp["sides"]> = {};
            for (const s of ["top", "right", "bottom", "left"] as const) {
              const own = v[s] === undefined ? undefined : spaceRef(v[s], [...p, s], "a border width");
              if (v[s] !== undefined && !own) ok = false;
              const r = own ?? width;
              if (r) sides[s] = r;
            }
            const given = ["width", "top", "right", "bottom", "left"].some((k) => v[k] !== undefined);
            if (ok) out.border = { path: p.join("."), color: color!, ...(given && { sides }) };
          } else {
            const color = ref(v, p, "color");
            if (color) out.border = { path: p.join("."), color };
          }
          break;
        }
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
          // A percentage: of the parent's content height once that is definite (it is stretched in a cluster or grid row, or set).
          out.height = ref(v, p, "size");
          break;
        case "minHeight":
          out.minHeight = fixedRef(v, p, "a minimum height");
          break;
        case "minWidth":
          out.minWidth = fixedRef(v, p, "a minimum width");
          break;
        case "maxHeight":
          out.maxHeight = fixedRef(v, p, "a maximum height");
          break;
        case "text":
          out.text = ref(v, p, "text");
          break;
        case "width":
          if (v === "fill" || v === "fit" || v === "max-content" || v === "min-content") out.width = { keyword: v, path: p.join(".") };
          else if (typeof v === "string" && /^(?:100%|auto|stretch|full)$/.test(v))
            err(p, `width "${v}" is spelled fill in Cadesa`, {
              expected: "fill (stretch across the parent stack), fit (as wide as its content, at most the parent), or a size token",
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
        case "position": {
          // position: absolute, or { type: absolute, top: <token>, left: <token> }.
          const o = isObj(v) ? v : { type: v };
          if (isObj(v)) keys(v, p, ["type", "top", "right", "bottom", "left", "height"]);
          if (!["relative", "absolute", "fixed", "sticky"].includes(o.type as string)) {
            err(isObj(v) ? [...p, "type"] : p, "invalid position", { expected: "relative, absolute, fixed or sticky", got: o.type });
            break;
          }
          const side = (k: "top" | "right" | "bottom" | "left") => {
            if (o[k] === undefined) return undefined;
            const names = [...tokens.values()].filter((t) => (t.category === "space" || (t.category === "size" && t.pct !== undefined)) && t.name === o[k]);
            return names.length && names[0].category === "size" ? ref(o[k], [...p, k], "size") : ref(o[k], [...p, k], "space");
          };
          const sides = { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") };
          if ((["top", "right", "bottom", "left"] as const).some((k) => o[k] !== undefined && !sides[k])) break;
          const height = o.height === undefined ? undefined : ref(o.height, [...p, "height"], "size");
          if (o.height !== undefined && !height) break;
          out.position = { type: o.type as PositionType, path: p.join("."), ...Object.fromEntries(Object.entries(sides).filter(([, r]) => r)), ...(height && { height }) };
          break;
        }
        case "overflow": {
          // overflow: hidden (both axes), or { x: auto } (y visible): Bootstrap's .table-responsive.
          if (isObj(v)) keys(v, p, ["x", "y"]);
          const o = isObj(v) ? v : { x: v, y: v };
          const ax = (k: "x" | "y") => {
            const a = o[k] ?? "visible";
            if (OVERFLOWS.includes(a as Overflow)) return a as Overflow;
            err(isObj(v) ? [...p, k] : p, "invalid overflow", { expected: "visible, hidden, clip, auto or scroll (or { x, y })", got: a, suggestion: typeof a === "string" ? closest(a, OVERFLOWS) : undefined });
            return undefined;
          };
          let x = ax("x");
          let y = ax("y");
          if (!x || !y) break;
          // As computed: an axis that can't stay visible (or clip) next to a scrolling one.
          const scrolling = (a: Overflow) => a !== "visible" && a !== "clip";
          const fix = (a: Overflow, other: Overflow): Overflow => (scrolling(other) && !scrolling(a) ? (a === "visible" ? "auto" : "hidden") : a);
          [x, y] = [fix(x, y), fix(y, x)];
          out.overflow = { x, y, raw: x === y ? x : `x ${x}, y ${y}`, path: p.join(".") };
          break;
        }
        case "place": {
          // place: { row: "1 / -1", column: "span 2", align: center, justify: start }: where a grid item sits.
          const o = obj(v, p, "a grid placement");
          if (!o) break;
          keys(o, p, ["row", "column", "align", "justify"]);
          const ALIGN = ["start", "center", "end", "stretch"];
          let ok = true;
          for (const k of ["align", "justify"] as const)
            if (o[k] !== undefined && !ALIGN.includes(o[k] as string)) {
              err([...p, k], `invalid ${k}`, { expected: "start, center, end or stretch", got: o[k] });
              ok = false;
            }
          for (const k of ["row", "column"] as const)
            if (o[k] !== undefined && (typeof o[k] !== "string" || !parseLinePair(o[k] as string))) {
              err([...p, k], `invalid grid ${k}`, { expected: 'grid lines as CSS writes them, e.g. "1 / -1", "2", "span 2" or an area name', got: o[k] });
              ok = false;
            }
          if (!ok) break;
          out.place = {
            path: p.join("."),
            ...(o.row !== undefined && { row: o.row as string }),
            ...(o.column !== undefined && { column: o.column as string }),
            ...(o.align !== undefined && { align: o.align as PlaceProp["align"] }),
            ...(o.justify !== undefined && { justify: o.justify as PlaceProp["justify"] }),
          };
          break;
        }
        case "transform": {
          // transform: "rotate(3deg)", or { value: "translate(-50%, 0) scale(1.2)", origin: "left top", style: preserve-3d }.
          const o = isObj(v) ? v : { value: v };
          if (isObj(v)) keys(v, p, ["value", "origin", "style"]);
          const list = typeof o.value === "string" ? o.value.trim() : undefined;
          const origin = typeof o.origin === "string" ? o.origin.trim() : o.origin === undefined ? undefined : null;
          if (o.style !== undefined && o.style !== "flat" && o.style !== "preserve-3d") {
            err([...p, "style"], "invalid transform style", { expected: "flat or preserve-3d", got: o.style });
            break;
          }
          const preserve3d = o.style === "preserve-3d";
          if (!list || (!(preserve3d && list === "none") && !transformList4(list, 100, 100))) {
            err(isObj(v) ? [...p, "value"] : p, "invalid transform", { expected: 'CSS transform functions in px or % (2D, or 3D: translateZ, rotateX, rotateY, rotate3d, scale3d, perspective(), matrix3d), e.g. "rotate(3deg)" or "translate(-50%, 0) scale(1.2)"', got: o.value });
            break;
          }
          if (origin === null || (origin !== undefined && !originOf3(origin, 100, 100))) {
            err([...p, "origin"], "invalid transform origin", { expected: 'a transform-origin in keywords, px or %, e.g. "left top" or "50% 0"', got: o.origin });
            break;
          }
          out.transform = { value: list, ...(origin && { origin }), ...(preserve3d && { preserve3d }), path: p.join(".") };
          break;
        }
        case "perspective": {
          // perspective: 600 (px), or { value: 600, origin: "left top" }: its children's 3D transforms are seen from there.
          const o = isObj(v) ? v : { value: v };
          if (isObj(v)) keys(v, p, ["value", "origin"]);
          const d = typeof o.value === "number" ? o.value : typeof o.value === "string" && /^\d*\.?\d+px$/.test(o.value.trim()) ? parseFloat(o.value) : NaN;
          const origin = typeof o.origin === "string" ? o.origin.trim() : o.origin === undefined ? undefined : null;
          if (!(d >= 0)) {
            err(isObj(v) ? [...p, "value"] : p, "invalid perspective", { expected: "a distance in px, e.g. 600 or \"600px\"", got: o.value });
            break;
          }
          if (origin === null || (origin !== undefined && !originOf(origin, 100, 100))) {
            err([...p, "origin"], "invalid perspective origin", { expected: 'a perspective-origin in keywords, px or %, e.g. "left top" or "50% 0"', got: o.origin });
            break;
          }
          out.perspective = { value: d, ...(origin && { origin }), path: p.join(".") };
          break;
        }
        case "contain": {
          // contain: "layout paint style", content, strict, size, inline-size; none in an override.
          const c = typeof v === "string" ? parseContain(v) : undefined;
          if (!c) err(p, "invalid contain", { expected: "none, content, strict, or any of size (or inline-size), layout, style and paint, e.g. \"layout paint\"", got: v });
          else out.contain = { ...c, raw: (v as string).trim().toLowerCase().replace(/\s+/g, " "), path: p.join(".") };
          break;
        }
        case "part": {
          // part: row, body, "cell middle", "caption bottom" (a child of a table, or of its rows).
          const t = typeof v === "string" ? parsePart(v) : undefined;
          if (!t) err(p, "invalid part", { expected: "caption (top or bottom), column, column-group, header, body, footer, row, or cell (baseline, top, middle or bottom), e.g. \"cell middle\"", got: v });
          else out.part = { value: t.part, ...(t.align && { align: t.align }), ...(t.side && { side: t.side }), ...(t.contentBox && { contentBox: true }), raw: (v as string).trim().toLowerCase().replace(/\s+/g, " "), path: p.join(".") };
          break;
        }
        case "float":
          // float: left or right (none in an override).
          if (v === "left" || v === "right" || (v === "none" && override)) out.float = { value: v, path: p.join(".") };
          else err(p, "invalid float", { expected: override ? "left, right or none" : "left or right", got: v });
          break;
        case "clear":
          if (v === "left" || v === "right" || v === "both" || (v === "none" && override)) out.clear = { value: v, path: p.join(".") };
          else err(p, "invalid clear", { expected: override ? "left, right, both or none" : "left, right or both", got: v });
          break;
        case "inlineBox": {
          // inlineBox: { top: 2, height: 20 }: an inline box's rectangle on each of its lines (px).
          const o = obj(v, p, "an inline box's rectangle");
          if (!o) break;
          keys(o, p, ["top", "height"]);
          if (typeof o.top !== "number" || !isFinite(o.top) || typeof o.height !== "number" || !(o.height >= 0)) err(p, "invalid inlineBox", { expected: "{ top: <px from the line's top>, height: <px> }", got: v });
          else out.inlineBox = { top: o.top, height: o.height, path: p.join(".") };
          break;
        }
        case "root":
          // root: true (display: flow-root): a block formatting context of its own.
          if (typeof v === "boolean") out.root = { value: v, path: p.join(".") };
          else err(p, "invalid root", { expected: "true (a formatting context of its own, display: flow-root) or false", got: v });
          break;
        case "textAlign":
          if (v === "start" || v === "center" || v === "end") out.textAlign = { value: v, path: p.join(".") };
          else err(p, "invalid textAlign", { expected: "start, center or end", got: v });
          break;
        case "grow": {
          // grow: 1, or grow: { factor: 1, basis: zero } (equal shares from nothing, like flex: 1 0 0%).
          const g = isObj(v) ? v : { factor: v };
          if (isObj(v)) keys(v, p, ["factor", "basis"]);
          const f = g.factor;
          if (typeof f !== "number" || !(f > 0) || !isFinite(f) || f > 1000) {
            err(isObj(v) ? [...p, "factor"] : p, "invalid grow", { expected: "a number above 0, e.g. 1 (or { factor: 1, basis: zero })", got: f });
            break;
          }
          if (g.basis !== undefined && g.basis !== "zero" && g.basis !== "content") {
            err([...p, "basis"], "invalid grow basis", { expected: "zero (shares the free space from nothing) or content (grows from its own size; the default)", got: g.basis });
            break;
          }
          out.grow = { value: f, basis: (g.basis as "zero" | "content" | undefined) ?? "content", path: p.join(".") };
          break;
        }
        case "shrink":
          // shrink: 1 (flex-shrink): a box with a width that still gives way in a full line, or 0: one without that doesn't.
          if (typeof v === "number" && v >= 0 && isFinite(v) && v <= 1000) out.shrink = { value: v, path: p.join(".") };
          else err(p, "invalid shrink", { expected: "a number of 0 or more, e.g. 1 (a box with a width shrinks in a full line) or 0 (a box without one doesn't)", got: v });
          break;
        case "order":
          // order (CSS order): where a stack's, cluster's or grid's item goes among its siblings.
          if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 1e6) out.order = { value: v, path: p.join(".") };
          else err(p, "invalid order", { expected: "an integer, e.g. -1 (first) or 1 (after the items without one)", got: v });
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
          slotOverrides.set(slotName, props(sv, sp, SLOT_PROPS, true));
        }
        when.push({ breakpoint: bp, path: wp.join("."), props: props(o, wp, ROOT_PROPS, true), slots: slotOverrides });
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
    {
      if (p.aspect && p.height) err([...where.split("."), "aspect"], "aspect and height both set the height", { expected: "keep one of them" });
      if (p.maxWidth && p.unset?.margin === undefined && (p.margin?.left || p.margin?.right))
        err([...where.split("."), "margin"], "maxWidth centers the box with auto inline margins; it can't also have a left or right margin", {
          expected: "margin: { block: <space> } (top and bottom only), or measure instead of maxWidth",
        });
    }

  let page: Model["page"];
  if (top.page !== undefined) {
    const po = obj(top.page, ["page"], "page settings");
    if (po) {
      keys(po, ["page"], ["background", "margin", "padding", "outer", "overflow", "overflowY", "windowHeight"]);
      page = { path: "page", background: po.background === undefined ? undefined : ref(po.background, ["page", "background"], "color") };
      // The window's height (px) the source was laid out for: fixed boxes and absolute ones with no positioned ancestor are placed in it.
      if (po.windowHeight !== undefined) {
        if (typeof po.windowHeight !== "number" || !(po.windowHeight > 0)) err(["page", "windowHeight"], "invalid window height", { expected: "a height in px, e.g. 800", got: po.windowHeight });
        else page.windowHeight = po.windowHeight;
      }
      // overflow: hidden (or clip): what is past the page's right edge is cut off instead of scrolling.
      if (po.overflow !== undefined) {
        if (!OVERFLOWS.includes(po.overflow as Overflow)) err(["page", "overflow"], "invalid overflow", { expected: "visible, hidden, clip, auto or scroll", got: po.overflow });
        else if (po.overflow === "hidden" || po.overflow === "clip") page.clipX = true;
      }
      // overflowY: hidden (or clip): the page doesn't scroll vertically (no scrollbar where scrollbars take space).
      if (po.overflowY !== undefined) {
        if (!OVERFLOWS.includes(po.overflowY as Overflow)) err(["page", "overflowY"], "invalid overflow", { expected: "visible, hidden, clip, auto or scroll", got: po.overflowY });
        else if (po.overflowY === "hidden" || po.overflowY === "clip") page.clipY = true;
      }
      // The body's margin (may be negative) and padding, and the root element's insets: a space token, or per side.
      for (const k of ["margin", "padding", "outer"] as const) {
        const v = po[k];
        if (v === undefined) continue;
        const p = ["page", k];
        const one = (x: unknown, q: PathSeg[]) => (k === "margin" ? ref(x, q, "space") : spaceRef(x, q, k));
        if (isObj(v)) {
          keys(v, p, ["block", "inline", "top", "right", "bottom", "left"]);
          const sides = sideRefs(v, p, k, one);
          if (sides) page[k] = { path: p.join("."), ...sides };
        } else {
          const r = one(v, p);
          if (r) page[k] = { path: p.join("."), top: r, right: r, bottom: r, left: r };
        }
      }
    }
  }

  const prefix = typeof top.prefix === "string" ? top.prefix : DEFAULT_PREFIX;
  if (diagnostics.length) return { diagnostics };
  // A source lifted on the fly from a page and its CSS or Tailwind (its header says so): advice is
  // given in CSS terms, since the reader edits the CSS, not this source.
  const css = /^# Lifted from .* \((?:CSS|Tailwind), /.test(src.text);
  return { model: { file: src.file, prefix, tokens, text, breakpoints, components, page, ...(css && { css }) }, diagnostics };
}
