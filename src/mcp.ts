/**
 * Cascadio MCP server (stdio). Exposes the same commands as the CLI as agent tools.
 *
 *   { "mcpServers": { "cascadio": { "command": "npx", "args": ["-y", "cascadio", "mcp"] } } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildCmd,
  checkCmd,
  cssCmd,
  explainCmd,
  InputError,
  renderCmd,
  validateCmd,
  whatifCmd,
  type Result,
} from "./commands.js";
import { VERSION } from "./compile.js";
import { CascadioError, formatDiagnostic } from "./diagnostics.js";

const INSTRUCTIONS = `Cascadio is a small styling language (YAML, *.cascade.yaml) that compiles to plain CSS.
Its layout engine runs without a browser, so you can predict what a style edit does before making it.

Workflow for a style change:
1. cascadio_render the fixture at the widths you care about to see every box (x, y, w×h, wrapped lines).
2. cascadio_explain an element to see where each value comes from (token → breakpoint → YAML path).
3. cascadio_whatif your candidate edit: it applies in memory and reports which boxes move at every width,
   new or fixed issues, and confirms widths that did not change. Iterate here; nothing is written.
4. Edit the .cascade.yaml file, then cascadio_check and cascadio_build.

Language: tokens.{space,size,color,radius,font}, text roles {font,size,weight,lineHeight,color}, breakpoints
(max-width, desktop-first), styles.<component> with layout {pattern: stack|cluster, gap}, padding (token or
{block, inline}), background, border, radius, maxWidth (root only), width (size token | fill), height, text,
slots.<slot> (same props), and when.<breakpoint> overrides that replace properties. Every value is a token name.
HTML uses class="ca-<component>" on the root and "ca-<component>__<slot>" on slots; data-fixture="id" names boxes.`;

const sourceShape = {
  source: z.string().describe("Path to the .cascade.yaml source"),
  sourceText: z
    .string()
    .optional()
    .describe("Optional unsaved YAML to use instead of the file's contents; diagnostics still cite `source`"),
};
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
      e instanceof CascadioError
        ? format === "json"
          ? JSON.stringify({ diagnostics: e.diagnostics }, null, 2)
          : e.diagnostics.map(formatDiagnostic).join("\n\n")
        : e instanceof InputError
          ? e.message
          : `cascadio: ${(e as Error).message}`;
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "cascadio", version: VERSION }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "cascadio_render",
    {
      title: "Render layout",
      description:
        "Lay out an HTML fixture with a Cascadio source at each viewport width, without a browser. Returns every box (x, y, w×h), its layout/padding/width/text and where breakpoint overrides apply, plus layout issues. Set lines=true to see each wrapped text line with its width.",
      inputSchema: { ...pageShape, lines: z.boolean().default(false).describe("Include wrapped text lines") },
      annotations: readOnly,
    },
    (a) => respond(() => renderCmd(a), a.format),
  );

  server.registerTool(
    "cascadio_whatif",
    {
      title: "Predict an edit",
      description:
        "Apply one or more edits to the Cascadio source IN MEMORY and report, for every width, which boxes move or resize, which properties change and the provenance of their new values, new and fixed issues, and widths that stay unchanged. Use this before editing the file to choose an edit and to rule out regressions at other widths. Nothing is written.",
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
    "cascadio_explain",
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
    "cascadio_check",
    {
      title: "Check design rules",
      description:
        "Check the layout at each width for overflow (horizontal, unbreakable words, text taller than a fixed height), tap targets (WCAG 2.5.8/2.5.5), text contrast (WCAG AA) and line length. Each finding names the YAML path to edit; undecidable checks are marked inconclusive.",
      inputSchema: pageShape,
      annotations: readOnly,
    },
    (a) => respond(() => checkCmd(a), a.format),
  );

  server.registerTool(
    "cascadio_validate",
    {
      title: "Validate source",
      description:
        "Validate a Cascadio source. Errors include file:line:col, the YAML path, the expected values and a did-you-mean suggestion.",
      inputSchema: { ...sourceShape, format: pageShape.format },
      annotations: readOnly,
    },
    (a) => respond(() => validateCmd(a), a.format),
  );

  server.registerTool(
    "cascadio_css",
    {
      title: "Show compiled CSS",
      description: "Compile a Cascadio source and return the CSS without writing it. Output is deterministic.",
      inputSchema: sourceShape,
      annotations: readOnly,
    },
    (a) => respond(() => cssCmd(a)),
  );

  server.registerTool(
    "cascadio_build",
    {
      title: "Build CSS",
      description: "Compile a Cascadio source and write the CSS file. Invalid sources write nothing.",
      inputSchema: { ...sourceShape, out: z.string().describe("Output .css path") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) => respond(() => buildCmd(a)),
  );

  return server;
}

export async function serve() {
  await createServer().connect(new StdioServerTransport());
}
