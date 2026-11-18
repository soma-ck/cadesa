/**
 * Benchmark tasks. Each starts from a broken variant of settings.cadesa.yaml. The plain-CSS arm
 * gets the same starting point compiled to CSS, so both arms begin from identical pixels.
 *
 * Goals are judged on boxes measured in Chromium (never by Cadesa's engine).
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Boxes = Record<string, Rect>;

export interface Task {
  id: string;
  /** The problem as a user would report it. */
  problem: string;
  /** Edits to settings.cadesa.yaml that create the broken starting state. */
  breakSource(yaml: string): string;
  fixture: string;
  /** Width where the bug shows; the goal is judged here. */
  mobile: number;
  goal(b: Boxes): { ok: boolean; detail: string };
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
const right = (r: Rect) => r.x + r.w;

const replaceOnce = (s: string, from: string, to: string) => {
  if (!s.includes(from)) throw new Error(`task setup: "${from}" not found`);
  return s.replace(from, to);
};

export const TASKS: Task[] = [
  {
    id: "stack-actions",
    problem:
      "On phones (390px wide) the two action buttons sit next to each other and wrap awkwardly. On mobile they should be stacked vertically, each spanning the full width of the panel content. Desktop (1280px) must look exactly as it does now.",
    breakSource: (y) =>
      replaceOnce(
        y,
        `        slots:
          actions: { layout: { pattern: stack, gap: control } }
          primary: { width: fill }
          secondary: { width: fill }
`,
        "",
      ),
    fixture: "settings-long.html",
    mobile: 390,
    goal(b) {
      const { save, cancel, actions } = b;
      const stacked = near(save.x, cancel.x) && cancel.y >= save.y + save.h - 0.5;
      const full = near(save.w, actions.w) && near(cancel.w, actions.w);
      return {
        ok: stacked && full,
        detail: `save ${fmt(save)}, cancel ${fmt(cancel)}, actions ${fmt(actions)} (${stacked ? "stacked" : "not stacked"}, ${full ? "full width" : "not full width"})`,
      };
    },
  },
  {
    id: "mobile-padding",
    problem:
      "On phones (390px wide) the panel wastes space: its content starts 32px from the screen edge. On mobile the content should start 16px from the edge. Desktop (1280px) must look exactly as it does now.",
    breakSource: (y) => replaceOnce(y, "        padding: compact\n", "        padding: panel\n"),
    fixture: "settings-long.html",
    mobile: 390,
    goal(b) {
      return { ok: near(b.title.x, 16) && near(right(b.title), 390 - 16), detail: `title ${fmt(b.title)} (needs x=16, right edge 374)` };
    },
  },
  {
    id: "button-overflow",
    problem:
      "On small phones (320px wide) the buttons are wider than the panel and stick out past the edge of the screen. Nothing should overflow at 320px. Desktop (1280px) must look exactly as it does now.",
    breakSource: (y) =>
      replaceOnce(
        replaceOnce(
          replaceOnce(y, "size: { panel: 40rem, control: 2.75rem }", "size: { panel: 40rem, control: 2.75rem, action: 20rem }"),
          "primary: { text: label-inverse, background: ink, radius: control, height: control, padding: { inline: control-inline } }",
          "primary: { text: label-inverse, background: ink, radius: control, height: control, width: action }",
        ),
        "          primary: { width: fill }\n          secondary: { width: fill }\n",
        "",
      ),
    fixture: "settings-long.html",
    mobile: 320,
    goal(b) {
      const worst = Math.max(...Object.values(b).map(right));
      return { ok: worst <= 320 + 0.5, detail: `rightmost box edge at ${worst.toFixed(1)}px (viewport 320px)` };
    },
  },
];

export const DESKTOP = 1280;

export function fmt(r: Rect | undefined) {
  return r ? `${+r.x.toFixed(1)},${+r.y.toFixed(1)} ${+r.w.toFixed(1)}×${+r.h.toFixed(1)}` : "missing";
}

/** Desktop regression: any box moved or resized at 1280px compared with the starting state. */
export function regression(before: Boxes, after: Boxes): string[] {
  const out: string[] = [];
  for (const [id, a] of Object.entries(before)) {
    const b = after[id];
    if (!b) out.push(`#${id} disappeared`);
    else if (!(["x", "y", "w", "h"] as const).every((k) => near(a[k], b[k]))) out.push(`#${id} ${fmt(a)} → ${fmt(b)}`);
  }
  return out;
}
