#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  buildCmd,
  checkCmd,
  explainCmd,
  InputError,
  renderCmd,
  validateCmd,
  whatifCmd,
  type Result,
} from "./commands.js";
import { VERSION } from "./compile.js";
import { CascadioError, formatDiagnostic } from "./diagnostics.js";
import { parseSet } from "./project.js";

const HELP = `cascadio ${VERSION}: predict what a style edit will do before you make it

Usage:
  cascadio build    <source.cascade.yaml> --out <file.css>
  cascadio validate <source.cascade.yaml>
  cascadio render   <fixture.html> --source <source.cascade.yaml> [--widths 390,1280] [--lines]
  cascadio whatif   <fixture.html> --source <source.cascade.yaml> --set <path=value> [--set ...]
  cascadio explain  <fixture.html> --source <source.cascade.yaml> --id <fixture-id>
  cascadio check    <fixture.html> --source <source.cascade.yaml>
  cascadio mcp      start the MCP server on stdio (for Claude Code, Cursor, Codex, ...)

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
      widths: { type: "string", default: "390,1280" },
      set: { type: "string", multiple: true },
      id: { type: "string" },
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
    source: need(values.source, "--source <source.cascade.yaml>"),
    fixture: need(input, "<fixture.html>"),
    widths: widths(),
  });

  let r: Result;
  switch (cmd) {
    case "build":
      r = buildCmd({ source: need(input, "<source.cascade.yaml>"), out: need(values.out, "--out <file.css>") });
      break;
    case "validate":
      r = validateCmd({ source: need(input, "<source.cascade.yaml>") });
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
    default:
      throw new InputError(`unknown command "${cmd}"`);
  }
  process.stdout.write(values.json ? JSON.stringify(r.data, null, 2) + "\n" : r.text);
  if (!r.ok) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof CascadioError) {
    if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ diagnostics: e.diagnostics }, null, 2) + "\n");
    else process.stderr.write(e.diagnostics.map(formatDiagnostic).join("\n\n") + "\n");
  } else if (e instanceof InputError) {
    process.stderr.write(`cascadio: ${e.message}\n\n${HELP}`);
  } else {
    process.stderr.write(`cascadio: ${(e as Error).message}\n`);
  }
  process.exitCode = 1;
}
