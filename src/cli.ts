#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  buildCmd,
  captureCmd,
  checkCmd,
  checkVerifyCmd,
  critiqueCmd,
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
import { CadesaError, formatDiagnostic, formatUnexpected } from "./diagnostics.js";
import { parseSet } from "./project.js";

const HELP = `cadesa ${VERSION}: predict what a style edit will do before you make it

Usage:
  cadesa build    <source.cadesa.yaml> --out <file.css>
  cadesa validate <source.cadesa.yaml>
  cadesa render   <fixture.html> --source <source.cadesa.yaml> [--widths 390,1280] [--lines]
  cadesa whatif   <fixture.html> --source <source.cadesa.yaml> --set <path=value> [--set ...]
  cadesa whatif   <page.html> --css <a.css,b.css> (--after <a.css,b.new.css> | --add-css "<rules>")
                    every whatif also runs check before and after: findings fixed, still there, new
  cadesa explain  <fixture.html> --source <source.cadesa.yaml> --id <fixture-id>
  cadesa check    <fixture.html> --source <source.cadesa.yaml>
  cadesa check    <page.html> --css <a.css,b.css> [--verify]
                    on a page with its CSS, each finding names the element (page file:line, tag,
                    classes, text) and the CSS rules behind it (stylesheet file:line, selector).
                    --verify then loads the page in Chromium at the widths with findings (and a
                    few others) and marks each finding confirmed or not reproduced; inconclusive
                    findings are decided by what Chromium shows (needs Chrome or Chromium)
  cadesa capture  <url> [--out capture] [--login-script login.mjs] [--wait <selector>] [--width 1280]
                  [--before "click: text=Full log"] ...  steps run before saving, to capture a state reached by
                  interaction (an open modal or accordion): click:, hover:, fill: <sel> = <text>, press: <key>,
                  wait: <selector or ms>; repeat --before for several, in order
                    load a page in Chromium and save what it rendered: page.html (scripts
                    removed, one element per line), its stylesheets in cascade order as
                    css/01-…, 02-… (including CSS-in-JS) and the fonts it loaded; prints the check
                    command to run (--css <out>/css). An error status (404, 401) stops it.
                    --login-script runs a module's default export, async (page) => {}, first; no
                    cookies or credentials are saved
  cadesa critique <fixture.html> --source <source.cadesa.yaml>   design signals: scale, hierarchy, grouping, alignment, palette, tells
  cadesa lift     <file.css> [--out <file.cadesa.yaml>] [--fixture <fixture.html>]
  cadesa lift     --tailwind <page.html> --css <compiled.css> [--out <file.cadesa.yaml>]
                    a Tailwind page → a source plus the page with generated classes and ids
  cadesa fonts    <page.html> --css <file.css> | --tailwind <compiled.css> | --source <src.yaml> [--measure]
                    every font the page's text is set in, whether Cadesa has metrics for it, and
                    where it comes from (@font-face file, Google Fonts, system font). --measure
                    measures each one it can (Chrome or Chromium; Google Fonts are downloaded);
                    add --system to also measure installed system fonts (machine-specific)
  cadesa metrics  <font-file> --family <name> [--weight <n>] [--italic] [--out .cadesa/metrics]
                    measure a font once in Chromium so the engine can measure text set in it
                    (omit --weight for a variable font; repeat per face for static fonts;
                    --italic for an italic face, kept in its own table)
  cadesa metrics  --google <family> [--weights 400,700]   a Google font by name (its variable
                    wght axis when it has one), downloaded into .cadesa/fonts/
  cadesa metrics  --system --family <name> [--weights 400,700] [--italic]   the font installed on this machine
  cadesa metrics  --auto <page.html> --css <file.css>   same as cadesa fonts ... --measure
  cadesa mcp      start the MCP server on stdio (for Claude Code, Cursor, Codex, ...)

  render, whatif, explain and check also accept --css <file.css> instead of --source (several
  stylesheets comma-separated, in cascade order: --css bootstrap.css,app.css; or a directory, whose
  stylesheets are read in name order: --css capture/css):
  the page and its CSS are lifted on the fly (the whole cascade, element by element: block flow
  with margins, percentage widths, inherited text), and boxes it can't predict exactly are marked ≈.
  lift <file.css> --fixture <page.html> lifts the same way and shows the source.
  render, whatif, explain, check and critique also take a Tailwind page as <fixture.html> with
  --tailwind <compiled.css> (the stylesheet Tailwind built for it): utilities are lifted the same way.

Options:
  --widths   viewport widths in px: "390,1280", or ranges like "320-1440/20" (every 20px)
             default: every 20px from 320 to 1440 for check and critique, and for whatif
             also both sides of every breakpoint; 390,1280 otherwise
  --height   window height in px for vh units and other heights of the viewport (default 800)
  --scrollbars overlay | classic: scrollbars that take no space (default: macOS, phones, headless
             Chromium) or 15px (Chromium on Windows and Linux desktops), in scroll containers and
             the page's own; --verify then shows Chromium's
  --json     machine-readable output (for agents)
  --lines    render: print each wrapped line with its width
  --svg f    render: also draw the predicted boxes as an SVG wireframe (f-<width>.svg per width)
  --verify   check: confirm each finding in Chromium (with --css or --tailwind)
  --after f  whatif with --css: preview the page with these stylesheets instead (one per --css
             file, same order), e.g. --css bootstrap.css,app.css --after bootstrap.css,app.new.css
  --add-css  whatif with --css: preview the page with these rules appended to the stylesheet
             that comes last in the page's cascade, e.g. --add-css ".card { padding: 24px }";
             a rule that matches nothing or loses to a more specific one is reported
  -h, --help show this help

  CADESA_DEBUG=1 prints the stack of an unexpected error (a Cadesa bug: please report it).
`;

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      source: { type: "string" },
      css: { type: "string" },
      tailwind: { type: "string" },
      fixture: { type: "string" },
      widths: { type: "string" },
      height: { type: "string" },
      scrollbars: { type: "string" },
      set: { type: "string", multiple: true },
      after: { type: "string" },
      "add-css": { type: "string" },
      id: { type: "string" },
      family: { type: "string" },
      weight: { type: "string" },
      weights: { type: "string" },
      google: { type: "string" },
      measure: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      "login-script": { type: "string" },
      wait: { type: "string" },
      before: { type: "string", multiple: true },
      width: { type: "string" },
      auto: { type: "boolean", default: false },
      system: { type: "boolean", default: false },
      italic: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      lines: { type: "boolean", default: false },
      svg: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, input] = positionals;
  if (values.help || !cmd) return void process.stdout.write(HELP);
  if (cmd === "mcp") {
    const { serve } = await import("./mcp.js");
    return serve();
  }
  const asyncResult = async (r: Promise<Result>) => {
    const res = await r;
    process.stdout.write(values.json ? JSON.stringify(res.data, null, 2) + "\n" : res.text);
    if (!res.ok) process.exitCode = 1;
  };
  const fontsInput = () => ({
    source: values.css || values.tailwind ? undefined : values.source,
    css: values.tailwind ? undefined : values.css,
    tailwind: values.tailwind,
    fixture: input!,
    widths: parseWidths(values.widths ?? SWEEP),
    system: values.system,
    out: values.out,
  });
  if (cmd === "capture") {
    if (!input) throw new InputError("capture needs <url>");
    const width = values.width ? Number(values.width) : undefined;
    if (width !== undefined && !(width > 0)) throw new InputError(`invalid --width "${values.width}"`);
    return asyncResult(captureCmd({ url: input, out: values.out, loginScript: values["login-script"], wait: values.wait, width, before: values.before }));
  }
  if (cmd === "fonts") {
    if (!input) throw new InputError("fonts needs <page.html>");
    if (!values.source && !values.css && !values.tailwind) throw new InputError("fonts needs --css <file.css>, --tailwind <compiled.css> or --source <source.cadesa.yaml>");
    return asyncResult(fontsCmd({ ...fontsInput(), measure: values.measure }));
  }
  if (cmd === "metrics") {
    if (values.auto) {
      if (!input) throw new InputError("metrics --auto needs <page.html> (with --css, --tailwind or --source)");
      if (!values.source && !values.css && !values.tailwind) throw new InputError("metrics --auto needs --css <file.css>, --tailwind <compiled.css> or --source <source.cadesa.yaml>");
      return asyncResult(fontsCmd({ ...fontsInput(), measure: true }));
    }
    const weight = values.weight ? Number(values.weight) : undefined;
    if (weight !== undefined && !(weight >= 1 && weight <= 1000)) throw new InputError(`invalid --weight "${values.weight}"`);
    const weights = values.weights?.split(",").map((w) => Number(w.trim()));
    if (weights?.some((w) => !(w >= 1 && w <= 1000))) throw new InputError(`invalid --weights "${values.weights}"`);
    return asyncResult(metricsCmd({ font: input, family: values.family, weight, google: values.google, system: values.system, weights, out: values.out, italic: values.italic }));
  }

  const need = (v: string | undefined, what: string) => {
    if (!v) throw new InputError(`${cmd} needs ${what}`);
    return v;
  };
  // check and critique sweep every 20px by default; at ~4ms per width that's cheap, and it
  // catches problems that exist only between two hand-picked widths.
  const widths = () => parseWidths(values.widths ?? (cmd === "check" || cmd === "critique" ? SWEEP : "390,1280"));
  // The window height (vh units on a --css or --tailwind page): one value, like a width.
  const height = () => {
    if (values.height === undefined) return undefined;
    const h = Number(values.height);
    if (!(h > 0) || !isFinite(h)) throw new InputError(`invalid height "${values.height}"`);
    return h;
  };
  // Scrollbars that take space (classic) or none (overlay, the default): for the engine and for --verify's Chromium.
  if (values.scrollbars !== undefined) {
    if (!/^(classic|overlay)$/.test(values.scrollbars)) throw new InputError(`invalid --scrollbars "${values.scrollbars}": classic or overlay`);
    process.env.CADESA_SCROLLBARS = values.scrollbars;
  }
  const page = () => ({
    source: values.css || values.tailwind ? undefined : need(values.source, "--source <source.cadesa.yaml>, --css <file.css> or --tailwind <compiled.css>"),
    css: values.tailwind ? undefined : values.css,
    tailwind: values.tailwind,
    fixture: need(input, "<fixture.html>"),
    widths: widths(),
    height: height(),
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
      r = renderCmd({ ...page(), lines: values.lines, svg: values.svg });
      break;
    case "whatif":
      r = whatifCmd({
        ...page(),
        widths: values.widths ? widths() : undefined,
        changes: (values.set ?? []).map(parseSet),
        after: values.after,
        addCss: values["add-css"],
      });
      break;
    case "explain":
      r = explainCmd({ ...page(), id: need(values.id, "--id <fixture-id>") });
      break;
    case "check":
      if (values.verify) return asyncResult(checkVerifyCmd(page()));
      r = checkCmd(page());
      break;
    case "critique":
      r = critiqueCmd(page());
      break;
    case "lift":
      r = values.tailwind
        ? liftCmd({ css: need(values.css, "--css <compiled.css> with --tailwind <page.html>"), tailwind: values.tailwind, out: values.out, widths: widths() })
        : liftCmd({ css: need(input, "<file.css>"), out: values.out, fixture: values.fixture, widths: widths() });
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
    process.stderr.write(formatUnexpected(e));
  }
  process.exitCode = 1;
}
