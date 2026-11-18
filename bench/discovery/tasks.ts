/**
 * Discovery tasks: a realistic change request on a six-section page, whose consequences are
 * width-specific and sometimes far from the edited rule. Agents are never told where things break.
 *
 * Every task is checked by `run.ts --verify` (no model calls): the known-good solution ships 0
 * defects and 0 collateral changes and meets the goal; the naive solution ships defects.
 */
import { readFileSync } from "node:fs";
import type { Snapshot } from "./judge.js";

export interface DiscoveryTask {
  id: string;
  /** The request, as a product owner would write it. */
  request: string;
  /** The page the agent starts from (repo path). */
  html: string;
  /** Sections the request doesn't need to touch; any box that changes in them is collateral. */
  untouched(start: Snapshot[]): string[];
  /** Was the request itself carried out? Judged in Chromium. */
  goal(start: Snapshot[], now: Snapshot[]): { ok: boolean; detail: string };
  /** A known-good edit to the Cadesa source (never shown to agents). */
  solution(yaml: string): string;
  /** What a reasonable but unverified edit looks like, to prove the task has teeth. One per arm. */
  naive: { cadesa?(yaml: string): string; css?(css: string): string };
}

const DIR = "bench/discovery";
const SECTIONS = ["nav", "hero", "trips", "pricing", "closing", "footer"];

const replaceOnce = (s: string, from: string, to: string) => {
  if (!s.includes(from)) throw new Error(`task setup: "${from.slice(0, 70)}" not found`);
  return s.replace(from, to);
};
const chain = (s: string, ...pairs: [string, string][]) => pairs.reduce((acc, [a, b]) => replaceOnce(acc, a, b), s);

/** The English page with a fourth plan card added after the season pass. */
export function fourthPlanHtml(): string {
  const en = readFileSync(`${DIR}/page.html`, "utf8");
  return replaceOnce(
    en,
    `          <a class="ca-plan-card__cta" data-fixture="season-cta" href="#">Get the pass</a>
        </article>
`,
    `          <a class="ca-plan-card__cta" data-fixture="season-cta" href="#">Get the pass</a>
        </article>
        <article class="ca-plan-card" data-fixture="group">
          <h3 class="ca-plan-card__name" data-fixture="group-name">Private group</h3>
          <p class="ca-plan-card__price" data-fixture="group-price">NOK 6,500</p>
          <ul class="ca-plan-card__features" data-fixture="group-features">
            <li class="ca-plan-card__feature" data-fixture="group-f1">Up to six paddlers and one guide</li>
            <li class="ca-plan-card__feature" data-fixture="group-f2">Pick your own date and route</li>
            <li class="ca-plan-card__feature" data-fixture="group-f3">Questions? groups@kvitfjordpaddling.no</li>
          </ul>
          <a class="ca-plan-card__cta" data-fixture="group-cta" href="#">Ask for a quote</a>
        </article>
`,
  );
}

/** Ids whose text the bigger-text request covers: everything but headings, plan prices and the brand. */
function bodyTextIds(s: Snapshot): string[] {
  return Object.keys(s.geo).filter((id) => {
    if (/^(title|trips-title|pricing-title|closing-title|nav-brand)$/.test(id)) return false;
    if (/-(name|heading|price)$/.test(id) && !/^(dawn|glacier|island|seals)-price$/.test(id)) return false;
    return /^(nav-(trips|prices|how|contact)|lede|hero-(book|how)|trips-intro|pricing-lede|closing-(body|book)|footer-fine|col-.*-l\d|.*-meta|.*-f\d|.*-cta|(dawn|glacier|island|seals)-price)$/.test(id);
  });
}

export const TASKS: DiscoveryTask[] = [
  {
    id: "german",
    request:
      "The page has just been translated into German: page.html now holds the final German copy. Make sure the German page works.",
    html: `${DIR}/page.de.html`,
    // The translation touches every section's copy; the sections that work in German as delivered
    // should not need any change.
    untouched: (start) => SECTIONS.filter((s) => !start.some((w) => w.defects.some((d) => d.id === "(page)" ? false : w.geo[d.id.split("+")[0]]?.s === s))),
    goal: () => ({ ok: true, detail: "no separate goal: the copy is fixed; only defects count" }),
    solution: (y) =>
      chain(
        y,
        ["card-min: 15rem", "card-min: 17rem"],
        ["  display-small: { font: ui, size: 2.625rem,", "  display-small: { font: ui, size: 2.5rem,"],
      ),
    naive: { cadesa: (y) => y, css: (c) => c },
  },
  {
    id: "fourth-plan",
    request:
      "We've added a fourth plan, Private group, to the pricing section in page.html. On desktop (every viewport width from 1024px up) all four plans must sit side by side in a single row.",
    html: "fourth-plan",
    untouched: () => SECTIONS.filter((s) => s !== "pricing"),
    goal(_start, now) {
      const bad: number[] = [];
      for (const s of now.filter((x) => x.width >= 1024)) {
        const ys = ["single", "card10", "season", "group"].map((id) => s.geo[id]?.y ?? NaN);
        if (!ys.every((y) => Math.abs(y - ys[0]) < 0.5)) bad.push(s.width);
      }
      return { ok: !bad.length, detail: bad.length ? `plans not in one row at ${bad.join(", ")}px` : "four plans in one row at every width from 1024px" };
    },
    solution: (y) =>
      chain(
        y,
        ["plan: 18rem", "plan: 14.5rem"],
        // The e-mail address is one unbreakable 205px word: narrower side padding makes room for it.
        ["    padding: card\n    background: foam", "    padding: { block: card, inline: snug }\n    background: foam"],
      ),
    naive: {
      cadesa: (y) => replaceOnce(y, "plan: 18rem", "plan: 14.5rem"),
      css: (c) => c + "\n.ca-pricing .ca-plan-card { flex: 1 1 0; width: auto; }\n",
    },
  },
  {
    id: "bigger-text",
    request:
      "Readers tell us the text is too small. Increase the font size of all body text by exactly 2px: paragraphs, trip descriptions and trip prices, plan features, button labels, nav links, footer links and the fine print. Headings, the brand name and the big plan prices keep their current size.",
    html: `${DIR}/page.html`,
    untouched: () => [],
    goal(start, now) {
      const wrong: string[] = [];
      for (let i = 0; i < start.length; i++) {
        const targets = new Set(bodyTextIds(start[i]));
        for (const [id, g] of Object.entries(start[i].geo)) {
          const fs = now[i].geo[id]?.fs ?? NaN;
          const want = targets.has(id) ? g.fs + 2 : g.fs;
          if (!(Math.abs(fs - want) < 0.05) && wrong.length < 8) wrong.push(`#${id} ${fs}px at ${start[i].width}px (want ${want})`);
        }
      }
      return { ok: !wrong.length, detail: wrong.length ? `wrong font sizes: ${wrong.join("; ")}` : "every body text is exactly 2px larger; headings unchanged" };
    },
    solution: (y) =>
      chain(
        y,
        ["  nav-link: { font: ui, size: 0.9375rem,", "  nav-link: { font: ui, size: 1.0625rem,"],
        ["  lede: { font: ui, size: 1.25rem,", "  lede: { font: ui, size: 1.375rem,"],
        ["  lede-small: { font: ui, size: 1.0625rem,", "  lede-small: { font: ui, size: 1.1875rem,"],
        ["  action: { font: ui, size: 1.0625rem,", "  action: { font: ui, size: 1.1875rem,"],
        ["  action-quiet: { font: ui, size: 1.0625rem,", "  action-quiet: { font: ui, size: 1.1875rem,"],
        ["  body: { font: ui, size: 1.0625rem,", "  body: { font: ui, size: 1.1875rem,"],
        ["  body-on-dark: { font: ui, size: 1.0625rem,", "  body-on-dark: { font: ui, size: 1.1875rem,"],
        ["  card-meta: { font: ui, size: 0.9375rem,", "  card-meta: { font: ui, size: 1.0625rem,"],
        ["  price: { font: ui, size: 0.9375rem,", "  price: { font: ui, size: 1.0625rem,"],
        ["  feature: { font: ui, size: 0.9375rem,", "  feature: { font: ui, size: 1.0625rem,"],
        ["  footer-link: { font: ui, size: 0.9375rem, weight: 400, lineHeight: 1.45,", "  footer-link: { font: ui, size: 1.0625rem, weight: 400, lineHeight: 1.45,"],
        ["  fine: { font: ui, size: 0.8125rem,", "  fine: { font: ui, size: 0.9375rem,"],
        // The fixed 44px footer links can't hold two lines of 17px text: let them grow.
        ["      link: { text: footer-link, height: tap }", "      link: { text: footer-link, padding: { block: snug } }"],
      ),
    naive: {
      cadesa: (y) =>
        chain(
          y,
          ["  nav-link: { font: ui, size: 0.9375rem,", "  nav-link: { font: ui, size: 1.0625rem,"],
          ["  lede: { font: ui, size: 1.25rem,", "  lede: { font: ui, size: 1.375rem,"],
          ["  lede-small: { font: ui, size: 1.0625rem,", "  lede-small: { font: ui, size: 1.1875rem,"],
          ["  action: { font: ui, size: 1.0625rem,", "  action: { font: ui, size: 1.1875rem,"],
          ["  action-quiet: { font: ui, size: 1.0625rem,", "  action-quiet: { font: ui, size: 1.1875rem,"],
          ["  body: { font: ui, size: 1.0625rem,", "  body: { font: ui, size: 1.1875rem,"],
          ["  body-on-dark: { font: ui, size: 1.0625rem,", "  body-on-dark: { font: ui, size: 1.1875rem,"],
          ["  card-meta: { font: ui, size: 0.9375rem,", "  card-meta: { font: ui, size: 1.0625rem,"],
          ["  price: { font: ui, size: 0.9375rem,", "  price: { font: ui, size: 1.0625rem,"],
          ["  feature: { font: ui, size: 0.9375rem,", "  feature: { font: ui, size: 1.0625rem,"],
          ["  footer-link: { font: ui, size: 0.9375rem, weight: 400, lineHeight: 1.45,", "  footer-link: { font: ui, size: 1.0625rem, weight: 400, lineHeight: 1.45,"],
          ["  fine: { font: ui, size: 0.8125rem,", "  fine: { font: ui, size: 0.9375rem,"],
        ),
    },
  },
];
