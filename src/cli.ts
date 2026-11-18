#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { parseArgs } from "node:util";
import { compile, VERSION } from "./compile.js";
import { CascadioError, formatDiagnostic } from "./diagnostics.js";
import { parseFixture } from "./fixture.js";
import { loadSourceFile } from "./load.js";
import { modelOf, parseSet, render, whatif } from "./project.js";
import { formatRender, formatWhatif } from "./report.js";

const HELP = `cascadio ${VERSION}: predict what a style edit will do before you make it

Usage:
  cascadio build  <source.cascade.yaml> --out <file.css>
  cascadio render <fixture.html> --source <source.cascade.yaml> [--widths 390,1280]
  cascadio whatif <fixture.html> --source <source.cascade.yaml> [--widths 390,1280] --set <path=value> [--set ...]

Options:
  --json     machine-readable output (for agents)
  -h, --help show this help
`;

function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      source: { type: "string" },
      widths: { type: "string", default: "390,1280" },
      set: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, input] = positionals;
  if (values.help || !cmd) return void process.stdout.write(HELP);
  const print = (text: string, data: unknown) =>
    process.stdout.write(values.json ? JSON.stringify(data, null, 2) + "\n" : text);
  const need = (v: string | undefined, flag: string) => {
    if (!v) throw new UsageError(`${cmd} needs ${flag}`);
    return v;
  };
  const widths = () =>
    values.widths!.split(",").map((s) => {
      const n = Number(s.trim());
      if (!Number.isFinite(n) || n <= 0) throw new UsageError(`invalid width "${s}"`);
      return n;
    });

  switch (cmd) {
    case "build": {
      const out = need(values.out, "--out <file.css>");
      const css = compile(modelOf(loadSourceFile(need(input, "<source.cascade.yaml>"))));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, css);
      const sha256 = createHash("sha256").update(css).digest("hex");
      print(`wrote ${relative(process.cwd(), out)} (${Buffer.byteLength(css)} bytes, sha256 ${sha256.slice(0, 12)})\n`, {
        out,
        bytes: Buffer.byteLength(css),
        sha256,
      });
      return;
    }
    case "render": {
      const t0 = performance.now();
      const sourceFile = need(values.source, "--source <source.cascade.yaml>");
      const fixtureFile = need(input, "<fixture.html>");
      const layouts = render(modelOf(loadSourceFile(sourceFile)), parseFixture(fixtureFile), widths());
      const ms = Math.round(performance.now() - t0);
      print(formatRender(layouts, { source: sourceFile, fixture: fixtureFile, ms }), { source: sourceFile, fixture: fixtureFile, layouts });
      if (layouts.some((l) => l.issues.some((i) => i.severity === "error"))) process.exitCode = 1;
      return;
    }
    case "whatif": {
      const t0 = performance.now();
      const changes = (values.set ?? []).map(parseSet);
      if (!changes.length) throw new UsageError("whatif needs at least one --set <path=value>");
      const result = whatif(
        loadSourceFile(need(values.source, "--source <source.cascade.yaml>")),
        parseFixture(need(input, "<fixture.html>")),
        widths(),
        changes,
      );
      print(formatWhatif(result, { ms: Math.round(performance.now() - t0) }), result);
      return;
    }
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

class UsageError extends Error {}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (e instanceof CascadioError) {
    if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ diagnostics: e.diagnostics }, null, 2) + "\n");
    else process.stderr.write(e.diagnostics.map(formatDiagnostic).join("\n\n") + "\n");
  } else if (e instanceof UsageError) {
    process.stderr.write(`cascadio: ${e.message}\n\n${HELP}`);
  } else {
    process.stderr.write(`cascadio: ${(e as Error).message}\n`);
  }
  process.exitCode = 1;
}
