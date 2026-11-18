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
  checkCmd,
  critiqueCmd,
  cssCmd,
  explainCmd,
  InputError,
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

Language: tokens.{space,size,color,radius,font}, text roles {font,size,weight,lineHeight,color}, breakpoints
(max-width, desktop-first), styles.<component> with layout {pattern: stack|cluster, gap}, padding (token or
{block, inline}), background, border, radius, maxWidth (root only), width (size token | fill), height, text,
slots.<slot> (same props), and when.<breakpoint> overrides that replace properties. Every value is a token name.
HTML uses class="ca-<component>" on the root and "ca-<component>__<slot>" on slots; data-fixture="id" names boxes.`;

const sourceShape = {
  source: z.string().optional().describe("Path to the .cadesa.yaml source (or pass css instead)"),
  css: z
    .string()
    .optional()
    .describe("Path to a plain CSS file to lift on the fly instead of a Cadesa source; boxes it can't predict exactly are marked ≈"),
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
  fixture: z.string().describe("Path to the HTML fixture that uses the component classes"),
  widths: z.array(z.number().positive()).default([390, 1280]).describe("Viewport widths in px"),
  format: z.enum(["text", "json"]).default("text").describe("text is compact and readable; json has every field"),
};

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
        "Check the layout at each width for overflow (horizontal, unbreakable words, text taller than a fixed height), tap targets (WCAG 2.5.8/2.5.5), text contrast (WCAG AA) and line length. Each finding names the YAML path to edit; undecidable checks are marked inconclusive.",
      inputSchema: { ...pageShape, widths: sweepWidths },
      annotations: readOnly,
    },
    (a) => respond(() => checkCmd(a), a.format),
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
        css: z.string().describe("Path to the CSS file"),
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
