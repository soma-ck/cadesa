/**
 * Add vertical metrics (ascent, descent, line gap, x-height) to metrics tables measured before
 * Cadesa recorded them, from the same font files: the bundled tables (fonts/) and the font
 * fixtures (fixtures/fonts/metrics). Nothing else in a table changes.
 *
 *   npm run metrics:vertical [-- table.metrics.json[.gz] ...]
 *
 * Each face is the file the table names: found next to the table or under fixtures/fonts/fonts,
 * or downloaded from its recorded URL; its sha256 must match the table's. Measured in Chromium at
 * the font's units per em, where the values are whole font units.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { fontFileInfo } from "../src/fontfile.js";
import { launchChromium, measureVertical, readMetrics, type MetricsFile } from "../src/metrics.js";

const FORMATS: Record<string, string> = { ".woff2": "woff2", ".woff": "woff", ".ttf": "truetype", ".otf": "opentype" };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const tables = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [...readdirSync("fonts").filter((f) => f.endsWith(".metrics.json.gz")).map((f) => join("fonts", f)), ...readdirSync("fixtures/fonts/metrics").map((f) => join("fixtures/fonts/metrics", f))];

/** Where a face's file is: beside the table, among the font fixtures, the bundled Inter, or its URL. */
async function bytesOf(table: string, m: MetricsFile, face: NonNullable<MetricsFile["files"]>[number] | undefined): Promise<Buffer> {
  const name = face?.file ?? m.source.split(" ")[0];
  const local = [join(dirname(table), name), ...readdirSync("fixtures/fonts/fonts").map((d) => join("fixtures/fonts/fonts", d, name)), join("fonts", name)].find(existsSync);
  const bytes = local ? readFileSync(local) : face?.url ? Buffer.from(await (await fetch(face.url)).arrayBuffer()) : undefined;
  if (!bytes) throw new Error(`${table}: can't find ${name}`);
  if (face?.sha256 && sha(bytes) !== face.sha256) throw new Error(`${table}: ${name} isn't the file the table was measured from (sha256 differs)`);
  return bytes;
}

const browser = await launchChromium();
try {
  for (const table of tables) {
    const m = readMetrics(table);
    const faces = m.files?.length ? m.files : [undefined];
    const vertical: NonNullable<MetricsFile["vertical"]> = { size: 0, byWeight: {} };
    for (const face of faces) {
      const bytes = await bytesOf(table, m, face);
      const name = face?.file ?? m.source.split(" ")[0];
      const format = FORMATS[extname(name).toLowerCase()];
      const size = fontFileInfo(bytes)?.unitsPerEm ?? 2048;
      if (vertical.size && vertical.size !== size) throw new Error(`${table}: faces with different units per em`);
      vertical.size = size;
      const variable = m.kind === "variable";
      const weight = variable ? 400 : Number(face?.weight ?? m.weights[0]);
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><style>@font-face{font-family:"__cadesa";font-weight:${variable ? "100 900" : weight};src:url(data:font/${format};base64,${bytes.toString("base64")}) format("${format}")}</style>`);
      vertical.byWeight[weight] = await measureVertical(page, '"__cadesa"', weight, size);
      await page.close();
    }
    const out = { ...m, vertical };
    const json = JSON.stringify(out) + "\n";
    writeFileSync(table, table.endsWith(".gz") ? gzipSync(json, { level: 9 }) : json);
    console.log(`${basename(table)}: ${JSON.stringify(vertical)}`);
  }
} finally {
  await browser.close();
}
