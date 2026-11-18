/**
 * Benchmark tasks. Each starts from a broken (or unfinished) variant of a Cadesa source. The
 * plain-CSS arm gets the same starting point compiled to CSS, so both arms begin from identical
 * pixels. Goals are judged on boxes measured in Chromium, never by Cadesa's engine.
 *
 * easy: one obvious media-query edit (run 1 showed plain CSS at the ceiling on these).
 * hard: the right edit needs exact text measurement, or the obvious edit silently changes a
 *       protected width.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rendered text lines (Chromium: distinct line boxes of the element's text). */
  lines?: number;
  /** Computed font-size in px. */
  fontSize?: number;
}
export type Boxes = Record<string, Rect>;
export type At = Record<number, Boxes>;

export interface Task {
  id: string;
  set: "easy" | "hard";
  /** The problem as a user would report it. */
  problem: string;
  /** Repo paths. */
  source: string;
  fixture: string;
  /** Edits to the source that create the starting state. */
  breakSource(yaml: string): string;
  /** A known-good fix, used only to prove the task is solvable (`run.ts --verify`). Never shown to agents. Omitted: the original source. */
  solution?(yaml: string): string;
  /** Widths the goal is judged at. */
  goalWidths: number[];
  /** Widths where no box may move or resize compared with the starting state. */
  protect: number[];
  goal(at: At): { ok: boolean; detail: string };
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
const right = (r: Rect) => r.x + r.w;

export function fmt(r: Rect | undefined) {
  return r ? `${+r.x.toFixed(1)},${+r.y.toFixed(1)} ${+r.w.toFixed(1)}×${+r.h.toFixed(1)}` : "missing";
}

const replaceOnce = (s: string, from: string, to: string) => {
  if (!s.includes(from)) throw new Error(`task setup: "${from.slice(0, 60)}" not found`);
  return s.replace(from, to);
};
const chain = (s: string, ...pairs: [string, string][]) => pairs.reduce((acc, [a, b]) => replaceOnce(acc, a, b), s);

const SETTINGS = "settings.cadesa.yaml";
const LONG = "fixtures/settings-long.html";
const PRICING = "examples/pricing/pricing.cadesa.yaml";
const PRICING_HTML = "examples/pricing/pricing.html";

const NARROW_SLOTS = `        slots:
          actions: { layout: { pattern: stack, gap: control } }
          primary: { width: fill }
          secondary: { width: fill }
`;

export const TASKS: Task[] = [
  // ------------------------------------------------------------------ easy (run 1)
  {
    id: "stack-actions",
    set: "easy",
    problem:
      "On phones (390px wide) the two action buttons sit next to each other and wrap awkwardly. On mobile they should be stacked vertically, each spanning the full width of the panel content. Desktop (1280px) must look exactly as it does now.",
    source: SETTINGS,
    fixture: LONG,
    breakSource: (y) => replaceOnce(y, NARROW_SLOTS, ""),
    goalWidths: [390],
    protect: [1280],
    goal(at) {
      const { save, cancel, actions } = at[390];
      const stacked = near(save.x, cancel.x) && cancel.y >= save.y + save.h - 0.5;
      const full = near(save.w, actions.w) && near(cancel.w, actions.w);
      return { ok: stacked && full, detail: `save ${fmt(save)}, cancel ${fmt(cancel)}, actions ${fmt(actions)} (${stacked ? "stacked" : "not stacked"}, ${full ? "full width" : "not full width"})` };
    },
  },
  {
    id: "mobile-padding",
    set: "easy",
    problem:
      "On phones (390px wide) the panel wastes space: its content starts 32px from the screen edge. On mobile the content should start 16px from the edge. Desktop (1280px) must look exactly as it does now.",
    source: SETTINGS,
    fixture: LONG,
    breakSource: (y) => replaceOnce(y, "        padding: compact\n", "        padding: panel\n"),
    goalWidths: [390],
    protect: [1280],
    goal(at) {
      const t = at[390].title;
      return { ok: near(t.x, 16) && near(right(t), 374), detail: `title ${fmt(t)} (needs x=16, right edge 374)` };
    },
  },
  {
    id: "button-overflow",
    set: "easy",
    problem:
      "On small phones (320px wide) the buttons are wider than the panel and stick out past the edge of the screen. Nothing should overflow at 320px. Desktop (1280px) must look exactly as it does now.",
    source: SETTINGS,
    fixture: LONG,
    breakSource: (y) =>
      chain(
        y,
        ["size: { panel: 40rem, control: 2.75rem }", "size: { panel: 40rem, control: 2.75rem, action: 20rem }"],
        [
          "primary: { text: label-inverse, background: ink, radius: control, height: control, padding: { inline: control-inline } }",
          "primary: { text: label-inverse, background: ink, radius: control, height: control, width: action }",
        ],
        ["          primary: { width: fill }\n          secondary: { width: fill }\n", ""],
      ),
    solution: (y) =>
      replaceOnce(y, "          actions: { layout: { pattern: stack, gap: control } }\n", "          actions: { layout: { pattern: stack, gap: control } }\n          primary: { width: fill }\n"),
    goalWidths: [320],
    protect: [1280],
    goal(at) {
      const worst = Math.max(...Object.values(at[320]).map(right));
      return { ok: worst <= 320.5, detail: `rightmost box edge at ${worst.toFixed(1)}px (viewport 320px)` };
    },
  },

  // ------------------------------------------------------------------ hard
  {
    id: "title-two-lines",
    set: "hard",
    problem:
      "On small phones (320px wide) the panel title wraps onto three lines. At 320px it must fit on at most two lines, its font-size must stay at least 20px, and the panel content must still start 16px from the screen edge. Nothing may change at 390px or 1280px: every element must keep its exact position and size there.",
    source: SETTINGS,
    fixture: LONG,
    breakSource: (y) => y,
    solution: (y) =>
      chain(
        y,
        ["  label: { font: ui", "  section-title-small: { font: ui, size: 1.3125rem, weight: 650, lineHeight: 1.2, color: ink }\n  label: { font: ui"],
        ["  narrow: 36rem\n", "  narrow: 36rem\n  small: 22.5rem\n"],
        [NARROW_SLOTS, `${NARROW_SLOTS}      small:\n        slots:\n          title: { text: section-title-small }\n`],
      ),
    goalWidths: [320],
    protect: [390, 1280],
    goal(at) {
      const t = at[320].title;
      const ok = (t.lines ?? 9) <= 2 && (t.fontSize ?? 0) >= 19.99 && near(t.x, 16);
      return { ok, detail: `title at 320px: ${t.lines} lines, font-size ${t.fontSize}px, x ${t.x.toFixed(1)} (needs ≤2 lines, ≥20px, x=16)` };
    },
  },
  {
    id: "buttons-one-row",
    set: "hard",
    problem:
      "On phones around 390px wide the two buttons are stacked, and the product team wants them side by side. At 390px: both buttons on the same row, each label on a single line, both buttons at least 44px tall, label text at least 13px, and nothing overflowing the panel. At 320px nothing may change (they stay stacked and full width), and nothing may change at 1280px: every element must keep its exact position and size at those widths.",
    source: SETTINGS,
    fixture: LONG,
    breakSource: (y) => y,
    solution: (y) =>
      chain(
        y,
        ["control-inline: 1.25rem }", "control-inline: 1.25rem, control-tight: 0.625rem }"],
        [
          "  label-inverse: { font: ui",
          "  label-small: { font: ui, size: 0.8125rem, weight: 600, lineHeight: 1.25, color: ink }\n  label-small-inverse: { font: ui, size: 0.8125rem, weight: 600, lineHeight: 1.25, color: surface }\n  label-inverse: { font: ui",
        ],
        ["  narrow: 36rem\n", "  narrow: 36rem\n  small: 22.5rem\n"],
        [
          NARROW_SLOTS,
          `        slots:
          primary: { text: label-small-inverse, padding: { inline: control-tight } }
          secondary: { text: label-small, padding: { inline: control-tight } }
      small:
        slots:
          actions: { layout: { pattern: stack, gap: control } }
          primary: { width: fill, text: label-inverse, padding: { inline: control-inline } }
          secondary: { width: fill, text: label, padding: { inline: control-inline } }
`,
        ],
      ),
    goalWidths: [390],
    protect: [320, 1280],
    goal(at) {
      const { save, cancel, panel } = at[390];
      const inner = right(panel) - 16;
      const row = near(save.y, cancel.y);
      const single = save.lines === 1 && cancel.lines === 1;
      const tall = save.h >= 43.5 && cancel.h >= 43.5;
      const font = (save.fontSize ?? 0) >= 12.99 && (cancel.fontSize ?? 0) >= 12.99;
      const fits = right(save) <= inner + 0.5 && right(cancel) <= inner + 0.5;
      return {
        ok: row && single && tall && font && fits,
        detail: `at 390px save ${fmt(save)} (${save.lines} line, ${save.fontSize}px), cancel ${fmt(cancel)} (${cancel.lines} line, ${cancel.fontSize}px), content right edge ${inner.toFixed(1)}: ${[row ? "same row" : "not on one row", single ? "single-line labels" : "a label wraps", tall ? "≥44px tall" : "too short", font ? "≥13px text" : "text too small", fits ? "fits" : "overflows"].join(", ")}`,
      };
    },
  },
  {
    id: "plans-one-row",
    set: "hard",
    problem:
      "On tablets (768px wide) the three pricing plan cards wrap as two plus one, leaving Enterprise alone on its own row. At 768px all three cards must sit side by side on one row, with nothing overflowing the pricing section. Nothing may change at 390px or 1280px: every element must keep its exact position and size there.",
    source: PRICING,
    fixture: PRICING_HTML,
    breakSource: (y) => y,
    solution: (y) =>
      chain(
        y,
        ["size: { page: 64rem, card: 18rem, control: 2.75rem }", "size: { page: 64rem, card: 18rem, card-compact: 14rem, control: 2.75rem }"],
        ["  narrow: 40rem\n", "  narrow: 40rem\n  medium: 64rem\n"],
        ["    when:\n      narrow:\n        width: fill\n", "    when:\n      medium:\n        width: card-compact\n      narrow:\n        width: fill\n"],
      ),
    goalWidths: [768],
    protect: [390, 1280],
    goal(at) {
      const b = at[768];
      const cards = ["starter", "team", "enterprise"].map((id) => b[id]);
      const row = cards.every((c) => near(c.y, cards[0].y));
      const fits = cards.every((c) => right(c) <= right(b.plans) + 0.5) && Object.values(b).every((r) => right(r) <= 768.5);
      return { ok: row && fits, detail: `at 768px cards ${cards.map(fmt).join(" | ")}, plans ${fmt(b.plans)}: ${row ? "one row" : "not one row"}, ${fits ? "fits" : "overflows"}` };
    },
  },
];

/** Changes at a protected width compared with the starting state. */
export function regression(before: Boxes, after: Boxes): string[] {
  const out: string[] = [];
  for (const [id, a] of Object.entries(before)) {
    const b = after[id];
    if (!b) out.push(`#${id} disappeared`);
    else if (!(["x", "y", "w", "h"] as const).every((k) => near(a[k], b[k]))) out.push(`#${id} ${fmt(a)} → ${fmt(b)}`);
  }
  return out;
}
