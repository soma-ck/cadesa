#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  buildCmd,
  checkCmd,
  critiqueCmd,
  explainCmd,
  InputError,
  liftCmd,
  renderCmd,
  validateCmd,
  whatifCmd,
  type Result,
} from "./commands.js";
import { VERSION } from "./compile.js";
import { CadesaError, formatDiagnostic } from "./diagnostics.js";
import { parseSet } from "./project.js";

const HELP = `cadesa ${VERSION}: predict what a style edit will do before you make it

Usage:
  cadesa build    <source.cadesa.yaml> --out <file.css>
  cadesa validate <source.cadesa.yaml>
  cadesa render   <fixture.html> --source <source.cadesa.yaml> [--widths 390,1280] [--lines]
  cadesa whatif   <fixture.html> --source <source.cadesa.yaml> --set <path=value> [--set ...]
  cadesa explain  <fixture.html> --source <source.cadesa.yaml> --id <fixture-id>
  cadesa check    <fixture.html> --source <source.cadesa.yaml>
  cadesa critique <fixture.html> --source <source.cadesa.yaml>   design signals: scale, hierarchy, grouping, alignment, palette, tells
  cadesa lift     <file.css> [--out <file.cadesa.yaml>] [--fixture <fixture.html>]
  cadesa metrics  <font-file> --family <name> [--weight <n>] [--out .cadesa/metrics]
                    measure a font once in Chromium so the engine can measure text set in it
                    (omit --weight for a variable font; repeat per face for static fonts)
  cadesa mcp      start the MCP server on stdio (for Claude Code, Cursor, Codex, ...)

  render, whatif, explain and check also accept --css <file.css> instead of --source:
  the CSS is lifted on the fly, and boxes it can't predict exactly are marked ≈.

Options:
  --widths   viewport widths in px, comma-separated (default 390,1280)
  --json     machine-readable output (for agents)
  --lines    render: print each wrapped line with its width
  -h, --help show this help
`;

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      source: { type: "string" },
      css: { type: "string" },
      fixture: { type: "string" },
      widths: { type: "string", default: "390,1280" },
      set: { type: "string", multiple: true },
      id: { type: "string" },
      family: { type: "string" },
      weight: { type: "string" },
      json: { type: "boolean", default: false },
      lines: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, input] = positionals;
  if (values.help || !cmd) return void process.stdout.write(HELP);
  if (cmd === "mcp") {
    const { serve } = await import("./mcp.js");
    return serve();
  }
  if (cmd === "metrics") {
    const { generateMetrics, writeMetrics } = await import("./metrics.js");
    if (!input) throw new InputError("metrics needs <font-file>");
    if (!values.family) throw new InputError("metrics needs --family <name> (the font-family name your CSS uses)");
    const weight = values.weight ? Number(values.weight) : undefined;
    if (weight !== undefined && !(weight >= 1 && weight <= 1000)) throw new InputError(`invalid --weight "${values.weight}"`);
    const m = await generateMetrics({ font: input, family: values.family, weight });
    const file = writeMetrics(m, values.out ?? ".cadesa/metrics");
    const pairs = Object.values(m.kerning).reduce((n, k) => n + Object.keys(k).length, 0);
    process.stdout.write(
      `wrote ${file}: ${m.family} (${m.kind}${weight ? ` ${weight}` : ", 100–900"}), ${m.chars.length} glyphs, ${pairs} kerning pairs\n`,
    );
    return;
  }

  const need = (v: string | undefined, what: string) => {
    if (!v) throw new InputError(`${cmd} needs ${what}`);
    return v;
  };
  const widths = () =>
    values.widths!.split(",").map((s) => {
      const n = Number(s.trim());
      if (!Number.isFinite(n) || n <= 0) throw new InputError(`invalid width "${s}"`);
      return n;
    });
  const page = () => ({
    source: values.css ? undefined : need(values.source, "--source <source.cadesa.yaml> or --css <file.css>"),
    css: values.css,
    fixture: need(input, "<fixture.html>"),
    widths: widths(),
  });

  let r: Result;
  switch (cmd) {
    case "build":
      r = buildCmd({ source: need(input, "<source.cadesa.yaml>"), out: need(values.out, "--out <file.css>") });
      break;
    case "validate":
      r = validateCmd({ source: need(input, "<source.cadesa.yaml>") });
      break;
    case "render":
      r = renderCmd({ ...page(), lines: values.lines });
      break;
    case "whatif":
      r = whatifCmd({ ...page(), changes: (values.set ?? []).map(parseSet) });
      break;
    case "explain":
      r = explainCmd({ ...page(), id: need(values.id, "--id <fixture-id>") });
      break;
    case "check":
      r = checkCmd(page());
      break;
    case "critique":
      r = critiqueCmd(page());
      break;
    case "lift":
      r = liftCmd({ css: need(input, "<file.css>"), out: values.out, fixture: values.fixture, widths: widths() });
      break;
    default:
      throw new InputError(`unknown command "${cmd}"`);
  }
  process.stdout.write(values.json ? JSON.stringify(r.data, null, 2) + "\n" : r.text);
  if (!r.ok) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof CadesaError) {
    if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ diagnostics: e.diagnostics }, null, 2) + "\n");
    else process.stderr.write(e.diagnostics.map(formatDiagnostic).join("\n\n") + "\n");
  } else if (e instanceof InputError) {
    process.stderr.write(`cadesa: ${e.message}\n\n${HELP}`);
  } else {
    process.stderr.write(`cadesa: ${(e as Error).message}\n`);
  }
  process.exitCode = 1;
}
