/**
 * Tables, laid out as Chromium's LayoutNG does (third_party/blink/renderer/core/layout/table/:
 * table_layout_algorithm.cc, table_layout_utils.cc, table_layout_algorithm_types.cc,
 * table_borders.cc, table_section_ and table_row_layout_algorithm.cc), in layout units (1/64 px)
 * with Chromium's rounding:
 *
 *   1. Column constraints: each cell's min-content and max-content width (border box, with its
 *      padding and its border; in a collapsed table, half of each collapsed border), its width
 *      (fixed or a percentage), merged per column with the <col> elements'; cells spanning columns
 *      are distributed over them afterwards, narrowest span first. table-layout: fixed reads the
 *      columns and the first row only.
 *   2. The table's width (its width, else its content's, never under its columns' minimum), shared
 *      between the columns by the width distribution algorithm (min, percentage, specified, max
 *      guesses), or in fixed layout by the fixed one.
 *   3. Row heights: every cell laid out at its columns' width, a row as tall as its tallest cell (or
 *      its cells' baselines and descents, or its height), cells spanning rows distributed after,
 *      a table's height shared between its sections and rows.
 *   4. Placement: captions above (or below) the table box, row groups in order (header, bodies,
 *      footer) border-spacing apart, cells at their columns, their content moved by vertical-align.
 *
 * The engine calls layoutTable from measure(); it lays cells and captions out through the hooks.
 */
import type { FixtureNode } from "../fixture.js";
import type { CellAlign, Component, TablePart } from "../model.js";
import { insets, sizeAt, type ResolvedProps, type Sides } from "../resolve.js";
import type { Box } from "./layout.js";
import { metricsFor } from "./text.js";

/** A child element the engine lays out: its node and component (slot). */
export interface Kid {
  node: FixtureNode;
  comp: Component;
  slot: string | undefined;
}

export interface TableHooks {
  props(k: Kid): ResolvedProps;
  /** Element children in order: laid out (comp), or not (comp null), and whether out of flow. */
  kids(n: FixtureNode, c: Component): { node: FixtureNode; comp: Component | null; slot: string | undefined; out: boolean }[];
  /** The min-content and max-content width of a box's content, without its padding and border. */
  content(k: Kid, cell: boolean): { min: number; max: number; why?: string };
  /** Lay out a cell or caption `w` wide (its props changed by `over`): its box, content placed, at 0,0. */
  measure(k: Kid, avail: number, w: number | undefined, over: Partial<ResolvedProps>): Box;
  /** A box of its own for a row, row group or column, at 0,0 and 0×0. */
  box(k: Kid, over: Partial<ResolvedProps>): Box;
  /** Line height of a text role in px (Chromium's rounding). */
  lineHeight(sizePx: number, lineHeight: number): number;
  /** Why a box (or one inside it) may not be where the engine puts it, if it may not. */
  doubtful(b: Box): string | undefined;
  /** An element (and its descendants) the engine doesn't lay out. */
  skip(n: FixtureNode): void;
}

type LU = number;
const U = (px: number): LU => Math.round(px * 64);
const PX = (u: LU) => u / 64;
const f32 = Math.fround;
/** LayoutUnit(float): truncated toward zero. */
const fromFloat = (x: number): LU => Math.trunc(f32(f32(x) * 64));
/** LayoutUnit::ToFloat(). */
const toFloat = (u: LU) => f32(u / 64);
/** LayoutUnit::MulDiv: raw × raw ÷ raw in 64 bits, truncated. */
function mulDiv(a: LU, m: LU, d: LU): LU {
  if (d === 0) return 0;
  const p = a * m;
  if (Math.abs(p) < 2 ** 52) return Math.trunc(p / d);
  return Number((BigInt(a) * BigInt(m)) / BigInt(d));
}
/** LayoutUnit / integer: raw integer division. */
const divInt = (a: LU, n: number): LU => (n === 0 ? 0 : Math.trunc(a / n));
const ZERO: Sides = { top: 0, right: 0, bottom: 0, left: 0 };
const TABLE_MAX: LU = 1000000 * 64;

interface CellC {
  min: LU;
  max: LU;
  percent?: number;
  pbp: LU;
  constrained: boolean;
}
interface Column {
  min?: LU;
  max?: LU;
  percent?: number;
  pbp: LU;
  constrained: boolean;
  fixedTable: boolean;
  mergeable: boolean;
}
const isFixedCol = (c: Column) => c.constrained && c.percent === undefined && c.max !== undefined;

interface Cell {
  k: Kid;
  p: ResolvedProps;
  /** Index among all rows, in layout order. */
  row: number;
  col: number;
  colspan: number;
  /** Rowspan clamped to the rows left in its section. */
  rowspan: number;
  /** Its rowspan attribute (at least 1). */
  rawRowspan: number;
  section: number;
  align: CellAlign;
  contentBox: boolean;
  /** Its border widths as laid out (layout units): its own, or its half of each collapsed border. */
  border: Sides;
  padding: Sides;
}
interface Row {
  k?: Kid;
  p?: ResolvedProps;
  cells: Cell[];
  section: number;
}
interface Section {
  k?: Kid;
  p?: ResolvedProps;
  kind: "header" | "body" | "footer";
  /** Laid out among the bodies (not the table's first header or footer group): it takes a table's extra height first. */
  tbody?: boolean;
  rows: number[];
}
interface ColEl {
  k: Kid;
  p: ResolvedProps;
  span: number;
  /** A column group (else a column). */
  group: boolean;
  /** A column group's columns (none: the group spans `span` columns itself). */
  cols?: ColEl[];
}

export interface TableResult {
  /** Border box width and height, captions included. */
  w: number;
  h: number;
  /** Boxes of captions, row groups (rows, cells) and columns, relative to the table's border box. */
  children: Box[];
  assumptions: string[];
}

export interface TableIntrinsic {
  min: number;
  max: number;
  why?: string;
}

const attrInt = (n: FixtureNode, name: string, def: number, max: number, min = 1): number => {
  const v = n.attrs[name];
  if (v === undefined) return def;
  const m = /^\s*(\d+)/.exec(v);
  if (!m) return def;
  const x = parseInt(m[1], 10);
  return Math.min(max, Math.max(min, x));
};

/** Everything about a table that doesn't depend on its width. */
class Grid {
  captions: { k: Kid; p: ResolvedProps }[] = [];
  colEls: ColEl[] = [];
  sections: Section[] = [];
  rows: Row[] = [];
  cells: Cell[] = [];
  /** Why the structure can't be laid out exactly, if it can't. */
  why?: string;
  /** What makes its widths approximate (content it can't measure): it is laid out, and marked ≈. */
  doubts = new Set<string>();
  notes: string[] = [];
  collapse: boolean;
  fixed: boolean;
  spacingX: LU;
  spacingY: LU;
  /** The table's border and padding as laid out (collapsed: half its outer collapsed borders, no padding). */
  border: Sides = ZERO;
  padding: Sides = ZERO;
  columnCount = 0;

  constructor(
    readonly h: TableHooks,
    readonly n: FixtureNode,
    readonly c: Component,
    readonly props: ResolvedProps,
  ) {
    const t = props.table?.value ?? { collapse: false, fixed: false };
    this.collapse = t.collapse;
    // table-layout: fixed only applies to a table whose width isn't auto.
    this.fixed = t.fixed && props.width !== undefined && props.width.value !== "fit";
    this.spacingX = this.collapse ? 0 : U(props.gap?.value ?? 0);
    this.spacingY = this.collapse ? 0 : U(props.rowGap?.value ?? props.gap?.value ?? 0);
    this.build();
    if (!this.why) this.borders();
  }

  part(k: Kid): ResolvedProps["part"] {
    return this.h.props(k).part;
  }

  build() {
    const h = this.h;
    const header: Section[] = [];
    const footer: Section[] = [];
    const bodies: Section[] = [];
    let anon: Section | undefined;
    let anonRow: Row | undefined;
    const sectionRows = new Map<Section, Row[]>();
    const rowsOf = (s: Section) => sectionRows.get(s)!;
    const newSection = (kind: Section["kind"], k?: Kid, p?: ResolvedProps): Section => {
      const s: Section = { kind, rows: [], ...(k && { k, p }) };
      sectionRows.set(s, []);
      return s;
    };
    const addCell = (row: Row, k: Kid, p: ResolvedProps) => {
      const part = p.part!.value;
      row.cells.push({ k, p, row: -1, col: -1, colspan: 1, rowspan: 1, rawRowspan: 1, section: -1, align: part.align ?? "baseline", contentBox: false, border: ZERO, padding: ZERO });
    };
    const rowKids = (row: Row, n: FixtureNode, c: Component) => {
      for (const x of h.kids(n, c)) {
        if (x.out) continue;
        if (!x.comp) return void (this.why ??= `<${x.node.tag}> in a table row isn't laid out`);
        const k = { node: x.node, comp: x.comp, slot: x.slot };
        const p = h.props(k);
        if (p.part?.value.part !== "cell") return void (this.why ??= `<${x.node.tag}> in a table row isn't a cell (an anonymous cell around it isn't modelled)`);
        addCell(row, k, p);
      }
    };
    const sectionKids = (s: Section, n: FixtureNode, c: Component) => {
      let lone: Row | undefined;
      for (const x of h.kids(n, c)) {
        if (x.out) continue;
        if (!x.comp) return void (this.why ??= `<${x.node.tag}> in a table row group isn't laid out`);
        const k = { node: x.node, comp: x.comp, slot: x.slot };
        const p = h.props(k);
        const part = p.part?.value.part;
        if (part === "row") {
          lone = undefined;
          const row: Row = { k, p, cells: [], section: -1 };
          rowsOf(s).push(row);
          rowKids(row, x.node, x.comp);
        } else if (part === "cell") {
          // Cells directly in a row group: an anonymous row around them.
          if (!lone) rowsOf(s).push((lone = { cells: [], section: -1 }));
          addCell(lone, k, p);
        } else return void (this.why ??= `<${x.node.tag}> in a table row group isn't a row (an anonymous row around it isn't modelled)`);
      }
    };
    const order: Section[] = [];
    for (const x of h.kids(this.n, this.c)) {
      if (x.out) continue;
      if (!x.comp) {
        this.why ??= `<${x.node.tag}> in a table isn't laid out`;
        continue;
      }
      const k = { node: x.node, comp: x.comp, slot: x.slot };
      const p = h.props(k);
      const part = p.part?.value.part as TablePart | undefined;
      if (part !== "row" && part !== "cell") {
        anon = undefined;
        anonRow = undefined;
      }
      if (part === "caption") this.captions.push({ k, p });
      else if (part === "column") this.colEls.push({ k, p, span: attrInt(x.node, "span", 1, 1000), group: false });
      else if (part === "column-group") {
        const cols: ColEl[] = [];
        for (const y of h.kids(x.node, x.comp)) {
          if (y.out || !y.comp) continue;
          const yk = { node: y.node, comp: y.comp, slot: y.slot };
          const yp = h.props(yk);
          if (yp.part?.value.part === "column") cols.push({ k: yk, p: yp, span: attrInt(y.node, "span", 1, 1000), group: false });
        }
        this.colEls.push({ k, p, span: attrInt(x.node, "span", 1, 1000), group: true, ...(cols.length && { cols }) });
      } else if (part === "header" || part === "body" || part === "footer") {
        const s = newSection(part, k, p);
        (part === "header" ? header : part === "footer" ? footer : bodies).push(s);
        order.push(s);
        sectionKids(s, x.node, x.comp);
      } else if (part === "row") {
        anonRow = undefined;
        if (!anon) {
          anon = newSection("body");
          bodies.push(anon);
          order.push(anon);
        }
        const row: Row = { k, p, cells: [], section: -1 };
        rowsOf(anon).push(row);
        rowKids(row, x.node, x.comp);
      } else if (part === "cell") {
        if (!anon) {
          anon = newSection("body");
          bodies.push(anon);
          order.push(anon);
        }
        if (!anonRow) rowsOf(anon).push((anonRow = { cells: [], section: -1 }));
        addCell(anonRow, k, p);
      } else this.why ??= `<${x.node.tag}> in a table isn't a table part (an anonymous cell around it isn't modelled)`;
    }
    // Layout order: the first header group, the bodies (other headers and footers among them, in
    // document order), the first footer group.
    const head = header[0];
    const foot = footer[0];
    for (const s of [...(head ? [head] : []), ...order.filter((s) => s !== head && s !== foot), ...(foot ? [foot] : [])]) {
      const si = this.sections.length;
      s.tbody = s !== head && s !== foot;
      this.sections.push(s);
      for (const r of rowsOf(s)) {
        r.section = si;
        s.rows.push(this.rows.length);
        this.rows.push(r);
      }
    }
    this.place();
  }

  /** Each cell's column (cells spanning rows above take theirs), colspan and rowspan. */
  place() {
    let count = 0;
    for (const s of this.sections) {
      const spanning: { col: number; span: number; rows: number }[] = [];
      s.rows.forEach((ri, i) => {
        let col = 0;
        const free = () => {
          for (const c of spanning) if (c.col <= col && c.col + c.span > col) col = c.col + c.span;
        };
        for (const cell of this.rows[ri].cells) {
          free();
          const td = cell.k.node.tag === "td" || cell.k.node.tag === "th";
          cell.colspan = td ? attrInt(cell.k.node, "colspan", 1, 1000) : 1;
          const rs = td ? attrInt(cell.k.node, "rowspan", 1, 65534, 0) : 1;
          // rowspan="0": every row left in its row group.
          cell.rawRowspan = rs === 0 ? 65534 : Math.max(1, rs);
          cell.rowspan = Math.min(cell.rawRowspan, s.rows.length - i);
          cell.row = ri;
          cell.col = col;
          cell.section = this.rows[ri].section;
          if (cell.rawRowspan > 1) spanning.push({ col, span: cell.colspan, rows: cell.rawRowspan });
          count = Math.max(count, this.fixed ? col + cell.colspan : col + 1);
          col += cell.colspan;
          this.cells.push(cell);
        }
        // End of row: spans that end here are done.
        for (let j = spanning.length - 1; j >= 0; j--) if (--spanning[j].rows === 0) spanning.splice(j, 1);
        spanning.sort((a, b) => a.col - b.col);
      });
    }
    this.columnCount = count;
    for (const cell of this.cells) {
      const p = cell.p;
      cell.padding = p.padding?.value ?? ZERO;
      cell.contentBox = !!p.part?.value.contentBox;
    }
  }

  /** The non-mergeable columns the <col> elements make (collapsed borders count them). */
  colElementColumns(): number {
    const cols = this.columnConstraintsFromElements(Infinity);
    let i = cols.length - 1;
    while (i > 0 && cols[i].mergeable) i--;
    if (i <= 0 && (!cols.length || cols[0].mergeable)) return 0;
    return i + 1;
  }

  /** Border widths: separated, each cell's own; collapsed, resolved per edge and halved. */
  borders() {
    const own = (p?: ResolvedProps): Sides => {
      const b = p?.border?.value.widths;
      return b ? { top: U(b.top), right: U(b.right), bottom: U(b.bottom), left: U(b.left) } : ZERO;
    };
    if (!this.collapse) {
      for (const cell of this.cells) cell.border = own(cell.p);
      const b = own(this.props);
      const pd = this.props.padding?.value ?? ZERO;
      this.border = b;
      this.padding = { top: U(pd.top), right: U(pd.right), bottom: U(pd.bottom), left: U(pd.left) };
      return;
    }
    // Collapsed: TableBorders::ComputeTableBorders. Edges live in one array, a row of them after
    // another (two per column: the one on its left, the one on its top, and two more for the last
    // line), grown only as far as a border with a style needs; the widest border on an edge wins (a
    // tie keeps the width either way). Edges inside a cell spanning rows or columns are left empty.
    // Reads past a row's last edge land on the next row's first ones, as Chromium's do.
    const R = this.rows.length;
    const C = Math.max(this.columnCount, this.colElementColumns());
    this.columnCount = C;
    const set: boolean[] = [];
    const wid: number[] = [];
    const dead: boolean[] = [];
    let per = 0;
    let lastColumn = Infinity;
    const fitColumn = (col: number) => {
      const want = (col + 2) * 2;
      if (want <= per) return;
      const rows = per === 0 ? 1 : set.length / per;
      const os = set.slice();
      const ow = wid.slice();
      const od = dead.slice();
      set.length = wid.length = dead.length = 0;
      for (let r = 0; r < rows; r++)
        for (let e = 0; e < want; e++) {
          const old = e < per ? r * per + e : -1;
          set.push(old >= 0 ? os[old] : false);
          wid.push(old >= 0 ? ow[old] : 0);
          dead.push(old >= 0 ? od[old] : false);
        }
      per = want;
    };
    const fitRow = (row: number) => {
      const want = row + 2;
      if (want <= set.length / per) return;
      while (set.length < want * per) {
        set.push(false);
        wid.push(0);
        dead.push(false);
      }
    };
    const fill = (i: number, w: number) => {
      if (dead[i]) return;
      if (!set[i] || w > wid[i]) {
        set[i] = true;
        wid[i] = w;
      }
    };
    const sectionOf = new Map<number, { start: number; count: number }>();
    this.sections.forEach((s, si) => sectionOf.set(si, { start: s.rows[0] ?? 0, count: s.rows.length }));
    const merge = (r0: number, c0: number, rs: number, cs: number, p: ResolvedProps | undefined, cell: { section: number } | undefined) => {
      if (rs <= 0 || cs <= 0) return;
      const b = p?.border?.value;
      const w = own(p);
      const has = (s: keyof Sides) => !!b && (w[s] > 0 || !!b.styled?.[s]);
      cs = Math.min(cs, lastColumn - c0);
      if (cell && rs > 1) {
        const s = sectionOf.get(cell.section)!;
        rs = Math.min(rs, s.count - (r0 - s.start));
      }
      const inner = !!cell && (rs > 1 || cs > 1);
      if (inner) {
        fitColumn(c0 + cs - 1);
        fitRow(r0 + rs - 1);
      } else {
        if (!has("top") && !has("right") && !has("bottom") && !has("left")) return;
        fitColumn(!has("right") && !has("top") && !has("bottom") ? c0 : c0 + cs - 1);
        fitRow(!has("left") && !has("right") && !has("bottom") ? r0 : r0 + rs - 1);
      }
      const hor = (r: number, side: keyof Sides) => {
        if (!has(side)) return;
        const start = per * r + c0 * 2 + 1;
        for (let e = start; e < start + cs * 2; e += 2) fill(e, w[side]);
      };
      const ver = (c: number, side: keyof Sides) => {
        if (!has(side)) return;
        const start = per * r0 + c * 2;
        for (let e = start; e < start + rs * per; e += per) fill(e, w[side]);
      };
      hor(r0, "top");
      hor(r0 + rs, "bottom");
      ver(c0, "left");
      ver(c0 + cs, "right");
      if (inner) {
        let start = c0 * 2 + 2;
        let end = start + (cs - 1) * 2;
        for (let r = r0; r < r0 + rs && start !== end; r++) for (let e = r * per + start; e < r * per + end; e += 2) if (!set[e]) dead[e] = true;
        start = c0 * 2 + 1;
        end = start + cs * 2;
        for (let r = r0 + 1; r < r0 + rs; r++) for (let e = r * per + start; e < r * per + end; e += 2) if (!set[e]) dead[e] = true;
      }
    };
    // Cells, until one spans rows or columns; then (with the column count known) all of them again.
    let multi = false;
    for (const cell of this.cells) {
      multi ||= cell.rawRowspan > 1 || cell.colspan > 1;
      if (!multi) merge(cell.row, cell.col, cell.rawRowspan, cell.colspan, cell.p, cell);
    }
    lastColumn = C;
    if (multi) for (const cell of this.cells) merge(cell.row, cell.col, cell.rawRowspan, cell.colspan, cell.p, cell);
    this.rows.forEach((row, ri) => merge(ri, 0, 1, C, row.p, undefined));
    for (const sec of this.sections) merge(sec.rows[0] ?? 0, 0, sec.rows.length, C, sec.p, undefined);
    // Columns, then column groups.
    const visit = (fn: (el: ColEl, start: number, span: number, group: boolean) => void) => {
      let at = 0;
      for (const el of this.colEls) {
        if (at >= C) break;
        if (!el.group) {
          const span = Math.min(el.span, C - at);
          fn(el, at, span, false);
          at += span;
          continue;
        }
        const start = at;
        if (el.cols) for (const col of el.cols) {
          const span = Math.min(col.span, C - at);
          fn(col, at, span, false);
          at += span;
          if (at >= C) break;
        }
        else at += Math.min(el.span, C - at);
        fn(el, start, at - start, true);
      }
    };
    visit((el, start, span, group) => {
      if (!group) for (let i = 0; i < span; i++) merge(0, start + i, R, 1, el.p, undefined);
    });
    visit((el, start, span, group) => {
      if (group) merge(0, start, R, span, el.p, undefined);
    });
    merge(0, 0, R, C, this.props, undefined);
    const paint = (i: number) => (i < set.length && set[i] ? wid[i] : 0);
    const half = (u: number) => Math.trunc(u / 2);
    // TableBorders::GetCellBorders.
    const cellBorders = (row: number, col: number, rs: number, cs: number): Sides => {
      if (per === 0 || col * 2 >= per || row >= set.length / per) return ZERO;
      let top = 0;
      let bottom = 0;
      let left = 0;
      let right = 0;
      const firstStart = row * per + col * 2;
      const firstEnd = firstStart + cs * 2;
      for (let i = 0; i < rs; i++) {
        const s = firstStart + i * per;
        left = Math.max(left, paint(s));
        if (s >= set.length) break;
        right = Math.max(right, paint(firstEnd + i * per));
      }
      for (let i = 0; i < cs; i++) {
        const c = col * 2 + 1 + i * 2;
        if (c >= per) break;
        const s = row * per + c;
        top = Math.max(top, paint(s));
        bottom = Math.max(bottom, paint(s + rs * per));
      }
      return { top: half(top), right: half(right), bottom: half(bottom), left: half(left) };
    };
    for (const cell of this.cells) cell.border = cellBorders(cell.row, cell.col, cell.rowspan, Math.min(cell.colspan, C - cell.col));
    this.border = R && C ? cellBorders(0, 0, R, C) : ZERO;
    this.padding = ZERO;
  }

  /** The <col> and <colgroup> constraints, before the cells (ColumnConstraintsBuilder). */
  columnConstraintsFromElements(limit: number): Column[] {
    const out: Column[] = [];
    const create = (p: ResolvedProps, def: LU | undefined): Column => {
      const w = p.width?.value;
      let size: LU | undefined = typeof w === "number" ? U(w) : undefined;
      let percent = w !== undefined && typeof w === "object" && !w.of ? f32(w.pct) : undefined;
      if (size === undefined) size = def;
      if (percent === 0) percent = undefined;
      const mergeable = this.fixed ? false : (size ?? 0) === 0 && (percent ?? 0) === 0;
      return { min: 0, max: size, percent, pbp: 0, constrained: size !== undefined, fixedTable: this.fixed, mergeable };
    };
    for (const el of this.colEls) {
      if (out.length >= limit) break;
      const isGroup = el.group;
      if (!isGroup) {
        const c = create(el.p, undefined);
        for (let i = 0; i < el.span; i++) out.push({ ...c });
        continue;
      }
      const group = create(el.p, undefined);
      if (el.cols) for (const col of el.cols) {
        const c = create(col.p, !this.fixed ? group.max : undefined);
        for (let i = 0; i < col.span; i++) out.push({ ...c });
      }
      else for (let i = 0; i < el.span; i++) out.push({ ...group });
    }
    return out;
  }
}

/** A cell's min/max constraint (CreateCellInlineConstraint). */
function cellConstraint(g: Grid, cell: Cell): CellC {
  const p = cell.p;
  const bp = cell.border.left + cell.border.right + U(cell.padding.left + cell.padding.right);
  const w = p.width?.value;
  let css: LU | undefined;
  let percent: number | undefined;
  if (typeof w === "number") {
    // The source's width is a border box unless the cell is content-box (its padding and the border it gets added).
    css = cell.contentBox ? U(w) + bp : Math.max(U(w), bp);
  } else if (w !== undefined && typeof w === "object") {
    if (w.of) g.doubts.add("a cell width with a percentage inside calc(), min() or max() isn't modelled");
    else percent = f32(w.pct);
  } else if (w === "fill") percent = 100;
  else if (w === "fit") g.doubts.add("a cell with width: fit-content isn't modelled");
  // Its max-width (fixed: caps both sizes; a percentage only caps a percentage width).
  const mw = p.measure?.value ?? p.maxWidth?.value;
  let cssMax: LU | undefined;
  if (typeof mw === "number") cssMax = cell.contentBox ? U(mw) + bp : Math.max(U(mw), bp);
  else if (mw !== undefined && mw.of) g.doubts.add("a cell max-width with a percentage inside calc(), min() or max() isn't modelled");
  else if (mw !== undefined && percent !== undefined) percent = Math.min(percent, f32(mw.pct));
  let content: { min: number; max: number } | undefined;
  const sizes = () => {
    if (!content) {
      const c = g.h.content(cell.k, true);
      // Content it can't measure counts as none (the table is then approximate).
      if (c.why) g.doubts.add(`its width comes from its cells' content, which can't be measured (${c.why})`);
      content = c.why ? { min: bp, max: bp } : { min: U(c.min) + bp, max: U(c.max) + bp };
    }
    return content;
  };
  {
    let min = g.fixed ? 0 : sizes().min;
    let contentMax = css ?? sizes().max;
    if (cssMax !== undefined) {
      contentMax = Math.min(contentMax, cssMax);
      min = Math.min(min, cssMax);
    }
    const max = Math.max(min, contentMax);
    const pbp = g.fixed && percent !== undefined && cell.contentBox ? bp : 0;
    return { min, max, ...(percent !== undefined && { percent }), pbp, constrained: css !== undefined };
  }
}

function encompassCell(a: CellC, o: CellC) {
  if (o.min > a.min) a.min = o.min;
  if (a.constrained === o.constrained) a.max = Math.max(a.max, o.max);
  else if (a.constrained) a.max = Math.max(a.max, o.min);
  else a.max = Math.max(a.min, o.max);
  a.constrained ||= o.constrained;
  if ((o.percent ?? -Infinity) > (a.percent ?? -Infinity)) {
    a.percent = o.percent;
    a.pbp = o.pbp;
  }
}

function encompassColumn(col: Column, cell: CellC | undefined) {
  if (!cell) return;
  if (col.constrained && col.fixedTable) return;
  if (!col.fixedTable) col.mergeable = false;
  if (col.min !== undefined) {
    if (col.min < cell.min) col.min = cell.min;
    if (col.constrained) col.max = cell.constrained ? Math.max(col.max!, cell.max) : Math.max(col.max!, cell.min);
    else col.max = Math.max(col.max ?? 0, cell.max);
  } else {
    col.min = cell.min;
    col.max = cell.max;
  }
  if (col.min !== undefined && col.max !== undefined) col.max = Math.max(col.min, col.max);
  if ((cell.percent ?? -Infinity) > (col.percent ?? -Infinity)) {
    col.percent = cell.percent;
    col.pbp = cell.pbp;
  }
  col.constrained ||= cell.constrained;
}

const resolvePercent = (c: Column, target: LU): LU => Math.max(c.min ?? 0, fromFloat(f32(f32(c.percent! * toFloat(target)) / 100)) + c.pbp);

/** DistributeInlineSizeToComputedInlineSizeAuto. */
function distributeAuto(target: LU, cols: Column[], constrainedTarget: boolean): LU[] {
  let pctCount = 0;
  let fixedCount = 0;
  let autoCount = 0;
  const guess = [0, 0, 0, 0];
  const inc = [0, 0, 0, 0];
  let totalPercent = 0;
  let autoMax = 0;
  let fixedMax = 0;
  for (const c of cols) {
    if (c.mergeable) continue;
    const min = c.min!;
    const max = c.max!;
    if (c.percent !== undefined) {
      pctCount++;
      totalPercent = f32(totalPercent + c.percent);
      const ps = resolvePercent(c, target);
      guess[0] += min;
      guess[1] += ps;
      guess[2] += ps;
      guess[3] += ps;
      inc[1] += ps - min;
    } else if (c.constrained) {
      fixedCount++;
      fixedMax += max;
      guess[0] += min;
      guess[1] += min;
      guess[2] += max;
      guess[3] += max;
      inc[2] += max - min;
    } else {
      autoCount++;
      autoMax += max;
      guess[0] += min;
      guess[1] += min;
      guess[2] += min;
      guess[3] += max;
      inc[3] += max - min;
    }
  }
  const sizes = cols.map(() => 0);
  target = Math.max(target, guess[0]);
  let start = 4;
  for (let i = 0; i < 4; i++)
    if (guess[i] >= target) {
      start = i;
      break;
    }
  let last = -1;
  const settle = (remaining: number) => {
    if (remaining !== 0 && last >= 0) sizes[last] += remaining;
  };
  if (start === 0) {
    cols.forEach((c, i) => {
      if (!c.mergeable) sizes[i] = c.min ?? 0;
    });
  } else if (start === 1) {
    const distributable = target - guess[0];
    let remaining = distributable;
    cols.forEach((c, i) => {
      if (c.mergeable) return;
      if (c.percent !== undefined) {
        last = i;
        const ps = resolvePercent(c, target);
        const delta = inc[1] > 0 ? mulDiv(distributable, ps - c.min!, inc[1]) : divInt(distributable, pctCount);
        remaining -= delta;
        sizes[i] = c.min! + delta;
      } else sizes[i] = c.min!;
    });
    settle(remaining);
  } else if (start === 2) {
    const distributable = target - guess[1];
    let remaining = distributable;
    cols.forEach((c, i) => {
      if (c.mergeable) return;
      if (c.percent !== undefined) sizes[i] = resolvePercent(c, target);
      else if (c.constrained) {
        last = i;
        const delta = inc[2] > 0 ? mulDiv(distributable, c.max! - c.min!, inc[2]) : divInt(distributable, fixedCount);
        remaining -= delta;
        sizes[i] = c.min! + delta;
      } else sizes[i] = c.min!;
    });
    settle(remaining);
  } else if (start === 3) {
    const distributable = target - guess[2];
    const exact = target === guess[3];
    let remaining = exact ? 0 : distributable;
    cols.forEach((c, i) => {
      if (c.mergeable) return;
      if (c.percent !== undefined) sizes[i] = resolvePercent(c, target);
      else if (c.constrained || exact) sizes[i] = c.max!;
      else {
        last = i;
        const delta = inc[3] > 0 ? mulDiv(distributable, c.max! - c.min!, inc[3]) : divInt(distributable, autoCount);
        remaining -= delta;
        sizes[i] = c.min! + delta;
      }
    });
    settle(remaining);
  } else {
    const distributable = target - guess[3];
    if (autoCount > 0) {
      let remaining = distributable;
      cols.forEach((c, i) => {
        if (c.mergeable) return;
        if (c.percent !== undefined) sizes[i] = resolvePercent(c, target);
        else if (c.constrained) sizes[i] = c.max!;
        else {
          last = i;
          const delta = autoMax > 0 ? mulDiv(distributable, c.max!, autoMax) : divInt(distributable, autoCount);
          remaining -= delta;
          sizes[i] = c.max! + delta;
        }
      });
      settle(remaining);
    } else if (fixedCount > 0 && constrainedTarget) {
      let remaining = distributable;
      cols.forEach((c, i) => {
        if (c.mergeable) return;
        if (c.percent !== undefined) sizes[i] = resolvePercent(c, target);
        else {
          last = i;
          const delta = fixedMax > 0 ? mulDiv(distributable, c.max!, fixedMax) : divInt(distributable, fixedCount);
          remaining -= delta;
          sizes[i] = c.max! + delta;
        }
      });
      settle(remaining);
    } else if (pctCount > 0) {
      let remaining = distributable;
      cols.forEach((c, i) => {
        if (c.mergeable || c.percent === undefined) return;
        last = i;
        const ps = resolvePercent(c, target);
        const delta = totalPercent !== 0 ? fromFloat(f32(f32(toFloat(distributable) * c.percent) / totalPercent)) : divInt(distributable, pctCount);
        remaining -= delta;
        sizes[i] = ps + delta;
      });
      // (Chromium's `last_computed_size` test: the first column never takes the remainder.)
      if (remaining !== 0 && last > 0) sizes[last] += remaining;
    }
  }
  return sizes;
}

/** SynchronizeAssignableTableInlineSizeAndColumnsFixed. */
function distributeFixed(target: LU, cols: Column[]): LU[] {
  const treatFixed = (c: Column) => isFixedCol(c) && c.max !== 0;
  const zeroConstrained = (c: Column) => c.constrained && c.max === 0;
  let pctCount = 0;
  let autoCount = 0;
  let fixedCount = 0;
  let zeroCount = 0;
  let totalPct = 0;
  let totalFixed = 0;
  let assigned = 0;
  const sizes = cols.map(() => 0);
  for (const c of cols) {
    if (c.percent !== undefined) {
      pctCount++;
      totalPct += resolvePercent(c, target);
    } else if (treatFixed(c)) {
      fixedCount++;
      totalFixed += c.max ?? 0;
    } else if (zeroConstrained(c)) zeroCount++;
    else autoCount++;
  }
  let last = -1;
  if (fixedCount > 0) {
    let scale = f32(1);
    let scaleOk = true;
    const targetFixed = Math.max(0, target - totalPct);
    const up = totalFixed < targetFixed && autoCount === 0;
    const down = totalFixed > target;
    if (up || down) {
      if (totalFixed !== 0) scale = f32(toFloat(targetFixed) / toFloat(totalFixed));
      else scaleOk = false;
    }
    cols.forEach((c, i) => {
      if (!treatFixed(c)) return;
      last = i;
      sizes[i] = scaleOk ? fromFloat(f32(scale * toFloat(c.max ?? 0))) : fromFloat(f32(toFloat(target) / fixedCount));
      assigned += sizes[i];
    });
  }
  if (assigned >= target) return sizes;
  if (pctCount > 0) {
    let scale = f32(1);
    let scaleOk = true;
    const up = totalPct < target - assigned && autoCount === 0;
    const down = totalPct > target - assigned;
    if (up || down) {
      if (totalPct !== 0) scale = f32(toFloat(target - assigned) / toFloat(totalPct));
      else scaleOk = false;
    }
    cols.forEach((c, i) => {
      if (c.percent === undefined) return;
      last = i;
      sizes[i] = scaleOk ? fromFloat(f32(scale * toFloat(resolvePercent(c, target)))) : fromFloat(f32(toFloat(target - assigned) / pctCount));
      assigned += sizes[i];
    });
  }
  const distributing = target - assigned;
  const zeroAll = zeroCount === cols.length;
  cols.forEach((c, i) => {
    if (c.percent !== undefined || treatFixed(c)) return;
    if (zeroConstrained(c) && !zeroAll) return;
    last = i;
    sizes[i] = fromFloat(f32(toFloat(distributing) / f32(zeroAll ? zeroCount : autoCount)));
    assigned += sizes[i];
  });
  if (last >= 0) sizes[last] += target - assigned;
  return sizes;
}

interface Colspan {
  c: CellC;
  start: number;
  span: number;
}

function distributeColspanFixed(cs: Colspan, spacing: LU, cols: Column[]) {
  const span = cols.slice(cs.start, cs.start + cs.span);
  let inner = 0;
  let eff = 0;
  let first = true;
  for (const c of span) {
    if (c.mergeable) continue;
    eff++;
    if (!first) inner += spacing;
    else first = false;
  }
  const minS = cs.c.constrained ? Math.max(0, cs.c.min - inner) : 0;
  const maxS = Math.max(0, cs.c.max - inner);
  let errMin = minS;
  let errMax = maxS;
  const newMin = fromFloat(f32(toFloat(minS) / eff));
  const newMax = fromFloat(f32(toFloat(maxS) / eff));
  const newPct = cs.c.percent !== undefined ? f32(cs.c.percent / eff) : undefined;
  let last: Column | undefined;
  for (const c of span) {
    if (c.mergeable) continue;
    last = c;
    errMin -= newMin;
    errMax -= newMax;
    if (c.min === undefined) {
      c.constrained ||= cs.c.constrained;
      c.min = newMin;
    }
    if (c.max === undefined) {
      c.constrained ||= cs.c.constrained;
      c.max = newMax;
    }
    if (c.percent === undefined && !c.constrained && newPct !== undefined) c.percent = newPct;
  }
  if (last) {
    last.min = last.min! + errMin;
    last.max = last.max! + errMax;
  }
}

function distributeColspanAuto(cs: Colspan, spacing: LU, cols: Column[]) {
  if (!cols.length) return;
  const eff = Math.min(cs.span, cols.length - cs.start);
  const span = cols.slice(cs.start, cs.start + eff);
  let inner = 0;
  let first = true;
  for (const c of span)
    if (!c.mergeable) {
      if (!first) inner += spacing;
      else first = false;
    }
  const minS = Math.max(0, cs.c.min - inner);
  const maxS = Math.max(0, cs.c.max - inner);
  if (cs.c.percent !== undefined) {
    let colsPct = 0;
    let all = 0;
    let pctCount = 0;
    let nonPct = 0;
    let nonPctMax = 0;
    for (const c of span) {
      c.max ??= 0;
      c.min ??= 0;
      if (c.mergeable) continue;
      all++;
      if (c.percent !== undefined) {
        pctCount++;
        colsPct = f32(colsPct + c.percent);
      } else {
        nonPct++;
        nonPctMax += c.max;
      }
    }
    const surplus = f32(cs.c.percent - colsPct);
    if (surplus > 0 && all > pctCount)
      for (const c of span) {
        if (c.percent !== undefined || c.mergeable) continue;
        c.percent = nonPctMax !== 0 ? f32(f32(surplus * toFloat(c.max ?? 0)) / toFloat(nonPctMax)) : f32(surplus / nonPct);
      }
  }
  for (const c of span) {
    c.min ??= 0;
    c.max ??= 0;
  }
  let sizes = distributeAuto(minS, span, true);
  span.forEach((c, i) => (c.min = Math.max(c.min!, sizes[i])));
  sizes = distributeAuto(maxS, span, cs.c.constrained);
  span.forEach((c, i) => (c.max = Math.max(Math.max(c.min!, c.max!), sizes[i])));
}

/** ComputeColumnConstraints: the columns, from the <col> elements and the cells. */
function columnConstraints(g: Grid): Column[] {
  const cols = g.columnConstraintsFromElements(Infinity);
  const cellCs: (CellC | undefined)[] = [];
  const spans: Colspan[] = [];
  let firstSection = true;
  let size = 0;
  for (const s of g.sections) {
    if (!s.rows.length) continue;
    let firstRow = true;
    for (const ri of s.rows) {
      for (const cell of g.rows[ri].cells) {
        const ignore = g.fixed && (!firstSection || !firstRow);
        const maxCol = g.fixed ? cell.col + cell.colspan : cell.col + 1;
        if (maxCol > size) size = maxCol;
        if (ignore) continue;
        const c = cellConstraint(g, cell);
        if (cell.colspan === 1) {
          const at = cellCs[cell.col];
          if (at) encompassCell(at, c);
          else cellCs[cell.col] = { ...c };
        } else spans.push({ c, start: cell.col, span: cell.colspan });
      }
      firstRow = false;
    }
    firstSection = false;
  }
  // Column constraints for every cell column; trailing mergeable column elements dropped.
  if (cols.length < size) while (cols.length < size) cols.push({ pbp: 0, constrained: false, fixedTable: g.fixed, mergeable: !g.fixed });
  else if (cols.length > size) {
    let last = cols.length - 1;
    while (last + 1 > size && cols[last].mergeable) last--;
    cols.length = last + 1;
  }
  // A column each spanning cell can distribute to.
  for (const s of spans) {
    const eff = Math.min(s.span, cols.length - s.start);
    const span = cols.slice(s.start, s.start + eff);
    if (span.length) span[0].mergeable = false;
  }
  for (let i = 0; i < size; i++) encompassColumn(cols[i], cellCs[i]);
  spans.sort((a, b) => (a.span === b.span ? a.start - b.start : a.span - b.span));
  for (const s of spans) {
    if (s.span <= 1) continue;
    if (g.fixed) distributeColspanFixed(s, g.spacingX, cols);
    else distributeColspanAuto(s, g.spacingX, cols);
  }
  let total = 0;
  for (const c of cols) {
    if (c.percent !== undefined) {
      if (!g.fixed && c.percent + total > 100) c.percent = f32(100 - total);
      total = f32(total + c.percent);
    }
    c.min ??= 0;
    c.max ??= 0;
  }
  if (g.fixed && total > 100) for (const c of cols) if (c.percent !== undefined) c.percent = f32(f32(c.percent * 100) / total);
  return cols;
}

/** ComputeGridInlineMinMax (with the undistributable space). */
function gridMinMax(cols: Column[], undistributable: LU, fixed: boolean, allowPercent: boolean): { min: LU; max: LU } {
  let min = 0;
  let max = 0;
  let pctEstimate = 0;
  let nonPctMax = 0;
  let pctSum = 0;
  for (const c of cols) {
    if (c.min !== undefined) {
      min += fixed && isFixedCol(c) ? c.max! : c.min;
      if (c.percent !== undefined && c.percent > 0) {
        if (c.max! > 0) pctEstimate = Math.max(pctEstimate, fromFloat(f32(f32(100 / c.percent) * toFloat(c.max! - c.pbp))));
      } else nonPctMax += c.max!;
    }
    if (c.max !== undefined) max += c.max;
    if (c.percent !== undefined) pctSum = f32(pctSum + c.percent);
  }
  pctSum = Math.min(pctSum, 100);
  if (pctSum > 0 && allowPercent) {
    let fromPct = 0;
    if (nonPctMax !== 0) fromPct = pctSum === 100 ? TABLE_MAX : fromFloat(f32(f32(100 / f32(100 - pctSum)) * toFloat(nonPctMax)));
    max = Math.max(max, fromPct, pctEstimate);
  }
  max = Math.max(min, max);
  return { min: min + undistributable, max: max + undistributable };
}

function undistributableSpace(g: Grid, cols: Column[]): LU {
  let n = 2;
  let first = true;
  for (const c of cols)
    if (!c.mergeable) {
      if (first) first = false;
      else n++;
    }
  return g.border.left + g.border.right + g.padding.left + g.padding.right + n * g.spacingX;
}

/** Caption min-content widths (with margins): the table is never narrower. */
function captionMin(g: Grid): LU {
  let min = 0;
  for (const cap of g.captions) {
    const c = g.h.content(cap.k, false);
    if (c.why) {
      g.doubts.add(`its caption's width can't be measured (${c.why})`);
      continue;
    }
    const ins = insets(cap.p);
    const m = cap.p.margin?.value;
    const w = cap.p.width?.value;
    const own = typeof w === "number" ? U(w) : U(c.min) + U(ins.left + ins.right);
    min = Math.max(min, own + U((m?.left ?? 0) + (m?.right ?? 0)));
  }
  return min;
}

/** Cache of each table's width-independent analysis, per laid out width. */
export function tableGrid(h: TableHooks, n: FixtureNode, c: Component, props: ResolvedProps): Grid {
  return new Grid(h, n, c, props);
}

/** The border and padding a table is laid out with (collapsed: half its outer collapsed borders, no padding). */
export function tableInsets(g: Grid): { border: Sides; padding: Sides } {
  const px = (s: Sides): Sides => ({ top: PX(s.top), right: PX(s.right), bottom: PX(s.bottom), left: PX(s.left) });
  return { border: px(g.border), padding: px(g.padding) };
}

/** A table's min-content and max-content width (border box): its columns', at least its captions'. */
export function tableIntrinsic(g: Grid, allowPercent: boolean): TableIntrinsic {
  if (g.why) return { min: 0, max: 0, why: g.why };
  const cols = columnConstraints(g);
  const cap = captionMin(g);
  if (g.doubts.size) return { min: 0, max: 0, why: [...g.doubts][0] };
  const und = undistributableSpace(g, cols);
  const mm = gridMinMax(cols, und, g.fixed, allowPercent);
  // Its min-width counts as content: it is never narrower.
  const minW = g.props.min ? U(g.props.min.value) : 0;
  let min = Math.max(mm.min, cap, minW);
  let max = Math.max(mm.max, cap, minW);
  const w = g.props.width?.value;
  if (g.fixed && w !== undefined && typeof w === "object") max = TABLE_MAX;
  // An empty table: its border and padding (collapsed: nothing).
  if (!cols.length) {
    min = max = Math.max(cap, g.collapse ? 0 : g.border.left + g.border.right + g.padding.left + g.padding.right);
  }
  return { min: PX(min), max: PX(Math.max(min, max)) };
}

/**
 * Lay a table out `w` wide (its used width as the engine computed it from its width or content;
 * `fixedW`: given by a grid or a stretching flex container, not clamped to the columns' minimum),
 * with its CSS height `cssH` (border box, without captions) if any.
 */
export function layoutTable(g: Grid, w: number, fixedW: boolean, cssH: number | undefined): TableResult {
  const h = g.h;
  const assumptions: string[] = [...g.notes];
  if (g.why) return { w, h: 0, children: [], assumptions: [g.why] };
  const cols = columnConstraints(g);
  const capMin = captionMin(g);
  assumptions.push(...g.doubts);
  const bpX = g.border.left + g.border.right + g.padding.left + g.padding.right;
  const und = undistributableSpace(g, cols);
  let assignable: LU;
  const minW = g.props.min ? U(g.props.min.value) : 0;
  if (fixedW) assignable = Math.max(0, Math.max(U(w), minW) - und);
  else {
    const mm = gridMinMax(cols, und, g.fixed, true);
    const used = Math.max(U(w), mm.min, capMin, minW);
    assignable = used - und;
  }
  const sizes = !cols.length ? [] : g.fixed ? distributeFixed(assignable, cols) : distributeAuto(assignable, cols, true);
  // Column locations: mergeable columns with nothing in them take no space (nor border spacing).
  const loc: { offset: LU; size: LU; collapsed: boolean }[] = [];
  let off = g.spacingX;
  let firstCol = true;
  cols.forEach((c, i) => {
    if (c.mergeable && sizes[i] === 0) loc.push({ offset: off, size: 0, collapsed: true });
    else {
      if (firstCol) firstCol = false;
      else off += g.spacingX;
      loc.push({ offset: off, size: sizes[i], collapsed: false });
      off += sizes[i];
    }
  });
  let tableW: LU;
  if (!loc.length) {
    const specified = g.props.width !== undefined && g.props.width.value !== "fit";
    if (fixedW || specified) tableW = assignable + und;
    else if (capMin) tableW = Math.max(capMin, bpX);
    else if (g.collapse) tableW = 0;
    else tableW = assignable + bpX;
  } else tableW = loc.at(-1)!.offset + loc.at(-1)!.size + bpX + g.spacingX;
  tableW = Math.max(tableW, capMin);
  const spacingX = loc.length ? g.spacingX : 0;
  const spacingY = loc.length ? g.spacingY : 0;
  const gridInner = tableW - bpX;

  // Captions, at the table's width.
  const capBoxes = g.captions.map((cap) => {
    const m = cap.p.margin?.value ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const b = h.measure(cap.k, PX(tableW), undefined, {});
    const free = U(PX(tableW) - b.w - m.left - m.right);
    const x = m.autoLeft && m.autoRight ? U(m.left) + Math.trunc(free / 2) : m.autoLeft ? U(m.left) + Math.max(0, free) : U(m.left);
    const d = h.doubtful(b);
    if (d) assumptions.push(`its width and height depend on its caption #${b.id}, which the engine can't guarantee (${d})`);
    return { cap, b, x, m, side: cap.p.part?.value.side ?? "top" };
  });
  const capsH = capBoxes.reduce((s, c) => s + U(c.b.h) + U(c.m.top) + U(c.m.bottom), 0);
  void capsH;

  // Row heights: each cell laid out at its columns' width, its content's height (CSS height aside).
  const cellW = (cell: Cell) => {
    const end = Math.min(cell.col + cell.colspan - 1, loc.length - 1);
    return loc[end].offset + loc[end].size - loc[cell.col].offset;
  };
  const over = (cell: Cell): Partial<ResolvedProps> => {
    const b = cell.border;
    const border = cell.p.border ? { ...cell.p.border, value: { ...cell.p.border.value, widths: { top: PX(b.top), right: PX(b.right), bottom: PX(b.bottom), left: PX(b.left) } } } : b.top || b.right || b.bottom || b.left ? { value: { color: "transparent", widths: { top: PX(b.top), right: PX(b.right), bottom: PX(b.bottom), left: PX(b.left) } }, display: "collapsed", steps: [] } : undefined;
    return { border, height: undefined, minHeight: undefined, aspect: undefined, maxWidth: undefined, measure: undefined, margin: undefined };
  };
  interface Laid {
    cell: Cell;
    box: Box;
    /** Its height laid out with an indefinite height (its content's). */
    natural: LU;
    baseline?: LU;
  }
  // A doubt about a cell's content is about the whole table when that content sizes its columns
  // (auto layout; fixed layout reads only widths) or when one row's height moves others (a rowspan,
  // a height the rows share); otherwise it's the cell's: its row and what's below move (the
  // engine's spread). In an anonymous row it's the table's too (its cells have no row box).
  const shared = cssH !== undefined || g.cells.some((c) => c.rawRowspan > 1) || g.sections.some((s) => s.p?.height);
  const local = (cell: Cell) => !shared && !!g.rows[cell.row].k;
  const sizesColumns = (cell: Cell) => !g.fixed || !local(cell);
  const laid: Laid[] = g.cells.map((cell) => {
    const cw = PX(cellW(cell));
    const box = h.measure(cell.k, cw, cw, over(cell));
    const natural = U(box.h);
    const d = h.doubtful(box);
    if (d && sizesColumns(cell)) assumptions.push(`its columns depend on #${box.id}, which the engine can't guarantee (${d})`);
    // Doubts about a row's height alone (a cell in an anonymous row: about the table's).
    const heightDoubt = (why: string) => (local(cell) ? box.assumptions : assumptions).push(why);
    let baseline: LU | undefined;
    if (cell.align === "baseline") {
      const bl = firstBaseline(h, box);
      if (bl === "unknown") heightDoubt(`a cell aligned to its row's baseline whose first line's baseline isn't known (<${cell.k.node.tag}> #${box.id})`);
      else baseline = bl;
    }
    if (box.props.heightPct || box.children.some((k) => k.props.heightPct)) heightDoubt(`a percentage height inside a table cell isn't modelled (#${box.id})`);
    return { cell, box, natural, ...(baseline !== undefined && { baseline }) };
  });
  const laidOf = new Map(laid.map((l) => [l.cell, l]));
  const cssBlock = (cell: Cell): LU | undefined => {
    const hp = cell.p.height?.value;
    if (hp === undefined) return undefined;
    const bp = cell.border.top + cell.border.bottom + U(cell.padding.top + cell.padding.bottom);
    return cell.contentBox ? bp + U(hp) : Math.max(bp, U(hp));
  };

  interface RowC {
    size: LU;
    baseline?: LU;
    constrained: boolean;
    rowspanStart: boolean;
  }
  const rowsC: RowC[] = [];
  const sectionsC: { start: number; count: number; size: LU; constrained: boolean; tbody: boolean; redistribute: boolean }[] = [];
  g.sections.forEach((s, si) => {
    const spans: { start: number; span: number; min: LU }[] = [];
    let total = 0;
    for (const ri of s.rows) {
      const row = g.rows[ri];
      let maxCell = 0;
      let constrained = false;
      let rowspanStart = false;
      let ascent: LU | undefined;
      let descent: LU | undefined;
      for (const cell of row.cells) {
        const l = laidOf.get(cell)!;
        const css = cssBlock(cell);
        const spanning = cell.rowspan > 1;
        if (cell.p.height && !spanning) constrained = true;
        if (cell.align === "baseline" && l.baseline !== undefined && hasContent(l.box)) {
          ascent = Math.max(ascent ?? -Infinity, l.baseline);
          if (spanning) descent ??= 0;
          else descent = Math.max(descent ?? -Infinity, l.natural - l.baseline);
        }
        if (!spanning) maxCell = Math.max(maxCell, l.natural, css ?? 0);
        else {
          rowspanStart = true;
          spans.push({ start: ri, span: cell.rowspan, min: Math.max(l.natural, css ?? 0) });
        }
      }
      const rh = row.p?.height?.value;
      if (rh !== undefined) {
        constrained = true;
        maxCell = Math.max(U(rh), maxCell);
      }
      if (row.p?.heightPct) assumptions.push("a row with a percentage height isn't modelled");
      const size = ascent !== undefined ? Math.max(maxCell, ascent + (descent ?? 0)) : maxCell;
      rowsC[ri] = { size, ...(ascent !== undefined && { baseline: ascent }), constrained, rowspanStart };
      total += size;
    }
    spans.sort((a, b) => {
      if (a.start === b.start && a.span === b.span) return b.min - a.min;
      const enclosed = (x: typeof a, y: typeof a) => x.start >= y.start && x.start + x.span <= y.start + y.span;
      if (enclosed(a, b)) return -1;
      if (enclosed(b, a)) return 1;
      return a.start - b.start;
    });
    for (const sp of spans) distributeRows(rowsC, sp.start, sp.span, sp.min, true, spacingY);
    // (The section's size is its rows' before the rowspans grew them, as Chromium sums it.)
    total += spacingY * Math.max(0, s.rows.length - 1);
    const sh = s.p?.height?.value;
    if (sh !== undefined && U(sh) > total) {
      if (s.rows.length) distributeRows(rowsC, s.rows[0], s.rows.length, U(sh), false, spacingY);
      total = U(sh);
    }
    if (s.p?.heightPct) assumptions.push("a row group with a percentage height isn't modelled");
    sectionsC.push({ start: s.rows[0] ?? 0, count: s.rows.length, size: total, constrained: sh !== undefined, tbody: !!s.tbody, redistribute: false });
  });
  // The table's height: shared between its sections, then their rows.
  const bpY = g.border.top + g.border.bottom + g.padding.top + g.padding.bottom;
  let minimalGrid = 0;
  if (cssH !== undefined) {
    const css = Math.max(U(cssH), bpY);
    minimalGrid = css;
    const distributable = Math.max(0, css - bpY);
    const totalMin = sectionsC.reduce((t, s) => t + s.size, 0);
    if (distributable > totalMin) distributeTable(spacingY, distributable, sectionsC, rowsC);
  }

  // Placement, in layout units from the table's border box.
  const children: Box[] = [];
  let y = 0;
  for (const c of capBoxes.filter((c) => c.side === "top")) {
    y += U(c.m.top);
    c.b.x = PX(c.x);
    c.b.y = PX(y);
    y += U(c.b.h) + U(c.m.bottom);
    children.push(c.b);
  }
  const gridTop = y;
  y += g.border.top + g.padding.top;
  const sectionX = g.border.left + g.padding.left + spacingX;
  const sectionW = Math.max(0, tableW - bpX - 2 * spacingX);
  let started = false;
  g.sections.forEach((s, si) => {
    const sc = sectionsC[si];
    const at = y;
    y += spacingY;
    const childless = !s.rows.length;
    if (childless) y = at;
    const sy = y;
    const rowBoxes: Box[] = [];
    let ry = 0;
    s.rows.forEach((ri, i) => {
      if (i > 0) ry += spacingY;
      const row = g.rows[ri];
      const rc = rowsC[ri];
      const cellBoxes: Box[] = [];
      for (const cell of row.cells) {
        const l = laidOf.get(cell)!;
        let ch = 0;
        for (let k = 0; k < cell.rowspan; k++) ch += rowsC[ri + k].size + (k ? spacingY : 0);
        const b = l.box;
        // Content alignment in the cell's final height (vertical-align).
        const free = ch - l.natural;
        let dy = 0;
        if (cell.align === "middle") dy = Math.trunc(free / 2);
        else if (cell.align === "bottom") dy = free;
        else if (cell.align === "baseline" && l.baseline !== undefined && rc.baseline !== undefined && b.children.length) dy = rc.baseline - l.baseline;
        if (dy) for (const k of b.children) k.y += PX(dy);
        b.h = PX(ch);
        b.x = PX(loc[cell.col].offset - spacingX);
        b.y = 0;
        cellBoxes.push(b);
      }
      if (row.k) {
        const rb = h.box(row.k, { border: undefined, padding: undefined, margin: undefined });
        rb.x = 0;
        rb.y = PX(ry);
        rb.w = PX(sectionW);
        rb.h = PX(rc.size);
        rb.children.push(...cellBoxes);
        rowBoxes.push(rb);
      } else
        for (const b of cellBoxes) {
          b.y += PX(ry);
          rowBoxes.push(b);
        }
      ry += rc.size;
    });
    const size = childless ? sc.size : Math.max(ry, sc.redistribute ? sc.size : ry);
    if (s.k) {
      const sb = h.box(s.k, { border: undefined, padding: undefined, margin: undefined });
      sb.x = PX(sectionX);
      sb.y = PX(sy);
      sb.w = PX(sectionW);
      sb.h = PX(size);
      sb.children.push(...rowBoxes);
      children.push(sb);
    } else
      for (const b of rowBoxes) {
        b.x += PX(sectionX);
        b.y += PX(sy);
        children.push(b);
      }
    y = sy + size;
    started = true;
  });
  void started;
  const sectionsEnd = y;
  const after = g.sections.length ? spacingY : 0;
  const gridH = Math.max(sectionsEnd + after + g.border.bottom + g.padding.bottom - gridTop, minimalGrid);
  y = gridTop + gridH;
  // Columns: at their column's offset, from the first row group's top to the last one's bottom.
  if (g.colEls.length && loc.length) {
    const firstTop = gridTop + g.border.top + g.padding.top + (g.sections.length ? spacingY : 0);
    const colTop = firstTop;
    const colH = Math.max(0, sectionsEnd - firstTop);
    const geom = (start: number, span: number) => {
      const end = Math.min(start + span - 1, loc.length - 1);
      return { x: loc[start].offset, w: loc[end].offset + loc[end].size - loc[start].offset };
    };
    let at = 0;
    const C = loc.length;
    const colBox = (el: ColEl, start: number, span: number, parentX: number): Box | undefined => {
      if (span <= 0 || start >= C) return undefined;
      const gm = geom(start, span);
      const b = h.box(el.k, { border: undefined, padding: undefined, margin: undefined });
      b.x = PX(gm.x - parentX);
      b.y = 0;
      b.w = PX(gm.w);
      // (A column of no width has no height either.)
      b.h = gm.w ? PX(colH) : 0;
      return b;
    };
    for (const el of g.colEls) {
      if (at >= C) {
        h.skip(el.k.node);
        continue;
      }
      const group = el.group;
      if (!group) {
        const span = Math.min(el.span, C - at);
        const b = colBox(el, at, span, 0);
        if (b) {
          b.x += PX(g.border.left + g.padding.left);
          b.y = PX(colTop);
          children.push(b);
        }
        at += span;
        continue;
      }
      const start = at;
      const inner: { el: ColEl; start: number; span: number }[] = [];
      if (el.cols) for (const col of el.cols) {
        if (at >= C) {
          h.skip(col.k.node);
          continue;
        }
        const span = Math.min(col.span, C - at);
        inner.push({ el: col, start: at, span });
        at += span;
      }
      else at += Math.min(el.span, C - at);
      const gb = colBox(el, start, at - start, 0);
      if (!gb) {
        h.skip(el.k.node);
        continue;
      }
      gb.x += PX(g.border.left + g.padding.left);
      gb.y = PX(colTop);
      for (const c of inner) {
        const cb = colBox(c.el, c.start, c.span, loc[start].offset);
        if (cb) gb.children.push(cb);
      }
      children.push(gb);
    }
  } else for (const el of g.colEls) h.skip(el.k.node);
  for (const c of capBoxes.filter((c) => c.side === "bottom")) {
    y += U(c.m.top);
    c.b.x = PX(c.x);
    c.b.y = PX(y);
    y += U(c.b.h) + U(c.m.bottom);
    children.push(c.b);
  }
  return { w: PX(tableW), h: PX(y), children, assumptions };
}

/** Anything in a cell that gives it a baseline (its text, or a child box). */
const hasContent = (b: Box) => !!b.lines?.length || b.children.length > 0;

/**
 * The first baseline of a box, from its border box's top (layout units): its first line's, or its
 * first child's that has one; undefined when it has none, "unknown" when it can't be told.
 */
function firstBaseline(h: TableHooks, b: Box): LU | undefined | "unknown" {
  const ins = insets(b.props);
  if (b.lines?.length) {
    const t = b.props.text?.value;
    if (!t) return "unknown";
    const v = metricsFor(t.font)?.vertical(t.sizePx, t.weight);
    if (!v) return "unknown";
    const lh = h.lineHeight(t.sizePx, t.lineHeight);
    const leading = Math.round((lh - v.ascent - v.descent) * 64);
    const above = Math.floor(Math.trunc(leading / 2) / 64);
    return U(ins.top) + U(v.ascent + above);
  }
  if (b.text) return "unknown";
  const pat = b.props.pattern?.value;
  if (b.children.length && pat !== "flow" && pat !== "stack") return "unknown";
  for (const k of b.children) {
    if (k.props.position?.value.type === "absolute" || k.props.position?.value.type === "fixed") continue;
    if (k.props.overflow || k.props.part || k.props.pattern?.value === "table") return "unknown";
    const kb = firstBaseline(h, k);
    if (kb === "unknown") return kb;
    if (kb !== undefined) return U(ins.top) + U(k.y) + kb;
  }
  return undefined;
}

/** DistributeExcessBlockSizeToRows (rowspanned cells and fixed-height sections). */
function distributeRows(rows: { size: LU; constrained: boolean; rowspanStart: boolean }[], start: number, count: number, desired: LU, rowspan: boolean, spacing: LU) {
  if (count === 0) return;
  const end = start + count;
  const withRowspan: number[] = [];
  const unconstrainedNonEmpty: number[] = [];
  const empty: number[] = [];
  const nonEmpty: number[] = [];
  const unconstrainedEmpty: number[] = [];
  let constrainedNonEmpty = 0;
  let total = 0;
  let unconstrainedSize = 0;
  for (let i = start; i < end; i++) {
    const r = rows[i];
    total += r.size;
    if (rowspan && i !== start && r.rowspanStart) withRowspan.push(i);
    const isEmpty = r.size === 0;
    if (isEmpty) {
      empty.push(i);
      if (!r.constrained) unconstrainedEmpty.push(i);
    } else {
      nonEmpty.push(i);
      if (r.constrained) constrainedNonEmpty++;
      else {
        unconstrainedNonEmpty.push(i);
        unconstrainedSize += r.size;
      }
    }
  }
  const distributable = desired - spacing * (count - 1) - total;
  if (distributable <= 0) return;
  if (withRowspan.length) {
    let rem = distributable;
    for (const i of withRowspan) {
      const d = divInt(distributable, withRowspan.length);
      rows[i].size += d;
      rem -= d;
    }
    const last = rows[withRowspan.at(-1)!];
    last.size = Math.max(0, last.size + rem);
    return;
  }
  if (unconstrainedNonEmpty.length) {
    let rem = distributable;
    for (const i of unconstrainedNonEmpty) {
      const d = mulDiv(distributable, rows[i].size, unconstrainedSize);
      rows[i].size += d;
      rem -= d;
    }
    rows[unconstrainedNonEmpty.at(-1)!].size += rem;
    return;
  }
  if (empty.length) {
    const onlyEmpty = empty.length === count;
    if (rowspan) {
      if (onlyEmpty) {
        rows[empty.at(-1)!].size += distributable;
        return;
      }
    } else if (onlyEmpty || empty.length + constrainedNonEmpty === count) {
      const grow = unconstrainedEmpty.length ? unconstrainedEmpty : empty;
      let rem = distributable;
      for (const i of grow) {
        const d = divInt(distributable, grow.length);
        rows[i].size = d;
        rem -= d;
      }
      rows[grow.at(-1)!].size += rem;
      return;
    }
  }
  if (nonEmpty.length) {
    let rem = distributable;
    for (const i of nonEmpty) {
      const d = mulDiv(distributable, rows[i].size, total);
      rows[i].size += d;
      rem -= d;
    }
    rows[nonEmpty.at(-1)!].size += rem;
  }
}

/** DistributeTableBlockSizeToSections (no percentage sections: those are flagged). */
function distributeTable(
  spacing: LU,
  tableSize: LU,
  sections: { start: number; count: number; size: LU; constrained: boolean; tbody: boolean; redistribute: boolean }[],
  rows: { size: LU; constrained: boolean; rowspanStart: boolean }[],
) {
  if (!sections.length) return;
  const distributable = Math.max(0, tableSize - (sections.length + 1) * spacing);
  let minGuess = 0;
  const auto: number[] = [];
  const fixed: number[] = [];
  const tAuto: number[] = [];
  const tFixed: number[] = [];
  let autoSize = 0;
  let fixedSize = 0;
  let tAutoSize = 0;
  let tFixedSize = 0;
  let hasTbody = false;
  sections.forEach((s, i) => {
    minGuess += s.size;
    hasTbody ||= s.tbody;
    if (s.constrained) {
      fixed.push(i);
      fixedSize += s.size;
      if (s.tbody) {
        tFixed.push(i);
        tFixedSize += s.size;
      }
    } else {
      auto.push(i);
      autoSize += s.size;
      if (s.tbody) {
        tAuto.push(i);
        tAutoSize += s.size;
      }
    }
  });
  if (distributable <= minGuess) return;
  let grow: number[];
  let size: LU;
  if (hasTbody) [grow, size] = tAuto.length ? [tAuto, tAutoSize] : [tFixed, tFixedSize];
  else [grow, size] = auto.length ? [auto, autoSize] : [fixed, fixedSize];
  const extra = distributable - minGuess;
  if (extra > 0 && grow.length) {
    let rem = extra;
    for (const i of grow) {
      const d = size > 0 ? mulDiv(extra, sections[i].size, size) : divInt(extra, grow.length);
      sections[i].size += d;
      sections[i].redistribute = true;
      rem -= d;
    }
    sections[grow.at(-1)!].size += rem;
  }
  for (const s of sections) if (s.redistribute) distributeRows(rows, s.start, s.count, s.size, false, spacing);
}

export type { Grid };
