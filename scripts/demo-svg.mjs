// Regenerates docs/demo.svg: an animated terminal session built from real CLI output.
//   npm run build:ts && node scripts/demo-svg.mjs
// Every output line in the SVG is what lib/cli.js printed when this script ran.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const sessions = [
  {
    shown: [
      "cadesa whatif fixtures/settings.html --source settings.cadesa.yaml \\",
      "    --set styles.settings-panel.when.narrow.padding=panel",
    ],
    args: ["whatif", "fixtures/settings.html", "--source", "settings.cadesa.yaml", "--set", "styles.settings-panel.when.narrow.padding=panel"],
  },
  {
    shown: [
      "cadesa check docs/demo/trips.html --source examples/landing/landing.cadesa.yaml \\",
      "    --widths 390,768,1024,1100,1280,1440",
    ],
    args: ["check", "docs/demo/trips.html", "--source", "examples/landing/landing.cadesa.yaml", "--widths", "390,768,1024,1100,1280,1440"],
  },
];

const run = (args) => {
  try {
    return execFileSync("node", ["lib/cli.js", ...args], { encoding: "utf8" });
  } catch (e) {
    return e.stdout; // check exits 1 on errors; the output is still what we want
  }
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Build the timeline: each entry is one line of the terminal with the time (s) it appears.
const lines = [];
let t = 0.6;
const TYPE_CPS = 55; // typing speed, characters per second
for (const [i, s] of sessions.entries()) {
  const out = run(s.args).replace(/\s+$/, "").split("\n");
  for (const [j, cmd] of s.shown.entries()) {
    const text = (j === 0 ? "$ " : "  ") + cmd;
    const dur = cmd.length / TYPE_CPS;
    lines.push({ text, kind: "cmd", at: t, typeDur: dur, prompt: j === 0 });
    t += dur + 0.15;
  }
  t += 0.5; // the command runs
  for (const l of out) {
    lines.push({ text: l, kind: "out", at: t });
    t += 0.045;
  }
  if (i < sessions.length - 1) {
    lines.push({ text: "", kind: "out", at: t });
    t += 2.6; // time to read the whatif result
  }
}
const HOLD = 6;
const TOTAL = t + HOLD;

// Geometry
const FS = 14;
const LH = 20;
const CW = 8.43; // approximate advance of a 14px monospace glyph
const PAD_X = 20;
const TOP = 44;
const maxChars = Math.max(...lines.map((l) => [...l.text].length));
const W = Math.ceil(PAD_X * 2 + maxChars * CW);
const H = TOP + lines.length * LH + 18;

const pct = (s) => ((s / TOTAL) * 100).toFixed(3);
const css = [];
const body = [];

function colorize(text) {
  // Returns tspans with classes for a handful of tokens in Cadesa's output.
  const rules = [
    [/^(\d+px)( · .*)?$/, (m) => `<tspan class="w">${esc(m[1])}</tspan>${m[2] ? `<tspan class="d">${esc(m[2])}</tspan>` : ""}`],
    [/^(\s*)(✓)(.*)$/, (m) => `${esc(m[1])}<tspan class="ok">${m[2]}${esc(m[3])}</tspan>`],
    [/^(\s*)(⚠ \[[a-z-]+\])(.*)$/, (m) => `${esc(m[1])}<tspan class="warn">${esc(m[2])}</tspan>${esc(m[3])}`],
    [/^(\s*)(←.*)$/, (m) => `${esc(m[1])}<tspan class="d">${esc(m[2])}</tspan>`],
    [/^(\s*)(edit:)(.*)$/, (m) => `${esc(m[1])}<tspan class="d">${m[2]}</tspan><tspan class="path">${esc(m[3])}</tspan>`],
    [/^(\(.*\))$/, (m) => `<tspan class="d">${esc(m[1])}</tspan>`],
    [/^(\d+ errors?, \d+ warnings?)$/, (m) => `<tspan class="d">${esc(m[1])}</tspan>`],
  ];
  for (const [re, f] of rules) {
    const m = text.match(re);
    if (m) return f(m);
  }
  return esc(text);
}

lines.forEach((l, i) => {
  const y = TOP + i * LH + FS;
  const id = `l${i}`;
  const a = pct(l.at);
  const a2 = pct(l.at + 0.01);
  css.push(`@keyframes ${id}{0%,${a}%{opacity:0}${a2}%,97%{opacity:1}100%{opacity:0}}#${id}{animation:${id} ${TOTAL.toFixed(2)}s linear infinite}`);
  if (l.kind === "cmd") {
    const prefix = l.prompt ? 2 : 2;
    const chars = [...l.text].length - prefix;
    const x0 = PAD_X + prefix * CW;
    const e = pct(l.at + l.typeDur);
    // Typing: a clip rectangle that grows one character at a time (steps() set on the keyframe
    // so it applies only to the typing segment, not the whole loop).
    css.push(`@keyframes c${id}{0%,${a}%{width:0;animation-timing-function:steps(${chars},end)}${e}%,100%{width:${(chars * CW + 4).toFixed(1)}px}}#c${id} rect{animation:c${id} ${TOTAL.toFixed(2)}s linear infinite}`);
    body.push(
      `<clipPath id="c${id}"><rect x="${x0.toFixed(1)}" y="${y - FS}" height="${LH}" width="0"/></clipPath>`,
      `<g id="${id}"><text x="${PAD_X}" y="${y}">${l.prompt ? '<tspan class="p">$</tspan> ' : "  "}</text>` +
        `<text x="${x0.toFixed(1)}" y="${y}" class="cmd" clip-path="url(#c${id})">${esc(l.text.slice(2))}</text></g>`,
    );
  } else {
    body.push(`<text id="${id}" x="${PAD_X}" y="${y}">${colorize(l.text)}</text>`);
  }
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="title desc">
<title id="title">Cadesa in a terminal</title>
<desc id="desc">An animated terminal session generated from real Cadesa CLI output. First, cadesa whatif previews changing the settings panel's narrow padding: at 390px the panel padding goes from 16 to 32px and six boxes move, each value traced to its YAML path; at 1280px nothing moves. Second, cadesa check runs the landing page's trip cards at six widths and finds one problem: the word "Overnattingskajakkturene" can't wrap and overflows its card by 3.14px, only at 1100px.</desc>
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono",monospace;font-size:${FS}px;fill:#d8dee9;white-space:pre}
.cmd{fill:#ffffff}.p{fill:#7fd1b9}.w{fill:#ffffff;font-weight:700}.d{fill:#8a93a3}.ok{fill:#7fd1b9}.warn{fill:#f4b41a;font-weight:700}.path{fill:#9ecbff}
${css.join("\n")}
@media (prefers-reduced-motion: reduce){g[id],text[id]{animation:none!important;opacity:1!important}clipPath rect{animation:none!important;width:${W}px!important}}
</style>
<rect width="${W}" height="${H}" rx="10" fill="#14181f"/>
<circle cx="20" cy="18" r="5.5" fill="#ff5f57"/><circle cx="38" cy="18" r="5.5" fill="#febc2e"/><circle cx="56" cy="18" r="5.5" fill="#28c840"/>
<text x="${W / 2}" y="22" text-anchor="middle" style="fill:#8a93a3;font-size:12px">cadesa · no browser</text>
<g xml:space="preserve">
${body.join("\n")}
</g>
</svg>
`;

writeFileSync("docs/demo.svg", svg);
console.log(`wrote docs/demo.svg (${W}×${H}, ${lines.length} lines, loop ${TOTAL.toFixed(1)}s)`);
