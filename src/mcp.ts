/**
 * Cadesa MCP server (stdio). Exposes the same commands as the CLI as agent tools.
 *
 *   { "mcpServers": { "cadesa": { "command": "npx", "args": ["-y", "cadesa", "mcp"] } } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildCmd,
  captureCmd,
  checkCmd,
  checkVerifyCmd,
  critiqueCmd,
  cssCmd,
  explainCmd,
  fontsCmd,
  InputError,
  metricsCmd,
  parseWidths,
  SWEEP,
  liftCmd,
  renderCmd,
  validateCmd,
  whatifCmd,
  type Result,
} from "./commands.js";
import { VERSION } from "./compile.js";
import { CadesaError, formatDiagnostic } from "./diagnostics.js";

const INSTRUCTIONS = `Cadesa is a small styling language (YAML, *.cadesa.yaml) that compiles to plain CSS.
Its layout engine runs without a browser, so you can predict what a style edit does before making it.

Workflow for a style change:
1. cadesa_render the fixture at the widths you care about to see every box (x, y, w×h, wrapped lines).
2. cadesa_explain an element to see where each value comes from (token → breakpoint → YAML path).
3. cadesa_whatif your candidate edit: it applies in memory and reports which boxes move at every width,
   new or fixed issues, and confirms widths that did not change. Iterate here; nothing is written.
4. Edit the .cadesa.yaml file, then cadesa_check and cadesa_build.
Existing CSS: cadesa_lift converts it (or pass css instead of source to any read tool). Boxes marked ≈ are not
exactly predicted for the original CSS; the report says which declaration or browser default is responsible.
Tailwind pages: pass the page as fixture and the compiled Tailwind CSS as tailwind to any read tool; utilities are
lifted the same way, with generated ids (cadesa_lift with tailwind shows them and the source).
A page rendered by JavaScript (Angular, React, CSS-in-JS): cadesa_capture saves its rendered DOM and stylesheets,
then cadesa_check them. cadesa_check with verify=true confirms each finding in Chromium.
Fonts: text is measured from per-font metrics (Inter is bundled). If a report says a font "has no Cadesa metrics"
(text assumed to be one line), call cadesa_fonts on the page: it says where each font comes from, and with
measure=true measures them (once; needs Playwright + Chrome) so every box can be predicted.

Language: tokens.{space,size,color,radius,font}, text roles {font,size,weight,lineHeight,color}, breakpoints
(max-width, desktop-first), styles.<component> with layout {pattern: stack|cluster|grid|layer|flow, gap}
(flow = block flow: vertical margins collapse), padding (token or {block, inline}), margin (space token, or
{block, inline} / {top, right, bottom, left}), background, border, radius, maxWidth (root only),
width (size token | fill; size tokens may be percentages like "50%" of the parent's width), height, text,
slots.<slot> (same props), and when.<breakpoint> overrides that replace properties. Every value is a token name.
HTML uses class="ca-<component>" on the root and "ca-<component>__<slot>" on slots; data-fixture="id" names boxes.`;

const sourceShape = {
  source: z.string().optional().describe("Path to the .cadesa.yaml source (or pass css instead)"),
  css: z
    .string()
    .optional()
    .describe("Path to a plain CSS file to lift on the fly instead of a Cadesa source (several, comma-separated, e.g. a framework's CSS and the app's: bootstrap.css,app.css); boxes it can't predict exactly are marked ≈"),
  sourceText: z
    .string()
    .optional()
    .describe("Optional unsaved YAML to use instead of the file's contents; diagnostics still cite `source`"),
};
/** check and critique sweep every 20px from 320 to 1440 by default (about 4ms per width). */
const sweepWidths = z
  .array(z.number().positive())
  .default(parseWidths(SWEEP))
  .describe("Viewport widths in px (default: every 20px from 320 to 1440, 57 widths)");

const pageShape = {
  ...sourceShape,
  tailwind: z
    .string()
    .optional()
    .describe("Path to the compiled Tailwind CSS for a Tailwind page; fixture is then that page, lifted on the fly (boxes it can't predict exactly are marked ≈)"),
  fixture: z.string().describe("Path to the HTML fixture that uses the component classes (or the Tailwind page, with tailwind)"),
  widths: z.array(z.number().positive()).default([390, 1280]).describe("Viewport widths in px"),
  format: z.enum(["text", "json"]).default("text").describe("text is compact and readable; json has every field"),
};

async function respondAsync(run: () => Promise<Result>, format: "text" | "json" = "text") {
  try {
    const r = await run();
    return respond(() => r, format);
  } catch (e) {
    return respond(() => {
      throw e;
    }, format);
  }
}

function respond(run: () => Result, format: "text" | "json" = "text") {
  try {
    const r = run();
    return {
      content: [{ type: "text" as const, text: format === "json" ? JSON.stringify(r.data, null, 2) : r.text }],
      isError: !r.ok,
    };
  } catch (e) {
    const text =
      e instanceof CadesaError
        ? format === "json"
          ? JSON.stringify({ diagnostics: e.diagnostics }, null, 2)
          : e.diagnostics.map(formatDiagnostic).join("\n\n")
        : e instanceof InputError
          ? e.message
          : `cadesa: ${(e as Error).message}`;
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "cadesa", version: VERSION }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "cadesa_render",
    {
      title: "Render layout",
      description:
        "Lay out an HTML fixture with a Cadesa source at each viewport width, without a browser. Returns every box (x, y, w×h), its layout/padding/width/text and where breakpoint overrides apply, plus layout issues. Set lines=true to see each wrapped text line with its width.",
      inputSchema: { ...pageShape, lines: z.boolean().default(false).describe("Include wrapped text lines") },
      annotations: readOnly,
    },
    (a) => respond(() => renderCmd(a), a.format),
  );

  server.registerTool(
    "cadesa_whatif",
    {
      title: "Predict an edit",
      description:
        "Apply one or more edits to the Cadesa source IN MEMORY and report, for every width, which boxes move or resize, which properties change and the provenance of their new values, new and fixed issues, and widths that stay unchanged. Use this before editing the file to choose an edit and to rule out regressions at other widths. Nothing is written.",
      inputSchema: {
        ...pageShape,
        changes: z
          .record(z.string(), z.unknown())
          .describe(
            'Map of dotted YAML path → new value, e.g. {"styles.settings-panel.when.narrow.padding": "panel"}. Values are token names, objects, or YAML scalars.',
          ),
      },
      annotations: readOnly,
    },
    (a) => respond(() => whatifCmd({ ...a, changes: Object.entries(a.changes).map(([path, value]) => ({ path, value })) }), a.format),
  );

  server.registerTool(
    "cadesa_explain",
    {
      title: "Explain an element",
      description:
        "Explain one fixture element (by data-fixture id) at each width: its box, every resolved property with the chain token → breakpoint → YAML path that produced it, breakpoint overrides that apply at other widths, wrapped lines, and issues. Use it to find which YAML path to edit.",
      inputSchema: { ...pageShape, id: z.string().describe("data-fixture id, e.g. save") },
      annotations: readOnly,
    },
    (a) => respond(() => explainCmd(a), a.format),
  );

  server.registerTool(
    "cadesa_check",
    {
      title: "Check design rules",
      description:
        "Check the layout at each width for overflow (horizontal, unbreakable words, text taller than a fixed height), tap targets (WCAG 2.5.8/2.5.5) and text contrast (WCAG AA). With a Cadesa source, each finding names the YAML path to edit. With css or tailwind, each names the element in the page (file:line, tag, classes, text) and the CSS rules that set the property behind it (stylesheet file:line and selector, following var() to where the variable is set); the generated Cadesa path stays in `path` in json. Findings on boxes Cadesa can't predict exactly are marked inconclusive. With verify=true (css or tailwind only; needs Playwright and Chrome/Chromium), the page is then loaded in Chromium at the widths with findings and a few others, and each finding is marked confirmed, not reproduced, or left as predicted; inconclusive findings are decided by what Chromium shows.",
      inputSchema: {
        ...pageShape,
        widths: sweepWidths,
        verify: z.boolean().default(false).describe("Measure the findings in Chromium and mark each confirmed or not reproduced (css or tailwind pages)"),
      },
      annotations: readOnly,
    },
    (a) => (a.verify ? respondAsync(() => checkVerifyCmd(a), a.format) : respond(() => checkCmd(a), a.format)),
  );

  server.registerTool(
    "cadesa_capture",
    {
      title: "Capture a page from a browser",
      description:
        "Load a URL (or a local HTML file) in Chromium, wait for it to render, and save what it rendered for cadesa_check: page.html (the rendered DOM, scripts removed), every stylesheet in cascade order as files (linked, @import-ed, <style> blocks, and CSS-in-JS rules read back from the CSSOM) and the font files the page loaded. Cookies, storage and password or hidden form values are not saved. Returns the exact check command (pass its page as fixture and its stylesheets as css). Needs Playwright and Chrome/Chromium. Pages behind a login: use the CLI, `cadesa capture <url> --login-script login.mjs`.",
      inputSchema: {
        url: z.string().describe("The page: an http(s) URL (e.g. a local dev server) or a path to an HTML file"),
        out: z.string().default("capture").describe("Directory to write page.html, css/ and fonts/ into"),
        wait: z.string().optional().describe("CSS selector to wait for before saving (the app has rendered)"),
        width: z.number().positive().optional().describe("Viewport width to load the page at (default 1280)"),
        format: pageShape.format,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (a) => respondAsync(() => captureCmd(a), a.format),
  );

  server.registerTool(
    "cadesa_critique",
    {
      title: "Critique the design",
      description:
        "Measurable design signals, beyond correctness: font sizes too close to read as levels, headings that don't stand out from their body text, groups whose inner gap isn't smaller than the gap around them, too many left edges at one width, a palette with no accent (or competing accents), and common template tells. Each finding has numbers and the YAML path to edit. Suggestions, not errors.",
      inputSchema: { ...pageShape, widths: sweepWidths },
      annotations: readOnly,
    },
    (a) => respond(() => critiqueCmd(a), a.format),
  );

  server.registerTool(
    "cadesa_lift",
    {
      title: "Lift CSS into Cadesa",
      description:
        "Convert plain CSS (BEM classes: .block, .block__element) into a Cadesa source. Reports every declaration it could not lift and what it can affect (geometry, text, visual, paint, state). With a fixture, reports per width which boxes are still exactly predicted and which may differ from the original CSS, and why. Writes the source only when `out` is given.",
      inputSchema: {
        css: z.string().describe("Path to the CSS file (with tailwind: the compiled Tailwind CSS)"),
        tailwind: z.string().optional().describe("Path to a Tailwind page (HTML) to lift with css; writes the page with generated classes and ids next to out"),
        out: z.string().optional().describe("Write the lifted .cadesa.yaml here"),
        fixture: z.string().optional().describe("HTML fixture for box-level impact"),
        widths: pageShape.widths,
        format: pageShape.format,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) => respond(() => liftCmd(a), a.format),
  );

  server.registerTool(
    "cadesa_fonts",
    {
      title: "Find and measure the page's fonts",
      description:
        "List every font family the page's text is set in (the first family of each font stack), whether Cadesa has metrics for it (and which file they came from), and where each one without metrics comes from: an @font-face with a local file, a Google Fonts link, or a system font (which differs by machine). Text in a font without metrics is assumed to be one line and flagged, so content-sized boxes can't be sized: run this first when render or check reports that. With measure=true, measures every font it can, once, in Chromium (needs Playwright and Chrome/Chromium; Google Fonts and remote @font-face files are downloaded into .cadesa/fonts/) and writes .cadesa/metrics/<family>.metrics.json, which every later command uses.",
      inputSchema: {
        ...pageShape,
        widths: sweepWidths,
        measure: z.boolean().default(false).describe("Measure the fonts that can be measured and write their metrics"),
        system: z
          .boolean()
          .default(false)
          .describe("With measure: also measure system fonts as installed on this machine (the metrics are machine-specific)"),
        out: z.string().optional().describe("Where to write metrics (default .cadesa/metrics)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (a) => respondAsync(() => fontsCmd({ ...a, css: a.tailwind ? undefined : a.css, via: "mcp" }), a.format),
  );

  server.registerTool(
    "cadesa_metrics",
    {
      title: "Measure one font",
      description:
        "Measure one font once in Chromium and write .cadesa/metrics/<family>.metrics.json: a font file (font + family, and weight for a static face), a Google font by name (google; its variable wght axis when it has one, else its static weights), or the font installed on this machine under a name (system + family; machine-specific). Needs Playwright and Chrome/Chromium. To measure everything a page uses, use cadesa_fonts with measure=true instead.",
      inputSchema: {
        font: z.string().optional().describe("Path to a .woff2/.woff/.ttf/.otf file"),
        family: z.string().optional().describe("The font-family name the CSS uses"),
        weight: z.number().min(1).max(1000).optional().describe("A static face's weight (omit for a variable font)"),
        google: z.string().optional().describe('A Google Fonts family name, e.g. "Open Sans"'),
        system: z.boolean().default(false).describe("Measure the installed font named family (machine-specific)"),
        weights: z.array(z.number().min(1).max(1000)).optional().describe("Static weights to measure (google: those available; system: default 400 and 700)"),
        out: z.string().optional().describe("Where to write metrics (default .cadesa/metrics)"),
        format: pageShape.format,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (a) => respondAsync(() => metricsCmd(a), a.format),
  );

  server.registerTool(
    "cadesa_validate",
    {
      title: "Validate source",
      description:
        "Validate a Cadesa source. Errors include file:line:col, the YAML path, the expected values and a did-you-mean suggestion.",
      inputSchema: { ...sourceShape, format: pageShape.format },
      annotations: readOnly,
    },
    (a) => respond(() => validateCmd(a), a.format),
  );

  server.registerTool(
    "cadesa_css",
    {
      title: "Show compiled CSS",
      description: "Compile a Cadesa source and return the CSS without writing it. Output is deterministic.",
      inputSchema: sourceShape,
      annotations: readOnly,
    },
    (a) => respond(() => cssCmd(a)),
  );

  server.registerTool(
    "cadesa_build",
    {
      title: "Build CSS",
      description: "Compile a Cadesa source and write the CSS file. Invalid sources write nothing.",
      inputSchema: { source: z.string().describe("Path to the .cadesa.yaml source"), sourceText: sourceShape.sourceText, out: z.string().describe("Output .css path") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) => respond(() => buildCmd({ ...a, css: undefined })),
  );

  return server;
}

export async function serve() {
  await createServer().connect(new StdioServerTransport());
}
