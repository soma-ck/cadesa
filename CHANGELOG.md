# Changelog

Every release is published to npm by the `release` workflow from a `v*` tag, with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements): the package page
links each version to the commit and workflow run that built it, and
`npm audit signatures` verifies it. No release is published from a laptop.

To use Cadesa where updates must be reviewed, pin a version instead of `npx -y cadesa`:

```sh
npx -y cadesa@0.1.8 check page.html --css app.css
claude mcp add cadesa -- npx -y cadesa@0.1.8 mcp
```

Cadesa reads the files you pass it. The only network requests are to Google Fonts, when you
ask for `metrics --google` or a page loads its fonts from there; your pages are never sent
anywhere. `metrics --measure` and the conformance scripts start a local Chromium.

## Unreleased

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
