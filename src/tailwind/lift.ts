/**
 * Tailwind front end for lift: a page that styles elements with utility classes, plus the compiled
 * Tailwind CSS, becomes a Cadesa source and a fixture.
 *
 *   1. Every utility rule that applies to an element is read from the compiled CSS (so custom
 *      themes, arbitrary values and the real cascade order are honoured), per width range.
 *      Tailwind is mobile-first (`md:` = `width >= 48rem`); the ranges between thresholds become
 *      desktop-first states: the widest range is the base, each narrower range a `when` override
 *      on a max-width breakpoint just below its upper threshold (47.99rem below md).
 *   2. The rest is the shared page lift (../lift/page.ts): var() and calc() resolved per element,
 *      inherited text computed down the tree, generated class names and ids, block flow as a stack
 *      (`space-y-*` its gap), and everything not modelled recorded against its element.
 */
import { kindOf, worst } from "../lift/lift.js";
import { hintOf, lengthPx, PageLifter, round, type El, type Origin, type PageLift, type State } from "../lift/page.js";
import { isStatePseudo, parseTailwindCss, heightsHold, widthsHold, type TailwindCss } from "./css.js";
import { INVALID, simplify, substitute } from "./values.js";

export { longhands, stateAt, type State } from "../lift/page.js";
export type TailwindLift = PageLift;

/** Tailwind v4's default breakpoints (overridable with --breakpoint-* theme variables). */
export const DEFAULT_BREAKPOINTS: Record<string, string> = { sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem", "2xl": "96rem" };

/**
 * Mobile-first thresholds → desktop-first states. `cuts` are px where some media condition flips
 * (min-width thresholds); names map a threshold px to a Tailwind breakpoint name.
 */
export function statesFor(cuts: number[], names: Map<number, string> = new Map()): State[] {
  const cs = [...new Set(cuts.filter((c) => c > 0))].sort((a, b) => a - b);
  const bounds = [0, ...cs, Infinity];
  const out: State[] = [];
  for (let i = bounds.length - 2; i >= 0; i--) {
    const lo = bounds[i];
    const hi = bounds[i + 1];
    if (hi === Infinity) out.push({ lo, hi, key: Infinity });
    else {
      const rem = round(hi / 16 - 0.01);
      const raw = `${rem}rem`;
      out.push({ lo, hi, key: rem * 16, raw, name: `below-${names.get(hi) ?? `${round(hi, 2)}px`.replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "")}` });
    }
  }
  return out;
}

export function liftTailwind(page: string, html: string, cssFile: string, cssText: string, opts: { height?: number } = {}): TailwindLift {
  const l = new TailwindLifter(page, html, parseTailwindCss(cssFile, cssText));
  if (opts.height) l.viewportHeight = opts.height;
  return l.run();
}

class TailwindLifter extends PageLifter {
  /** Classes with no rule in the compiled CSS (not generated, or not Tailwind). */
  unknownClasses = new Set<string>();
  readonly label: string;

  constructor(
    page: string,
    html: string,
    readonly css: TailwindCss,
  ) {
    super(page, html, css.file);
    this.theme = css.theme;
    this.preflight = css.preflight;
    this.label = `Tailwind, ${css.file}`;
  }

  rootVar(name: string) {
    return this.css.theme.get(name);
  }

  registered(name: string) {
    return this.css.registered.get(name);
  }

  extraUnlifted() {
    if (!this.unknownClasses.size) return [];
    const list = [...this.unknownClasses];
    return [
      {
        file: this.page,
        line: 0,
        selector: list.slice(0, 12).join(" ") + (list.length > 12 ? " ..." : ""),
        reason: `${list.length} class name(s) have no rule in ${this.css.file}; they style nothing`,
        kind: "none" as const,
      },
    ];
  }

  // ---- media states

  computeStates() {
    const cuts: number[] = [];
    const all = [this.htmlEl, this.bodyEl, ...this.els].filter(Boolean) as El[];
    for (const el of all)
      for (const c of el.classes)
        for (const r of this.css.byClass.get(c) ?? []) for (const m of r.media) for (const w of m.widths) cuts.push(w.px);
    const names = new Map<number, string>();
    for (const [n, v] of Object.entries(DEFAULT_BREAKPOINTS)) names.set(lengthPx(v, 16)!, n);
    for (const [k, v] of this.css.theme) {
      const m = /^--breakpoint-([\w-]+)$/.exec(k);
      const px = m && lengthPx(simplify(v), 16);
      if (m && px) names.set(px, m[1]);
    }
    this.states = statesFor(cuts, names);
  }

  // ---- cascade

  /** Root text context: html's preflight font-family and line-height, 16px, black. */
  computeRootText() {
    const theme = this.css.theme;
    const lookup = (name: string): string | undefined => {
      const v = theme.get(name);
      return v === undefined ? undefined : substitute(v, lookup);
    };
    const famRaw = this.css.rootDecls.get("font-family");
    const fam = famRaw ? substitute(famRaw, lookup) : undefined;
    const lhRaw = this.css.rootDecls.get("line-height");
    const lh = lhRaw && /^[\d.]+$/.test(lhRaw) ? { num: parseFloat(lhRaw) } : ("normal" as const);
    let hint: string | undefined;
    if (famRaw) {
      const inner = /^var\(\s*(--[\w-]+)/.exec(famRaw);
      if (inner && theme.has(inner[1])) hint = hintOf(theme.get(inner[1])!, theme) ?? undefined;
    }
    this.rootText = {
      size: 16,
      lineHeight: lh,
      family: { value: fam && fam !== INVALID ? simplify(fam) : "serif", hint },
      weight: 400,
      color: { hex: "#000000" },
      letterSpacing: 0,
      inherited: new Map(),
    };
    if (!this.css.preflight)
      this.pageNotes.push({ reason: "the compiled CSS has no Tailwind preflight; browser default margins, padding and borders remain", kind: "geometry", decl: "preflight" });
  }

  /** Own declarations per state, and notes for rules that don't apply in the default state. */
  evaluate(el: El) {
    const rules: { rule: TailwindCss["other"][number]; cls: string }[] = [];
    for (const c of el.classes) {
      const rs = this.css.byClass.get(c);
      if (!rs) {
        this.unknownClasses.add(c);
        continue;
      }
      for (const rule of rs) rules.push({ rule, cls: c });
    }
    rules.sort((a, b) => a.rule.order - b.rule.order);
    this.states.forEach((st, si) => {
      const own = new Map<string, Origin>();
      el.own[si] = own;
      el.space[si] = undefined;
      for (const { rule, cls } of rules) {
        const declText = `${cls} (${rule.decls.filter((d) => !d.prop.startsWith("--")).map((d) => `${d.prop}: ${d.value}`).join("; ") || rule.decls.map((d) => d.prop).join(", ")})`;
        const kinds = rule.decls.filter((d) => !d.prop.startsWith("--")).map((d) => kindOf(d.prop));
        const k = kinds.length ? worst(kinds) : "none";
        let skip = false;
        for (const m of rule.media) {
          if (!widthsHold(m.widths, st.lo) || !heightsHold(m, this.viewportHeight)) skip = true;
          else if (m.dark) {
            this.note(el, si, { decl: cls, reason: "dark: variants are not modelled; the light color scheme is assumed", kind: "none" });
            skip = true;
          } else if (m.env === false) skip = true;
          else if (m.env !== true) {
            this.note(el, si, { decl: declText, reason: `${m.env.unknown} is not modelled`, kind: k });
            skip = true;
          }
        }
        if (skip) continue;
        if (rule.complex) {
          const state = /:(hover|focus|focus-visible|focus-within|active|visited|checked|disabled|open|target)\b/.test(rule.selector);
          this.note(el, si, state
            ? { decl: cls, reason: "interactive state; the default state is unaffected", kind: "state" }
            : { decl: declText, reason: `the selector ${rule.selector} is not modelled`, kind: k });
          continue;
        }
        if (rule.pseudoElement) {
          const pe = rule.pseudoElement;
          this.note(el, si, /^(before|after|marker|first-line|first-letter)$/.test(pe)
            ? { decl: declText, reason: `::${pe} content is not modelled`, kind: pe === "before" || pe === "after" ? "geometry" : "text" }
            : { decl: cls, reason: `::${pe} styles don't affect layout`, kind: "none" });
          continue;
        }
        let applies = true;
        for (const p of rule.pseudos) {
          if (isStatePseudo(p)) {
            this.note(el, si, { decl: cls, reason: "interactive state; the default state is unaffected", kind: "state" });
            applies = false;
          } else if (p === "first-child") applies &&= el.index === 0;
          else if (p === "last-child") applies &&= el.index === el.siblings - 1;
          else if (p === "only-child") applies &&= el.siblings === 1;
          else if (p === "nth-child(odd)") applies &&= el.index % 2 === 0;
          else if (p === "nth-child(even)") applies &&= el.index % 2 === 1;
          else if (p === "empty") applies &&= !el.children.length && !el.ownText;
          else {
            this.note(el, si, { decl: declText, reason: `:${p} is not modelled`, kind: k });
            applies = false;
          }
        }
        if (!applies) continue;
        if (rule.spaceChildren) {
          const prop = rule.spaceChildren === "y" ? "margin-block-end" : "margin-inline-end";
          const d = rule.decls.find((x) => x.prop === prop);
          if (d) el.space[si] = { axis: rule.spaceChildren, value: d.value, utility: cls };
          continue;
        }
        for (const d of rule.decls) this.apply(own, d, cls);
      }
    });
  }
}
