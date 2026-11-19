# Changelog

Every release is published to npm by the `release` workflow from a `v*` tag, with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements): the package page
links each version to the commit and workflow run that built it, and
`npm audit signatures` verifies it. No release is published from a laptop.

To use Cadesa where updates must be reviewed, pin a version instead of `npx -y cadesa`:

```sh
npx -y cadesa@0.1.11 check page.html --css app.css
claude mcp add cadesa -- npx -y cadesa@0.1.11 mcp
```

Cadesa reads the files you pass it. The only network requests are to Google Fonts, when you
ask for `metrics --google` or a page loads its fonts from there, and the ones `capture` makes
to load the URL you give it; your pages are never sent anywhere. `metrics --measure`,
`capture`, `check --verify` and the conformance scripts start a local Chromium; `--verify`
serves the page and its stylesheets to it from 127.0.0.1 while it runs.

## Unreleased

- The window height is an input like the widths: `--height <px>` (MCP `height`), 800 by
  default. `vh`, `dvh`, `svh` and `lvh`, percentage heights of the root and `min-height` /
  `max-height` media queries are exact for it, and the coverage line names it ("for an 800px
  tall window"). Conformance and `--verify` open Chromium at that height.
- `position: absolute` and `fixed` are laid out: in the padding box of the nearest positioned
  ancestor (or the window), by px, %, vw offsets and `inset`; as wide as left and right leave,
  their own width, or their content; as tall as top and bottom leave, their own height (a
  percentage of the containing block) or their content. Without offsets they sit at their
  static position, known before any in-flow sibling in block flow (else `≈`). They don't move
  their siblings, aren't counted as anyone's overflow, and a fixed box never scrolls the page.
  `position: relative` offsets shift the box and what it holds; sticky is predicted at scroll
  position 0 and contains absolute children. In a source: `position: { type, top, right, ... }`
  and `page.windowHeight`.
- `::before` and `::after` are laid out from their own cascade. Positioned ones (decorative
  layers, ribbons) move nothing. An empty table or block (the clearfix) is a box of no height:
  the table keeps the last child's margin inside, the block lets it through, and `clear` does
  nothing where nothing floats. Text content (`"/"`, `"\2022"`) is an inline run at the start or
  end of the element's text, with its own weight and padding; a `::before` floated to the start
  of a text box (Bootstrap's breadcrumb divider) shortens its first line. A sized `::before` is a
  flex item or a grid cell. Text in a font without metrics (an icon font), and `counter()`,
  `attr()` or `url()` content, stay `≈`.
- Inline runs in another weight (`<strong>`, `<b>`, `.fw-semibold`) are measured at their weight,
  with lines broken across runs as Chromium does (no kerning across a change of font, or across
  an inline box's margin, border or padding, which take room on the line). Italic text is exact
  when the page loads no italic face of its font (it is the upright face slanted).
- A percentage `column-gap` in a flex row or grid is a share of the content width (and counts as
  0 in intrinsic sizes, as in Chromium). A percentage row gap of a flex container whose height is
  auto is 0; a grid's percentage row gap stays `≈`. In a source: a cluster or grid `gap` may name
  a percentage size token.
- More selectors are decided from the page: `:lang()`, `:dir()`, `:open`, `:placeholder-shown`,
  `:read-only` / `:read-write`, `:valid` / `:invalid` for required controls, `:in-range`,
  `:nth-child(An+B of S)`, `:scope`, `:host`; vendor pseudo-classes Chromium rejects match
  nothing. Still undecided: interactive states (`:hover`, `:focus`..., which don't apply in the
  default state), `:valid` with a pattern or a typed value, and an argument of `:is()` the
  matcher can't parse.

## 0.1.11 (2026-11-19)

0.1.10 was tagged but never published (a test depended on the fonts installed on the release machine); 0.1.11 is the same code.

## 0.1.10 (2026-11-19, not published)

Report, `whatif`, `capture` and `--verify` fixes from running 0.1.9 on two real apps:

- The coverage line names each cause of `≈` as property, value and short reason, grouped
  across selectors (`min-height: 100vh: min-height isn't modelled`), never cut mid-word.
  Before, a cause could be just a selector (`.page-module__x__screen`) or end in "may".
- The coverage line counts the elements a browser shows that Cadesa doesn't lay out (table
  contents, absolutely positioned or floated elements): `! 31 of 77 elements not laid out`.
- `whatif` runs `check` before and after the edit and lists the findings it fixes, the ones
  still there (with their new numbers: a 23.98px button is still under 24px) and new ones.
- `whatif --add-css` appends to the stylesheet that comes last in the page's cascade, and
  reports an added rule that matches no element or loses to a rule already in the CSS:
  `your rule didn't apply: .bar .y { … } at app.css:4 is more specific (0,2,0 vs your 0,1,0)`.
  On plain CSS, a removed declaration shows its initial value (`margin 0px -12px → 0px`).
- `capture` writes the DOM one element per line wherever a line break can't change the
  rendering, so findings point at a useful `page.html:line`; it stops on an error status (404,
  401) instead of saving the error page, notes redirects and stylesheets that failed, and
  suggests `--css capture/css`. `--css` takes a directory of stylesheets, read in name order.
- `--verify` measures overflowing text beside elements and text cut off by its parent, and
  every finding it doesn't measure says why.
- Contrast on a page where nothing sets a background is judged on white, as a browser paints
  it. On `--css` and `--tailwind` pages, the report names no paths in the generated source.
- `fonts --measure` measures only the fonts laid-out text is set in.
- An unexpected error says it is a Cadesa bug to report; `CADESA_DEBUG=1` prints the stack.
  A missing file is reported as such.

Engine and lift fixes from the same field test:

- A lift never aborts on one rule: a combination Cadesa can't express is dropped and its box
  marked `≈`. `aspect-ratio` with a height and no width is modelled (the width follows the
  height; stretched across a column flexbox, it's the column's width).
- Grids with explicit columns: fixed lengths, percentages, `<n>fr` (never narrower than its
  items' min-content) and `minmax(0, <n>fr)`, with `repeat()`, shared in layout units as
  Chromium does; `justify-items` / `place-items`, separate row and column gaps, and a grid's
  intrinsic width in a flex row. `repeat(3, minmax(0, 1fr))` in a flex row and
  `repeat(auto-fill, minmax(0, 1fr))` no longer crash. In a source:
  `layout: { pattern: grid, columns: 3 }` or `columns: [sidebar, "1fr"]`, `justify`, `rowGap`.
- Units: `pt`, `pc`, `in`, `cm`, `mm` and `Q`; `vw` and `calc()` / `min()` / `max()` /
  `clamp()` of px, rem, em and vw, computed at each width, for box lengths and font sizes.
  `vh` (and `dvh`, `svh`, `lvh`) is computed for an 800px tall viewport and the boxes it moves
  are marked `≈`.
- `min-height` (`minHeight`), and `height: 100%` of a parent with a definite height (as auto
  under an auto height; `≈` only inside a flex or grid item, which may be stretched).
- The page: the body's margin (the browser's 8px too, collapsing with the first box's), padding
  and border, and the root element's, as `page.margin`, `page.padding` and `page.outer`.
  `overflow` on `html` or `body` no longer makes the page `≈`.
- `:has()` is decided against the page. Properties that can't move a box (`counter-reset`,
  `text-rendering`, `cursor`, font smoothing...) never make it `≈`.
- `overflow-wrap: break-word` / `anywhere` (or `word-wrap`) lets a long word break: no more
  "can't wrap and overflows".
- A box past the right edge of the viewport is reported: the page scrolls sideways (a gutter
  row whose container has no padding). Not where the page or a box around it clips.
- `align-items: baseline` in a row of text items in one font; `flex: 0 0 <length>` in a row.
- Elements the engine skips under a layout it can't model are named in the coverage count.
- On `--css` and `--tailwind` pages, engine advice is in CSS terms.

## 0.1.9 (2026-11-19)

Fixes from running 0.1.8 on a captured Angular + Bootstrap app:

- CSS values written over several lines (Bootstrap's unminified `font-family` lists) no
  longer break the lift with "Implicit keys need to be on a single line".
- Stylesheets given under other names than the page links (an edited copy) are used in the
  linked places, in order, with a note under the coverage line; `--verify` loads them the same
  way. Before, every box became ≈ with the reason "the page links , which isn't lifted" (the
  file name was dropped from the summary). A linked stylesheet that really is missing is now
  named.
- `--verify` measures the contrast of links and other inline elements inside a text box.
- `capture`, `--verify` and `metrics` work under `npx`: Cadesa depends on `playwright-core`
  (no browser download) and drives the installed Chrome, Chromium or Edge, or
  `$CADESA_CHROME`. Installing Playwright is no longer needed.
- The same issue on several elements (one rule, one colour, six step numbers) is one entry
  listing the elements: "· on 6 elements".

## 0.1.8 (2026-11-18)

- `whatif` previews edits to plain CSS: `--css app.css --add-css ".card { padding: 24px }"`
  appends rules in memory, and `--after app.new.css` compares edited stylesheets (one per
  `--css` file). It reports what moves at each width like an edit to a Cadesa source. The MCP
  tool takes `addCss` and `after`.
- `whatif` folds boxes that only move down into one line per shift.
- On `--css` and `--tailwind` pages, each `check` finding names the element (page file:line,
  tag, classes, the start of its text) and the stylesheet rules behind it (file:line and
  selector, following `var()` to where the variable is set) instead of a path in the generated
  Cadesa source and a generated id. `--json` keeps the Cadesa path in `path` and adds `element`
  and `source`.
- `check --verify` loads the page in Chromium at the widths with findings and six others,
  measures the elements, and marks each finding confirmed or not reproduced. Inconclusive
  findings are decided by what Chromium measures. The MCP tool takes `verify: true`.
- `cadesa capture <url>` (and the `cadesa_capture` MCP tool) saves a page as Chromium rendered
  it: the DOM without scripts, every stylesheet in cascade order (including CSS-in-JS rules
  read back from the CSSOM, and `@import`s inlined), and the fonts it loaded; then prints the
  check command. `--login-script` runs a module before loading the page; no cookies or
  credentials are written.
- The conformance script's serving and measuring code moved to `src/browser.ts`, shared with
  `--verify`.
- `check` and `render` start with a coverage line: how many boxes at how many widths were
  predicted exactly, how many approximately, and the most common reasons. When most of a
  page is approximate, the line says so before any finding.
- `check` groups each issue into one line with the widths where it happens
  (`at 320–560px, 1200px`) instead of one line per width. Definite findings come first,
  then inconclusive ones. Paths are shortened to the working directory.
- Tap targets are only judged on things a user can tap: links with `href`, buttons,
  inputs, selects, textareas, summaries and elements with an interactive `role`. The 44px
  warning applies to controls that are under 44px on both sides; under 24px is still an
  error.
- Contrast stays conclusive when only an element's position is uncertain.
- `whatif` checks the same widths as `check` by default (every 20px from 320 to 1440px)
  plus the width on each side of every breakpoint, and groups widths where the edit does the
  same thing into one block with geometry deltas. It starts with the coverage line, marks
  approximate boxes with ≈, and only reports "unchanged" for boxes predicted exactly. Boxes
  an edit shows or hides are listed.
- Line length moved from `check` to `critique`, reported once per text box with the widths
  where it happens.
- `check` finds text that runs together (`<span>Total</span><span>42</span>` reads
  "Total42": no space, margin, padding, border or gap between them) and text cut off by
  `overflow: hidden` / `text-overflow: ellipsis` where the box is narrower than the text.
  Running-together text is decided from the markup and cascade, so it stays conclusive where
  the layout is approximate.
- Contrast: translucent text (`rgba`, Bootstrap's `.text-muted` and navbar links) is
  shown over its background, a translucent background is blended into the one below it,
  and inline runs with a color or background of their own (`<span class="text-danger">`,
  badges) are checked against what's behind them. Transitions, cursors, outlines, border
  colors and `text-overflow` no longer make contrast inconclusive.
- Findings that depend only on a box's size (tap targets, overflow, clipped text) are
  inconclusive only when that size is uncertain, not when the box only moves.
  `conformance` checks those sizes against Chromium too.
- `overflow` in the language (`hidden`, `clip`, `auto`, `scroll`, or `{ x, y }`) and in
  `--css`: a scroll container keeps its children's margins inside and can shrink below its
  content in a row; content scrolling inside it (`.table-responsive`) is not an overflow.
  Where scrollbars take space (Windows, many Linux setups), the boxes they move are `≈`.
- Bootstrap: inline text hidden at some widths (`d-none d-md-inline`) is left out where
  it's hidden; `inherit` on a property that doesn't inherit is resolved (the navbar's
  container has `flex-wrap: inherit`; Cadesa wrapped an expanded navbar that Chromium
  doesn't); `text-md-end` and flex alignment on an element that is a block at some widths
  no longer make boxes approximate. Two more pages in `conformance:bootstrap` (an app shell
  and a catalog) and a scroll/clip page in `conformance:css`.
- Fix: a lone button with a set height shorter than its line of text (a 20px button on a
  24px line) was marked exact, but the line box makes its parent taller. It's `≈` now.
- Fix: on a line holding several elements of one tag (minified or captured HTML), records
  meant for the second (a `transform`, say) were applied to the first, so a transformed box
  could stay exact. A box with a transform is `≈`, and its tap-target finding inconclusive.
- `check --verify` measures clipped text in Chromium too.

## 0.1.7 (2026-11-18)

- Angular and Bootstrap pages through `--css`: several stylesheets, each where the page
  links it; removal (`none`), per-side borders and padding, negative and auto margins,
  `justify` and `grow`.
- Fix: an Angular `<router-outlet>` sibling was laid out as a block in 0.1.6, moving
  everything after it.
- `conformance:bootstrap` and a ranking of the causes of approximate boxes.

## 0.1.6 (2026-11-18)

- Fonts work out of the box: bundled metrics for eight popular Google Fonts, `cadesa fonts`
  finds a page's fonts, `metrics --google`, `--measure` and `--system`.
- Block flow, margins (including collapsing) and percentage sizes in the language, engine
  and `--css`.

## 0.1.5 (2026-11-18)

- `render --svg` draws the predicted layout as a wireframe.
- Lenient input: optional version, camelCase names, plain-number px, px and % line
  heights, `rgb()` colours.

## 0.1.4 (2026-11-18)

- Differential fuzzer against Chromium, and the engine and text fixes it found.

## 0.1.3 (2026-11-17)

- Tailwind pages through `--tailwind compiled.css`.
- `check` and `critique` sweep every 20px from 320 to 1440px by default.

## 0.1.2 (2026-11-17)

- Report the real version; the CSS header no longer contains one.

## 0.1.0 – 0.1.1 (2026-11-17)

- First releases: the language, engine, `build`, `render`, `whatif`, `explain`, `check`,
  `critique`, `lift` and the MCP server.
