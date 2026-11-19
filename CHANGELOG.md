# Changelog

Every release is published to npm by the `release` workflow from a `v*` tag, with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements): the package page
links each version to the commit and workflow run that built it, and
`npm audit signatures` verifies it. No release is published from a laptop.

To use Cadesa where updates must be reviewed, pin a version instead of `npx -y cadesa`:

```sh
npx -y cadesa@0.1.18 check page.html --css app.css
claude mcp add cadesa -- npx -y cadesa@0.1.18 mcp
```

Cadesa reads the files you pass it. The only network requests are to Google Fonts, when you
ask for `metrics --google` or a page loads its fonts from there, and the ones `capture` makes
to load the URL you give it; your pages are never sent anywhere. `metrics --measure`,
`capture`, `check --verify` and the conformance scripts start a local Chromium; `--verify`
serves the page and its stylesheets to it from 127.0.0.1 while it runs.

## Unreleased

- Synthesized bold is measured: text asking for a weight the page has no face for (600 or 700 when
  only a 400 or 500 face is loaded, `<strong>` and `<th>` in such a family) uses the face CSS font
  matching picks, and is as wide and as tall as that face's text. Chromium on Linux emboldens the
  outlines only (probed from 8 to 100px: advances and vertical metrics don't change), so such boxes,
  `≈` before ("weight 700 would be synthesized"), are exact.
- Scroll containers (`overflow: auto` and `scroll`, `.table-responsive`) are exact. Scrollbar widths
  are platform-specific, and the coverage line says which ones the prediction assumes wherever a box
  shows one: by default overlay scrollbars, which take no space (macOS, phones, and the headless
  Chromium `--verify` and the conformance suites run, which hides them), and with `--scrollbars
  classic` (or `CADESA_SCROLLBARS=classic`) the 15px classic scrollbars of Chromium on Windows and
  Linux desktops, which `--verify` then shows too. Classic scrollbars are laid out as Chromium does:
  `scroll` always shows one; `auto` shows one when the content overflows that axis by half a pixel or
  more (its children's border and margin boxes, the end padding and their own overflow), and the box
  is laid out again with it (a vertical one narrows the content, which may then overflow sideways
  and show a horizontal one too); a box sized by its content grows by it; the page's own scrollbars
  narrow the window the page is laid out in (media queries and `vw` keep the whole window), unless
  `html` or `body` hides the overflow. `conformance:bootstrap` goes from 62,315 to 68,858 exact boxes
  of 69,310, all matching, with either kind of scrollbar.

## 0.1.18 (2026-11-19)

0.1.17 was tagged but never published (a test didn't typecheck in the release build); 0.1.18 is the same code.

## 0.1.17 (2026-11-19, not published)

- Rem lengths resolve against the page's root font size (`html { font-size: 62.5% | 10pt | 14px }`),
  in lengths, `calc()`, `clamp()`, custom properties and font sizes, per width range when a media
  query changes the root's size, and following the viewport width when the root's size does. Such
  pages, `≈` throughout in 0.1.16, are laid out exactly.
- Metrics tables measured by an older Cadesa, without vertical metrics or a text field's character
  widths (a face merged into a table from before them counts too), are measured again by `cadesa
  fonts --measure` (machine-specific ones with `--system`), and a measured face is merged into such a
  table without losing what it has. Where a box is `≈` because of what its table lacks, the
  coverage line says `re-measure: cadesa fonts <page> --css <files> --measure`, as does `check`'s
  fonts note.
- Italic text in a real italic face is measured: a page that loads one (`@font-face` with
  `font-style: italic`, or a Google Fonts link with the `ital` axis) gets it measured by `cadesa
  fonts --measure` into its own table (`<family>-italic.metrics.json`; `cadesa metrics <file>
  --italic`, and `--system --italic` for an installed font's), and italic text boxes and runs (`<em>`,
  `<i>`, `<cite>`, `font-style: italic`) are measured with it, vertical metrics too. Italic text in a
  family without an italic face is the upright one slanted, and measured upright. In a source: a text
  role's `style: italic`.
- Inline-blocks with content of their own on lines of text and on lines they share with each other
  are laid out as LayoutNG's line box algorithm places them: an inline-block of several lines (runs
  in other fonts, sizes and weights, `<br>`s) sits on its last line's baseline, as wide as its
  longest line (flagged at widths where that doesn't fit and its content would wrap); a chip of set
  height keeps its line at its top; inline-blocks of different line counts side by side align on
  their last baselines. `vertical-align: top` and `bottom`, on inline-blocks and on runs, are placed
  once the rest of the line is, growing the line box below or above. A run aligned `middle`,
  `text-top`, `text-bottom`, `top` or `bottom` whose content reaches past its strut is measured when
  it can't be split across lines (no break opportunity in it). An inline element made a flex or grid
  item that holds text and a block is blockified. Still `≈`: an inline-block holding blocks on a line
  of text, and such a run that can be split across lines (each line's piece has its own extent).
- Form controls on lines of text: a select, text field, button input, checkbox, radio, range or
  color input of its own size sits on the line as Chromium places it. A native select's baseline,
  pinned down with probe pages, is 1px inside its padding box plus its font's ascent and half its
  line gap (its own line height is always `normal`); in a web font it stays `≈`, as Chromium keeps
  the baseline a select had when it was laid out before the font loaded (up to half a pixel off,
  which depends on when the font arrives). `<input type=color>` is 50×27 with its baseline 21px
  down, at any font. Date, time and file inputs stay `≈` (their inner fields aren't modelled).
- An inline box whose own leading whitespace (spaces before an element in it) collapses into the
  space before it opens on the line that space ends when that line is full there: in a font size or
  line height of its own, that line is as tall as its strut, as LayoutNG takes trailing whitespace.
- `grid-auto-flow: column` and `column dense`: auto-placed items fill a column's rows, then add a
  column (CSS Grid's placement with the axes swapped). In a source: a template's `flow: column`.
- Subgrids: `grid-template-columns: subgrid` on a grid item takes the columns it spans in its parent,
  and its own items size them along with the parent's (rows of a ledger lining up their cells),
  with the parent's column gap. A subgrid with inline padding, border, margins or a gap of its own
  stays `≈`.
- 3D transforms are projected as `getBoundingClientRect()` reports them: `translateZ`,
  `translate3d`, `rotateX`, `rotateY`, `rotate3d`, `scale3d`, `perspective()` and `matrix3d`, about a
  3D `transform-origin`, under the parent's `perspective` and `perspective-origin`, flattened at
  each level (`transform-style: flat`). Part of a box behind the viewer, `preserve-3d`, and lengths
  in viewport units stay `≈`. In a source: `perspective: <px>` or `{ value, origin }`.
- A line height in px with a font size that isn't a whole number of 1/64 px (`40px` at `16.8px`) is
  exactly that many px (it came out 1/64 px short).

## 0.1.16 (2026-11-19)

- Fewer boxes marked exact that weren't: a page whose root font size isn't 16px (`html { font-size:
  10pt }`) is `≈`, as rem lengths are lifted as 16px each.
- A table given its width by a grid track or a stretching flex container is never narrower than its
  caption: its columns fill the caption's width (it laid them out in the track's).
- Inline runs in another size, font, line height or vertical-align are measured: `<small>`,
  `.small` and `font-size: .875em` spans, `<sup>` and `<sub>`, text in another family, nested
  runs, and generated content. Each run is measured in its own font, and each line box is the union
  of the strut and every inline box on it around the baseline, from the fonts' vertical metrics, as
  LayoutNG computes it: sub and super by the parent's font size, middle around its x-height,
  text-top and text-bottom, lengths and percentages. Atomic inlines (an icon, an inline-block of set
  size, one line of text in an inline-block) taller than the line grow it the same way. A run with
  `vertical-align: middle`, `text-top` or `text-bottom` whose content reaches past its own strut, and
  real italic faces, stay `≈`. The browser's own `small`, `sub` and `sup` sizes come from its
  stylesheet (`font-size: smaller`).
- `align-items: baseline` in a flex row is laid out for any items: each item's first baseline (its
  first line's, a nested block's, or one synthesized at the bottom of its border box) sits on the
  line's, and the line is as tall as what reaches above that baseline plus what reaches below it. In
  a source: a cluster's `align: baseline`.
- A space before an inline element's end is measured in that element's font (it was measured in the
  text box's).
- Form controls are sized as Chromium sizes them on Linux, measured with probe pages: a `<select>`
  is as wide as its widest option in its font (rounded up to a px) plus the menulist's internal
  padding (4px + 16px for the arrow with native appearance, none with `appearance: none`), and with
  native appearance as tall as its font's normal line plus 2px; a text field (`size=` too) is
  `ceil(average character width × size) + maximum − average character width`, from the font's
  OS/2 and bounding-box widths, now measured into metrics tables (`avgChar`, `maxChar`; the bundled
  ones have them); a `<textarea>` is its `cols` of average characters plus a 15px scrollbar, and
  `rows` lines tall; submit, reset and button inputs are their label at `line-height: normal`;
  checkboxes and radios are 13×13 and ranges 129×16, with the browser's margins, on the baseline at
  their border box's bottom. A `<button>` with a set height centers its text. Bootstrap's
  `.form-select`, `.form-control-sm/lg`, `.form-check` and `.input-group` are exact. A native
  select's place on a line of text, date, color and file inputs stay `≈`.
- `cadesa metrics` measures fonts with contextual alternates almost everywhere (Caveat, and Inter 4
  as Google Fonts serves it) instead of failing with "Set maximum size exceeded": the search for
  runs the font shapes in context is bounded, and a table where it stopped short says so; text in
  that font is then marked `≈`.

## 0.1.15 (2026-11-19)

- Percentage padding and margins are laid out: of the containing block's width on every side, also
  inside `calc()`, `min()`, `max()` and `clamp()` (`padding: 4% 7% 6%`, `margin: 0 auto 5%`). In
  intrinsic sizes they count as 0, as in Chromium; a flex item or an absolutely positioned box adds
  its resolved padding to its content. In a source: padding and margin sides may name a percentage
  size token.
- Auto top and bottom margins take free space: in a column flexbox (a footer pushed down, a body
  centered, before `justify-content`), across a flex row and in a grid area (centering or pushing an
  item, which is then not stretched). In block flow they are 0. In a source: `margin: { top: auto }`.
- A column flexbox aligned `start`, `center` or `end` sizes its items to fit-content (wrapping text
  too) and places them; `align-self` on a flex item is its own alignment in a column or across a
  row. In a source: a stack's `align`, and an item's `place: { align }`.
- Grids are placed and sized by CSS Grid's own algorithm: track lists with `auto`, `min-content`,
  `max-content`, `fit-content()`, `minmax()`, `<n>fr`, percentages, `repeat()` (with `auto-fill` and
  `auto-fit`) and line names; `grid-template-rows`, `grid-template-areas`, `grid-auto-rows` and
  `-columns`, dense packing, `justify-content` and `align-content`; items placed by line numbers
  (negative too), spans, line names and areas (`grid-area: 1 / 1` layers, `grid-column: 1 / -1`),
  auto-placed around them, aligned in their areas by `justify-self`, `align-self` or auto margins.
  Tracks are sized from the items spanning them (span 1 first, then wider spans; flexible tracks
  last), in layout units. A grid's own min-content and max-content widths are measured the same way.
  In a source: a grid's `template` and an item's `place`.
- An input, select, textarea or replaced element with a percentage width or max-width is
  compressible: its min-content width is its padding and border, so a `1fr` column holding a form
  is exact.
- A grid's percentage row gap where its height is stretched or held up by a min-height is decided
  per layout: exact while the grid has one row.
- 2D transforms are drawn where Chromium draws them: `transform` (translate, scale, rotate, skew,
  matrix), the `translate`, `rotate` and `scale` properties and `transform-origin` map the box and
  everything inside it, and its rectangle is the bounding box of its mapped corners, as
  `getBoundingClientRect()` reports. Nothing else moves. 3D transforms and perspective stay `≈`. In
  a source: `transform: "rotate(3deg)"` or `{ value, origin }`.
- Icons and other atomic inlines in text: an inline-block or replaced element of known size inside a
  text box (an icon `<svg>` sized in em with an aspect ratio, a status dot, a small image, an
  inline-block holding one icon glyph such as Font Awesome's `<i class="fa">` or a Bootstrap Icons
  `::before`) is one unbreakable object on its line, with break opportunities around it, when its
  margin box stays within the line's strut. With a font size that follows the viewport its width
  follows it too.
- `cadesa fonts --measure` also measures the characters the page's text uses beyond the standard
  set, such as the Private Use Area codepoints of icon fonts' `content:` values, and measures the
  faces it can when another face of the family can't be fetched. A table that lacks characters the
  page uses is measured again.
- `<svg>`, `<img>`, `<video>` and `<canvas>` take their `width` and `height` attributes as
  presentational hints; an inline `<svg>`'s `viewBox` gives its
  aspect ratio. An `<svg>`'s contents are drawn, not laid out, so an svg of definite size is exact.
- `width: max-content` and `min-content` are laid out; so is `justify-self` on a block in block flow.
- Text in a font size of 0 (an icon button hiding its label) has no width and one line of its line
  height, and `letter-spacing` in em of a font size that follows the viewport is exact.
- A property at its initial value (`font-variant: normal`, `text-transform: none`, `float: none`,
  `filter: none`...) never makes a box `≈`.
- `<input type="hidden">` lays out no box, as in Chromium's stylesheet.
- Fewer boxes marked exact that weren't: an animation of a transform, position or size (its
  `@keyframes`) makes its box and subtree `≈`; so does a transformed box that is `≈`; a box its parent
  centers or end-aligns by its size moves with everything inside it when it is resized; a page-level
  box at its static position moves with the page's content; and a box the engine reports an error on
  counts as `≈` in every report (`check --verify` too).
- The differential fuzzer generates the new constructs too. Three grid cases it found are kept in
  `fixtures/fuzz`. `conformance:css` checks four new pages: spacing, transforms, grid and icons.
- Tables are laid out, as Chromium's LayoutNG lays them out, instead of as one box of unknown
  height: their captions, column groups and columns, row groups, rows and cells all get boxes and
  are checked. Column widths come from the cells' min-content and max-content widths (padding and
  borders included), fixed and percentage widths on cells and `<col>`s, and cells spanning columns,
  shared out by the auto layout's width distribution (or, with `table-layout: fixed`, from the
  columns and the first row). `border-collapse: separate` with `border-spacing`, and `collapse`, where
  each cell gets half of the widest border on each of its edges (Chromium's edge bookkeeping
  included); row heights from the cells' content, their heights and rowspans, a table's height
  shared between its row groups and rows, and `vertical-align: top`, `middle`, `bottom` and
  `baseline` (from the fonts' vertical metrics) inside cells. Bootstrap's `.table`, `.table-sm`,
  `.table-bordered`, `.table-striped`, `.table-group-divider`, `.align-middle`, `.text-nowrap` cells and
  `.table-responsive` are exact, and so are `width: 100%` and `min-width` on a table, the parser's
  implied `<tbody>`, the attributes `width`, `height`, `valign`, `align`, `nowrap`, `cellspacing`,
  `cellpadding` and `border`, and `display: table`, `table-row` and `table-cell` on `<div>`s. In a
  source: `layout: { pattern: table, collapse: true, fixed: true, min: <size> }` with the border
  spacing as `gap` and `rowGap`, and `part: row`, `part: "cell middle"`, `part: "caption bottom"`...
  on its children.
  A cell's `max-width` caps its column (the `max-width: 0` truncation trick included), a
  content-box cell's width and height leave out its padding and the borders it gets, `rowspan="0"`
  spans the rows left in its row group. A table in a flex row is never narrower than its columns,
  and inside a flex or grid container or a table cell its column percentages don't size it. Under
  Tailwind's preflight a table's borders collapse, its cells sit in the middle of their rows and a
  `<th>` is bold. In a column flexbox a table is laid out again at the height the flexbox gives it,
  as Chromium does (rows a rowspan grew may then get taller).
- What stays `≈`: a table with something the browser wraps in an anonymous cell or row (text
  straight in a row, a `<div>` among rows, `display: contents` in it), `visibility: collapse`,
  `border-style: hidden` in a collapsed table, percentage heights on cells, rows and row groups,
  right-to-left and vertical tables, `display: inline-table`: those tables are still one box, as
  before. Inside a laid-out table, a doubt stays where it is: content Cadesa can't measure in a cell
  (an inline run in another font size, say) makes the table `≈` when it sizes the columns (auto
  layout), but only its row and what's below with `table-layout: fixed`, which reads widths only;
  likewise a cell aligned to its row's baseline whose first line Cadesa can't place, or a percentage
  height inside a cell. A rowspan or a height the rows share makes such a doubt the whole table's. Also
  `≈`: a table stretched by a flex row or a grid when that would move its rows, a table's minimum
  contribution to a grid column, a content-box table with collapsed borders and a size, a cell width
  in `calc()` with a percentage, the baseline of a wrapped inline-block alone in a cell.
- `npm run fuzz:tables` compares random tables (structure, borders, spacing, widths, spans,
  alignment, fixed layout, attributes, `<div>` tables, flex and grid parents) with Chromium.
  `conformance:css` gains `fixtures/css/tables.html` and `tables-edge.html` (what the fuzzer
  found), `conformance:bootstrap` `fixtures/bootstrap/tables.html`.

## 0.1.14 (2026-11-19)

- `contain` is laid out. `layout` and `paint` (and `content`, `strict`) make the box an independent
  formatting context, so its children's margins stay inside, and the containing block of its
  absolute and fixed descendants; `paint` also clips what overflows it. `size` sizes the box as if
  it were empty (as tall as its padding and border, its intrinsic widths too), `inline-size` only
  its widths; `style` moves nothing. In a source: `contain: "layout paint"`. `content-visibility:
  auto` is that containment, its height `≈` (off screen its content is skipped). `will-change` and
  `isolation` change nothing, except that `will-change: transform` (like a transform or filter)
  makes an ancestor the containing block of a fixed box, which stays `≈`.
- A `width` or `max-width` with percentages inside `min()`, `max()`, `clamp()` or `calc()`
  (`width: min(440px, 100%)`, `min(1100px, 100% - 28px)`, `calc((100% - 2rem) / 3)`) is computed
  per box against its containing block's width, in float as Chromium evaluates it, then cut to a
  layout unit. In a source: a size token such as `"min(440px, 100%)"`. With `box-sizing:
  content-box` and padding or a border, it stays `≈`; so do percentages inside `height`, padding
  and margins.
- A grid's percentage `row-gap` is laid out as Chromium does it: of a set height, a length; with
  an auto height, the rows are sized without it, then placed that percentage of the grid's final
  content height apart (they overflow it). A grid of one row has no row gap to place, and a flex
  container with a set height takes its percentage row gap of it. In a source: a grid's `rowGap`
  may name a percentage size token. A grid whose height may be stretched, or with a min-height or
  max-height (and more than one row), stays `≈`.
- An absolutely positioned box without offsets is placed at its static position after in-flow
  siblings too: in block flow below the boxes before it and the margins pending there (only those
  before it: what follows can't collapse with it), then its own margin; in a flexbox at the start of
  its content box, as if it were the only item; in a grid at its padding box corner. After empty
  blocks whose margins collapse through the parent, or aligned other than at the start, it stays `≈`.
  A page-level one after the page's content (a router's announcer) sits below it.
- A width or max-width with a percentage in it counts as `auto` (or `none`) in the intrinsic size
  of the box that holds it, as CSS Sizing says for a cyclic percentage: a `1fr` column holding
  `width: min(360px, 100%)` is sized by the card's content.
- `text-wrap: pretty` and `balance` move line breaks but, in Chromium, never change the line count
  (both fall back to greedy breaks otherwise), so the boxes are exact (outside a flex row); the
  reported lines are the greedy ones. The `text-wrap` shorthand is read as its mode and style:
  `nowrap` is `white-space: nowrap`, `stable` lays out as `auto`.
- Several inline-blocks sharing lines (a button group, tags or badges in a row) are laid out: a
  block whose only content is inline-blocks wraps them between each other, one collapsed space of
  its font apart (none when there is no whitespace between them), each line placed by `text-align`
  (start, center or end). With vertical metrics, when every item reaches as far above and below
  the baseline (`baseline` or `middle`: one line of the same text style, or the same height), each
  line box is the union of that and the block's strut. Text that wraps inside an item is flagged at
  the widths where it does; items that differ in extent stay `≈`.
- A top or bottom `auto` margin is 0 in block flow and in a column flexbox with no free space. A
  transform that moves nothing (`translateZ(0)`, `scale(1)`) is no longer `≈`.

## 0.1.13 (2026-11-19)

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
- `height: 100%` (any percentage) inside a flex or grid item that its row stretches is of the
  item's stretched height, as Chromium resolves it once the row is laid out (Bootstrap's `.h-100`
  card in a `.col`): the only in-flow child of a block or column-flex item, border-box or without
  vertical padding and border. In a source, `height` may name a percentage size token: of the
  parent's content height once that is definite (stretched, or set), auto until then.
- Font vertical metrics: metrics tables record each face's ascent, descent, line gap and
  x-height as Chromium measures them (`cadesa metrics` and `cadesa fonts --measure` add them;
  `npm run metrics:vertical` added them to the bundled tables and the font fixtures from the same
  files, nothing else changed). Older tables still load; without vertical metrics the cases
  below stay `≈` as before. With them:
  - An inline-block alone on its line in block flow (a lone button, a badge, an icon in a
    button) is exact for `vertical-align: baseline` and `middle` in any font and size: its line
    box is the union of the line's strut (ascent and descent rounded per size, the leading split
    as Chromium splits it) and its margin box. Where the strut reaches past it, its parent's
    padding takes the difference (text that may wrap is checked at each width). `text-align:
    center` and `right` place it as Chromium does. Its only content an inline-block, a box is
    no longer a text box.
  - An inline element alone between blocks (a smaller note under a card's figures): each of its
    lines is the union of the parent's strut and its own, so the boxes around it are exact; its
    own rectangle (its text's content area) stays `≈`.
  - `line-height: normal` is the font's ascent, descent and line gap.
  - `align-items: baseline` in a flex row aligns text items in different fonts, sizes and line
    heights (each first baseline is its strut's ascent below its content edge).
  - A text field (`text`, `email`, `search`, `password`, `tel`, `url`, `number`), with or
    without native appearance, is one line of its line height, never shorter than normal, plus
    padding and border; alone on its line it is placed like any inline-block. A `<select>`
    keeps its native height (`≈`) unless `appearance: none`.

## 0.1.12 (2026-11-19)

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
- More selectors are decided from the page: `:lang()`, `:dir()`, `:open`, `:placeholder-shown`,
  `:read-only` / `:read-write`, `:valid` / `:invalid` for required controls, `:in-range`,
  `:nth-child(An+B of S)`, `:scope`, `:host`; vendor pseudo-classes Chromium rejects match
  nothing. Still undecided: interactive states (`:hover`, `:focus`..., which don't apply in the
  default state), `:valid` with a pattern or a typed value, and an argument of `:is()` the
  matcher can't parse.
- `:has()` on a page with svg icons is decided: an icon's insides can't match when nothing in
  them has the id, class or attribute the selector needs.
- `color-scheme` counts as paint (it moves nothing), and `env()` resolves as in a desktop
  window: safe-area and keyboard insets are 0, anything else takes its fallback.

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
