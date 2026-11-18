# Benchmark results

## Run 1 (2026-11-18): Cadesa 0.1.0, Claude Code 2.1.327, model `sonnet`

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

**Plain CSS won or tied every task.** No arm ever regressed desktop.

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

## Run 2 (2026-11-18): hard tasks, `free` protocol, model `sonnet`

3 hard tasks × 2 arms × 5 trials. A round is one submission (any number of edits, at most 16 tool calls), up to 3 rounds. Every task was checked with `--verify` first: it starts broken, and a known solution passes without touching the protected widths. Raw data: [`results/2026-11-18T01-42-43-442Z.json`](results/2026-11-18T01-42-43-442Z.json).

| task | arm | solved | first try | regression rounds | turns/round | cost |
| --- | --- | --- | --- | --- | --- | --- |
| title-two-lines | css | 5/5 | 5/5 | 0 | 5.2 | $0.42 |
| title-two-lines | cadesa | 5/5 | 5/5 | 0 | 10.0 | $0.57 |
| buttons-one-row | css | 5/5 | 5/5 | 0 | 4.8 | $0.45 |
| buttons-one-row | cadesa | 5/5 | 5/5 | 0 | 11.4 | $0.72 |
| plans-one-row | css | 5/5 | 5/5 | 0 | 6.4 | $0.51 |
| plans-one-row | cadesa | 5/5 | 5/5 | 0 | 9.4 | $0.57 |

**Both arms were perfect. Plain CSS was cheaper and used about half the tool calls.** The harder tasks didn't separate the arms either: for a strong model, fixing a *described* layout problem in plain CSS with screenshots is already solved.

Why Cadesa cost more:

- **CSS has escape hatches the language lacks.** The CSS agents used `@media (min-width: 24rem) and (max-width: 36rem)` so they never had to restore the 320px layout, `flex: 1 1 0` to share a row without arithmetic, and `white-space: nowrap`. Cadesa agents had to compute widths, add a token, and add a breakpoint whose only job was to undo their change at 320px.
- **Cadesa agents verified more.** They ran `validate`, `render --lines` and `check` before submitting, which is more turns for the same outcome.

What this does and doesn't show:

- It shows Cadesa does **not** make a strong model better at fixing a layout problem someone has already described. That claim should not appear anywhere.
- It does **not** measure finding problems nobody has described yet. A field report from building a real site with Cadesa found six such bugs before the first build (collapsed nav, wrapped hero image, small tap targets, an orphaned card, staggered cards, long lines). A benchmark for that would give agents a page to build or change and count the latent bugs that ship.
- Language gaps to close: range breakpoints (`min-width`), shared flexible widths in a row (`flex: 1`), and no-wrap labels.
