/**
 * Point findings on a lifted page (--css, --tailwind) at the page's own source: the element in
 * the HTML (file:line, tag, classes and a bit of its text) and the CSS rules that set the
 * properties behind the finding (stylesheet file:line and selector). The generated Cadesa path
 * stays in the finding's `path` for tools that edit a Cadesa source.
 */
import type { Finding } from "./check.js";
import type { FixtureNode } from "./fixture.js";
import { stateAt, type El, type PageLift } from "./lift/page.js";

/** The element a finding is about, as it appears in the page. */
export interface ElementRef {
  /** The page file and the line its start tag is on. */
  file: string;
  line?: number;
  tag: string;
  /** The element's own classes (not Cadesa's generated ones). */
  classes: string[];
  id?: string;
  /** The start of its text, whitespace collapsed. */
  text?: string;
}

/** One declaration in the page's CSS (or a browser default) that sets a property behind a finding. */
export interface SourceRule {
  property: string;
  value: string;
  /** The rule's selector; `style="…"` for a style attribute; a class name for a Tailwind utility. */
  selector: string;
  file?: string;
  line?: number;
  origin: "stylesheet" | "inline" | "browser" | "utility";
  /** Set when the value is inherited: the ancestor whose rule sets it. */
  inheritedFrom?: ElementRef;
}

/** What a group of rules is responsible for in the finding: "color", "background", "size"... */
export interface SourcePointer {
  what: string;
  rules: SourceRule[];
}

const INHERITED = new Set(["color", "font-size", "line-height", "font-family", "font-weight", "letter-spacing", "white-space", "overflow-wrap", "word-break", "text-transform", "font-style"]);

/** CSS properties behind each property of a lifted Cadesa style. */
const CSS_OF: Record<string, string[]> = {
  width: ["width", "min-width", "max-width", "flex-basis", "flex-grow", "flex-shrink"],
  height: ["height", "min-height", "max-height"],
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  gap: ["gap", "row-gap", "column-gap"],
  maxWidth: ["max-width"],
  measure: ["max-width"],
  aspect: ["aspect-ratio"],
  background: ["background-color", "background-image"],
  border: ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"],
  layout: ["display", "flex-direction", "flex-wrap", "grid-template-columns"],
  grow: ["flex-grow", "flex-basis", "flex"],
  color: ["color"],
  size: ["font-size"],
  lineHeight: ["line-height"],
  weight: ["font-weight"],
  font: ["font-family"],
  letterSpacing: ["letter-spacing"],
  wrap: ["white-space", "overflow-wrap", "word-break"],
};
/** A whole element's sizing: what an overflowing or undersized box usually comes from. */
const SIZE_X = ["width", "min-width", "max-width", "flex-basis", "flex-grow", "flex-shrink", "padding-left", "padding-right", "white-space", "font-size"];
const SIZE_Y = ["height", "min-height", "max-height", "padding-top", "padding-bottom", "line-height", "font-size"];
const TEXT_WRAP = ["white-space", "overflow-wrap", "word-break", "font-size", "letter-spacing", "font-family"];

/** "`.btn (bootstrap.css:12)`", "`browser default (button)`", "`style=\"…\"`" or a utility class → where it is. */
function parseOrigin(label: string): Pick<SourceRule, "selector" | "file" | "line" | "origin"> {
  let m = /^browser default \((.*)\)$/.exec(label);
  if (m) return { selector: m[1], origin: "browser" };
  if (label.startsWith('style="')) return { selector: label, origin: "inline" };
  m = /^(.*) \(([^()]+):(\d+)\)$/.exec(label);
  if (m) return { selector: m[1], file: m[2], line: Number(m[3]), origin: "stylesheet" };
  return { selector: label, origin: "utility" };
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export class Pointers {
  private byId = new Map<string, El>();
  private byClass = new Map<string, El>();
  private nodes = new Map<string, FixtureNode>();

  constructor(private readonly lift: PageLift) {
    for (const el of lift.elements.els) {
      if (el.id) this.byId.set(el.id, el);
      if (el.className && !this.byClass.has(el.className)) this.byClass.set(el.className, el);
    }
    const visit = (ns: FixtureNode[]) => ns.forEach((n) => (n.fixtureId && this.nodes.set(n.fixtureId, n), visit(n.children)));
    visit(lift.fixture.body);
  }

  has(id: string) {
    return this.byId.has(id);
  }

  element(id: string): ElementRef | undefined {
    const el = this.byId.get(id);
    return el && this.ref(el);
  }

  private ref(el: El): ElementRef {
    const node = el.id ? this.nodes.get(el.id) : undefined;
    const text = collapse(node?.text ?? el.anonymous ?? "");
    const id = el.node.attrs?.find((a) => a.name === "id")?.value;
    return {
      file: this.lift.page,
      ...(el.line && { line: el.line }),
      tag: el.anonymous !== undefined ? "#text" : el.tag,
      classes: el.classes,
      ...(id && { id }),
      ...(text && { text: text.length > 40 ? text.slice(0, 39) + "…" : text }),
    };
  }

  /** `<button.btn.btn-link>`: short enough for a message. */
  short(id: string): string | undefined {
    const el = this.byId.get(id);
    if (!el) return undefined;
    const r = this.ref(el);
    if (r.tag === "#text") return `text "${r.text ?? ""}"`;
    const cls = r.classes.slice(0, 3).map((c) => `.${c}`).join("") + (r.classes.length > 3 ? "…" : "");
    return `<${r.tag}${r.id ? `#${r.id}` : ""}${cls}>${!cls && !r.id && r.text ? ` "${r.text.length > 24 ? r.text.slice(0, 23) + "…" : r.text}"` : ""}`;
  }

  /** The declarations that set `props` on element `id` at `width` (inherited ones from the ancestor that sets them). */
  rules(el: El, width: number, props: string[], opts: { authorOnly?: boolean } = {}): SourceRule[] {
    const si = this.lift.states.indexOf(stateAt(this.lift.states, width));
    const out: SourceRule[] = [];
    const seen = new Set<string>();
    const find = (p: string, from: El, depth: number) => {
      // Custom properties inherit; so do inherited properties (from the ancestor that sets them).
      const inherits = INHERITED.has(p) || p.startsWith("--");
      for (let e: El | undefined = from; e; e = inherits ? e.parent : undefined) {
        const o = e.own[si]?.get(p);
        if (!o) continue;
        const at = parseOrigin(o.utility);
        if (at.origin === "inline" && !at.file) Object.assign(at, { file: this.lift.page, line: e.line });
        if (opts.authorOnly && at.origin === "browser") return;
        const key = `${p}|${at.selector}|${at.file}|${at.line}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ property: p, value: o.value, ...at, ...(e !== el && !p.startsWith("--") && { inheritedFrom: this.ref(e) }) });
        // A value from a custom property: where that is set, which is usually the line to edit.
        if (depth < 3) for (const m of o.value.matchAll(/var\(\s*(--[\w-]+)/g)) find(m[1], e, depth + 1);
        return;
      }
    };
    for (const p of props) find(p, el, 0);
    return out;
  }

  /** The element a lifted Cadesa path (`styles.app.slots.card.width`) styles, and the CSS properties behind it. */
  private fromPath(path: string, f: Finding): { el?: El; props?: string[] } {
    const m = /^styles\.([^.]+)(?:\.slots\.([^.]+))?(?:\.when\.[^.]+)?(?:\.(\w+))?/.exec(path);
    if (m) {
      const cls = `ca-${m[1]}${m[2] ? `__${m[2]}` : ""}`;
      // The finding's own element when it has that class (slots are shared by identical elements).
      const ids = [f.id, ...[...f.message.matchAll(/#([\w-]+)/g)].map((x) => x[1])];
      const el = ids.map((i) => this.byId.get(i)).find((e) => e?.className === cls) ?? this.byClass.get(cls);
      return { el, props: m[3] ? CSS_OF[m[3]] : undefined };
    }
    const t = /^text\.[^.]+(?:\.(\w+))?$/.exec(path);
    if (t) return { el: this.byId.get(f.id), props: t[1] ? CSS_OF[t[1]] : TEXT_WRAP };
    if (path === "page.background") return { el: this.lift.elements.body, props: ["background-color"] };
    return {};
  }

  /** The background behind a contrast finding, from the path its message names. */
  private background(f: Finding): SourcePointer | undefined {
    const m = /\(background: (?:gradient stop \S+ in )?([\w.-]+)\)/.exec(f.message);
    if (!m) return undefined;
    if (m[1] === "page.background") {
      const { html, body } = this.lift.elements;
      for (const el of [body, html]) {
        const rules = el ? this.rules(el, f.width, ["background-color"]) : [];
        if (rules.length) return { what: "background", rules };
      }
      return undefined;
    }
    const { el } = this.fromPath(m[1], f);
    const rules = el ? this.rules(el, f.width, ["background-color", "background-image"]) : [];
    return rules.length ? { what: `background (on ${this.short(el!.id!)})`, rules } : undefined;
  }

  /** The rules behind one finding. */
  sources(f: Finding): SourcePointer[] {
    const el = this.byId.get(f.id);
    const out: SourcePointer[] = [];
    // Text running together is fixed in the markup (the finding's path is its line).
    if (f.check === "spacing") return out;
    if (f.check === "clipped") {
      if (!el) return out;
      const rules = this.rules(el, f.width, ["overflow-x", "overflow-y", "text-overflow", "white-space", "width", "max-width", "height", "max-height"], { authorOnly: true });
      if (rules.length) out.push({ what: "cut off by", rules });
      return out;
    }
    // An inline run's contrast (`"late" (<span> in #p)`): its own color isn't the box's.
    if (f.check === "contrast" && /^"/.test(f.message)) {
      const bg = this.background(f);
      if (bg) out.push(bg);
      return out;
    }
    if (f.check === "contrast") {
      if (el) {
        const rules = this.rules(el, f.width, ["color"]);
        if (rules.length) out.push({ what: "color", rules });
      }
      const bg = this.background(f);
      if (bg) out.push(bg);
      return out;
    }
    if (f.check === "tap-target") {
      if (!el) return out;
      // A set width or height decides the size; without one, padding and the text's size do.
      const fixed = this.rules(el, f.width, ["width", "height", "min-width", "min-height"], { authorOnly: true }).filter((r) => !/^(auto|inherit|initial|unset)$/.test(r.value.trim()));
      const rules = fixed.length
        ? this.rules(el, f.width, [...new Set(fixed.map((r) => r.property))], { authorOnly: true })
        : this.rules(el, f.width, ["padding-top", "padding-bottom", "padding-left", "padding-right", "font-size", "line-height"], { authorOnly: true });
      if (rules.length) out.push({ what: "size", rules });
      return out;
    }
    // Layout and other checks: the element and properties the Cadesa path names.
    const { el: target, props } = f.path ? this.fromPath(f.path, f) : {};
    const subject = target ?? el;
    if (!subject) return out;
    const wanted = props ?? (/height/.test(f.message) ? SIZE_Y : SIZE_X);
    const rules = this.rules(subject, f.width, wanted, { authorOnly: true });
    if (rules.length) out.push({ what: subject === el ? "set by" : `set on ${this.short(subject.id!)}`, rules });
    return out;
  }

  /** Message with generated ids replaced by the element they name, and Cadesa paths left out. */
  message(f: Finding): string {
    return f.message
      .replace(/(^|[\s(">])#([\w-]+)/g, (all, pre, id) => (this.byId.has(id) ? `${pre}${this.short(id)}` : all))
      .replace(/ \(background: [^)]*\)/, "")
      .replace(/ \[[^\]]+\.html?:\d+\]$/, "");
  }
}

/** Add the element, its source rules and a readable message to each finding on a lifted page. */
export function pointFindings(findings: Finding[], lift: PageLift): void {
  const p = new Pointers(lift);
  for (const f of findings) {
    const element = p.element(f.id);
    if (element) f.element = element;
    const source = p.sources(f);
    if (source.length) f.source = source;
    f.message = p.message(f);
  }
}

/** One line per rule: "bootstrap.css:6620 .btn { padding-top: 0.375rem; font-size: 1rem }". */
export function describeRules(rules: SourceRule[]): string[] {
  const groups = new Map<string, SourceRule[]>();
  for (const r of rules) {
    const key = [r.file, r.line, r.selector, r.inheritedFrom ? describeElement(r.inheritedFrom) : ""].join("|");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const r = g[0];
    const where = r.file ? `${r.file}${r.line ? `:${r.line}` : ""} ` : r.origin === "browser" ? "browser default: " : r.origin === "utility" ? "class " : "";
    const from = r.inheritedFrom ? `, inherited from ${describeElement(r.inheritedFrom, false)}` : "";
    return `${where}${r.selector} { ${g.map((x) => `${x.property}: ${x.value}`).join("; ")} }${from}`;
  });
}

export function describeElement(e: ElementRef, withLine = true): string {
  const cls = e.classes.length ? ` class="${e.classes.join(" ")}"` : "";
  const tag = e.tag === "#text" ? "text" : `<${e.tag}${e.id ? ` id="${e.id}"` : ""}${cls}>`;
  return `${withLine ? `${e.file}${e.line ? `:${e.line}` : ""} ` : ""}${tag}${e.text ? ` "${e.text}"` : ""}`;
}
