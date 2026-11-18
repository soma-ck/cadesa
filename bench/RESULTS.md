# Benchmark results

Two kinds of benchmark live here. They measure different jobs:

| | Job | What it measures | Runs | Result |
| --- | --- | --- | --- | --- |
| **Described-bug** (`bench/run.ts`) | Fix a layout bug that the prompt describes, in one component | Solved rate, attempts, regressions at protected widths | 1–2 | Both arms solve everything; plain CSS is cheaper |
| **Discovery** (`bench/discovery/`) | Make a realistic site-wide change without being told where it breaks | Defects shipped across a dense width sweep, and collateral regressions in untouched sections | 3 | Cadesa 21/24 clean, plain CSS 15/24; Cadesa won one task clearly, lost one, tied one |

Cadesa's value in real use (catching problems nobody described, and edits that move things three sections away) is what the discovery benchmark measures. On the described-bug job, both arms solve everything, so those runs mainly show the cost of using Cadesa's tools on a job that doesn't need them. On the discovery job (run 3), the difference comes from one task of three; see the per-task table before quoting the total.

## Described-bug benchmark

### Run 1 (2026-11-18): Cadesa 0.1.0, Claude Code 2.1.327, model `sonnet`

3 tasks × 2 arms × 5 trials, up to 4 rounds, one edit per round, judged in Chromium.
Raw data: [`results/2026-11-18T01-25-14-853Z.json`](results/2026-11-18T01-25-14-853Z.json).

| task | arm | solved | attempts (solved runs) | desktop-regression rounds | turns/round | cost |
| --- | --- | --- | --- | --- | --- | --- |
| stack-actions | css | 5/5 | 1.00 | 0 | 4.0 | $0.38 |
| stack-actions | cadesa | 5/5 | 1.00 | 0 | 4.6 | $0.40 |
| mobile-padding | css | 5/5 | 1.00 | 0 | 4.0 | $0.38 |
| mobile-padding | cadesa | 5/5 | 1.00 | 0 | 3.6 | $0.36 |
| button-overflow | css | 5/5 | 1.00 | 0 | 4.0 | $0.39 |
| button-overflow | cadesa | 4/5 | 1.50 | 0 | 6.5 | $0.91 |

Both arms solved every task; no arm ever regressed desktop. Plain CSS solved all 15 on the first attempt; Cadesa solved 14 of 15 and needed a second round once, because of the language friction described below.

What happened:

- **The tasks are too easy to separate the arms.** Plain CSS is already at the ceiling: one attempt and zero regressions in all 15 runs. Each fix is a single media-query edit, and a strong model gets it right without any preview. These tasks can't show what `whatif` is for: edits whose effects at other widths aren't obvious.
- **Every Cadesa failure was language friction, not a wrong prediction.** On `button-overflow`, agents wrote CSS habits (`width: 100%`, `maxWidth` on a slot) or spent their one edit adding a token before using it. The validator rejected `100%` with a list of size tokens but **never mentioned `fill`**, the keyword that does exactly that. Agents also didn't validate before ending a round.
- **When an agent ran `whatif` before editing (trials 1 and 5), it fixed the bug in one attempt.**

Changes made in response (all in the commit after this run):

- `width: 100%` / `auto` → "width "100%" is spelled fill in Cadesa · did you mean "fill"?"
- Literal lengths → "values are token names … or declare it first: tokens.space.<name>: 12px"
- `maxWidth` on a slot → "only allowed on a component root … use width: fill"
- The Cadesa arm's tool list now includes `./cadesa validate`.

Next: harder tasks where the right edit is not one obvious media-query line (shared tokens used at several widths, text that re-wraps and pushes siblings, nested components), and a rerun.

### Run 2 (2026-11-18): hard tasks, `free` protocol, model `sonnet`

3 hard tasks × 2 arms × 5 trials. A round is one submission (any number of edits, at most 16 tool calls), up to 3 rounds. Every task was checked with `--verify` first: it starts broken, and a known solution passes without touching the protected widths. Raw data: [`results/2026-11-18T01-42-43-442Z.json`](results/2026-11-18T01-42-43-442Z.json).

| task | arm | solved | first try | regression rounds | turns/round | cost |
| --- | --- | --- | --- | --- | --- | --- |
| title-two-lines | css | 5/5 | 5/5 | 0 | 5.2 | $0.42 |
| title-two-lines | cadesa | 5/5 | 5/5 | 0 | 10.0 | $0.57 |
| buttons-one-row | css | 5/5 | 5/5 | 0 | 4.8 | $0.45 |
| buttons-one-row | cadesa | 5/5 | 5/5 | 0 | 11.4 | $0.72 |
| plans-one-row | css | 5/5 | 5/5 | 0 | 6.4 | $0.51 |
| plans-one-row | cadesa | 5/5 | 5/5 | 0 | 9.4 | $0.57 |

**Both arms solved all 15 on the first try with no regressions. Plain CSS used about half the tool calls and cost less.** The harder tasks didn't separate the arms either: for a strong model, fixing a *described* layout problem in plain CSS with screenshots is already solved.

Why Cadesa cost more:

- **CSS has escape hatches the language lacks.** The CSS agents used `@media (min-width: 24rem) and (max-width: 36rem)` so they never had to restore the 320px layout, `flex: 1 1 0` to share a row without arithmetic, and `white-space: nowrap`. Cadesa agents had to compute widths, add a token, and add a breakpoint whose only job was to undo their change at 320px.
- **Cadesa agents verified more.** They ran `validate`, `render --lines` and `check` before submitting, which is more turns for the same outcome.

What this does and doesn't show:

- It shows Cadesa does **not** make a strong model better at fixing a layout problem someone has already described, so Cadesa doesn't claim that.
- It does **not** measure finding problems nobody has described yet. A field report from building a real site with Cadesa found six such bugs before the first build (collapsed nav, wrapped hero image, small tap targets, an orphaned card, staggered cards, long lines). A benchmark for that would give agents a page to build or change and count the latent bugs that ship.
- Language gaps to close: range breakpoints (`min-width`), shared flexible widths in a row (`flex: 1`), and no-wrap labels.

## Discovery benchmark

### Run 3 (2026-11-18): Cadesa at commit 1a07391, Claude Code 2.1.327, model `sonnet`

**The job.** A six-section marketing page (nav, hero, trips, pricing, closing, footer) and a change request a product owner might write. The prompt never says where the page breaks. It gives the definition of done: from 320px to 1440px nothing overflows, no text spills out of a fixed-height box, tap targets are at least 24×24px, no line is longer than 80 characters, nothing overlaps or disappears, and sections the request doesn't concern keep their layout.

| task | request | where it breaks (hidden from the agent) |
| --- | --- | --- |
| `german` | "page.html now holds the final German copy. Make sure the German page works." | "Morgengrauen" overflows the hero title by 3px at 320px only; "Seehundbeobachtungstour" overflows a trip card from 540px to 1440px. Nav, pricing, closing and footer already work in German, so any change there is collateral. |
| `fourth-plan` | Add a fourth plan; from 1024px up all four sit in one row. | The new card holds an unbreakable 27-character e-mail address, which overflows narrow cards. Every section but pricing is protected. |
| `bigger-text` | Make all body text exactly 2px larger; headings, brand and big prices unchanged. | 17px footer links wrap to two lines inside a fixed 44px box from 440px up. No protected sections (every section's text grows); the goal is checked font size by font size. |

**Protocol.** Both arms get the same page at the same starting pixels (the CSS arm edits the CSS the Cadesa source compiles to), the same prompt shape, the same 30-turn and $2 per-run limits, and the same screenshot tool (`node preview.mjs <widths>`: full-page and per-section PNGs at any widths). The Cadesa arm edits `page.cadesa.yaml` and also has `./cadesa check | render | whatif | explain | critique | validate`. One headless `claude -p` run per trial, one submission. The judge loads what shipped in Chromium (never Cadesa's engine) at 58 widths (every 20px from 320 to 1440, plus 1024) and counts defects and collateral changes (any box in a protected section that moved or resized). A trial is **solved** when the goal is met with 0 defects and 0 collateral boxes. Before any model run, `run.ts --verify` showed that each task's known-good solution ships nothing and that a naive edit ships at least one defect.

**Design changes after the pilot: none.** The pilot (one trial per arm per task, `results/discovery-2026-11-18T03-19-18-563Z-pilot.json`, $1.30) had 5 of 6 cells clean; the only miss was the CSS arm's German trial (0 defects, 56 collateral boxes). That suggested the tasks might be too easy, but the full run was launched with the pilot's design before a revision was considered. Once its results existed, changing the tasks would have meant tuning after seeing results, so the design stayed as it was. The full run used 8 trials per cell instead of 5. It finished 47 of 48 trials; the missing `bigger-text` Cadesa trial was run on its own afterwards with the same code and prompt.

Raw data: [`results/discovery-2026-11-18T03-23-51-850Z-full.json`](results/discovery-2026-11-18T03-23-51-850Z-full.json) and [`results/discovery-2026-11-18T03-57-25-005Z-full-t8.json`](results/discovery-2026-11-18T03-57-25-005Z-full-t8.json) (the one top-up trial). Every model run's cost, pilot included, is in [`results/discovery-ledger.json`](results/discovery-ledger.json). Table: `npx tsx bench/discovery/report.ts <both files>`.

| task | arm | solved | goal met | trials shipping a defect | defects shipped (mean) | trials with collateral | collateral boxes (mean) | tool calls | cost / trial |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| german | css | 0/8 | 8/8 | 3/8 | 0.9 | 7/8 | 33.6 | 7.5 | $0.20 |
| german | cadesa | **8/8** | 8/8 | 0/8 | 0.0 | 0/8 | 0.0 | 6.8 | $0.12 |
| fourth-plan | css | **8/8** | 8/8 | 0/8 | 0.0 | 0/8 | 0.0 | 7.0 | $0.16 |
| fourth-plan | cadesa | 5/8 | 8/8 | 3/8 | 0.4 | 0/8 | 0.0 | 16.9 | $0.21 |
| bigger-text | css | 7/8 | 8/8 | 1/8 | 0.1 | n/a | n/a | 23.1 | $0.28 |
| bigger-text | cadesa | 8/8 | 8/8 | 0/8 | 0.0 | n/a | n/a | 22.5 | $0.20 |
| **all** | css | 15/24 | 24/24 | 4/24 | 0.33 | 7/24 | 11.2 | 12.5 | $0.21 |
| **all** | cadesa | **21/24** | 24/24 | 3/24 | 0.13 | 0/24 | 0.0 | 15.4 | $0.18 |

Total model spend for the discovery benchmark: **$10.60** (pilot $1.30, full run $9.11, top-up trial $0.19), against a $45 cap.

**Cadesa won `german` clearly, lost `fourth-plan`, and tied `bigger-text`.** The total (21/24 vs 15/24) comes almost entirely from `german`. With 8 trials per cell, only the `german` difference is clear of chance (8/8 vs 0/8, Fisher's exact p ≈ 0.0002). `fourth-plan` (5/8 vs 8/8, p ≈ 0.2) and `bigger-text` (8/8 vs 7/8) are within noise. If collateral is not counted, `german` is still 8/8 vs 5/8.

How the arms looked at the page: every CSS trial read screenshots (about 3 PNGs per trial), and none ran an automated check. Every Cadesa trial ran `check` (on 11–16 distinct widths per trial on average), only 3 of 24 read a screenshot, 8 of 24 used `whatif`, and none used `critique`.

What happened:

- **`german`: `check` named the bugs; the CSS agents guessed.** Every Cadesa agent ran `./cadesa check` before editing and again across 11–20 widths including 320px. It names each defect and the rule to edit ("Seehundbeobachtungstour" in #seals-name can't wrap and overflows by 20.29px at 540px · edit: styles.trip-card.slots.name.text). All 8 fixed both with two token edits (smaller `display-small` and `card-title` sizes) and nothing else moved. The CSS agents, with no list of what was broken, appended defensive blocks: `min-height` instead of `height` on every control, padding on footer links, wrapping rules everywhere. In 7 of 8 trials that changed 21 to 56 boxes in sections that already worked (the footer grew from 517px to 563px tall at 440px, for example). In trials 3 and 7 the wrapping rule went on the section elements and lost to the compiled stylesheet's per-element `overflow-wrap: normal`, so the trip name still overflowed at 25 widths. Those agents looked at 320px and 1024px shots and reported no overflow. The overflow is 4–20px depending on width, inside a card, and easy to miss in a screenshot.
- **`fourth-plan`: a language gap, then sparse sampling.** Every CSS agent let the e-mail address break with `overflow-wrap: anywhere` and put the plans in one row from 64rem (a four-column grid or a non-wrapping flex row), in 7 tool calls on average. Cadesa has no way to let a long word break (the compiler pins `overflow-wrap: normal`; agents searched `./cadesa --help` for wrap, break and hyphen and found nothing). So Cadesa agents had to make the word fit: smaller `plan` tokens, tighter padding or smaller feature text, and in every trial an auto-fit grid instead of the wrapping row. The grid added column-count breakpoints, and in 3 trials the address overflowed by 4–6px only in two 20px windows (740 and 980px, or 760 and 1000px). Those agents had run `check` at 10–13 widths (trial 1: 320, 360, 400, 500, 600, 700, 800, 900, 1000, 1023, 1024, 1100 and 1440px), which skipped those windows. Asked afterwards about each failing width, `check` reports the overflow every time ("groups@kvitfjordpaddling.no" in #group-f3 can't wrap and overflows by 5.94px at 740px). The prediction was right; the agents didn't ask at those widths.
- **`bigger-text`: near ceiling for both.** The latent bug (two-line footer links in a fixed 44px box) was avoided in 15 of 16 trials. Every Cadesa trial let the links grow (taller `height` token or block padding). CSS trial 3 kept the fixed height and shipped text spilling out at 27 widths (440–1440px). It had looked only at 320px and 1024px shots of the hero and nav, and its summary says "the fixed-height buttons and links (48px and 44px) have room for the larger text".
- **One CSS failure is partly the harness.** In `german` CSS trial 8 the agent's only edit, a shell `cat >> page.css` append, did not reach the file (other trials' identical appends did). The agent then looked at screenshots and reported success, so the original page shipped. Without that trial, `german` CSS is 2/7 trials shipping a defect.
- **Cost.** Cadesa was cheaper per trial overall ($0.18 vs $0.21) despite more tool calls (15.4 vs 12.5), probably because `check` output is short text while screenshots are images. On `fourth-plan` Cadesa cost more ($0.21 vs $0.16), working around the missing word-break.

Limitations:

- **Sample size:** 8 trials per cell, 3 tasks. Only the `german` result would likely survive a rerun; the other two are within noise.
- **One model** (`sonnet` through Claude Code 2.1.327), one page, and task selection by the people building Cadesa. The tasks were designed to have width-specific defects, which is the situation Cadesa's tools target.
- **The CSS arm edits compiled CSS.** Its per-element resets (`overflow-wrap: normal` on every component element) defeated two CSS agents' inherited wrapping rules. Hand-written CSS often has no such resets.
- **Collateral is strict.** Any box that moved or resized in a protected section counts, including changes a reviewer might accept (taller footer links in German). The goal checks only what the request asks for; it doesn't judge appearance.
- **Permissions:** both arms could edit through the shell as well as the edit tools; one CSS edit through the shell didn't land (above).

Language gaps this run exposed: no way to let a long word or address break (`overflow-wrap`/`hyphens`). `check` also takes only the widths it is given; sweeping every 20px would have caught all three Cadesa failures.

