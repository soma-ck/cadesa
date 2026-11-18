/**
 * Just enough of a font file to know its units per em and its variation axes: TrueType/OpenType,
 * WOFF and WOFF2 (whose tables are one Brotli stream; `head` and `fvar` are never transformed).
 */
import { brotliDecompressSync, inflateSync } from "node:zlib";

export interface FontFileInfo {
  unitsPerEm: number;
  /** Variation axes (tag, min, default, max), empty for a static font. */
  axes: { tag: string; min: number; default: number; max: number }[];
}

const WOFF2_TAGS = (
  "cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill"
)
  .match(/.{4}\s?/g)!
  .map((t) => t.slice(0, 4));

/** The tables of a font file, by tag (only those needed are decoded). */
function tables(b: Buffer, want: string[]): Map<string, Buffer> | undefined {
  const out = new Map<string, Buffer>();
  const sig = b.toString("latin1", 0, 4);
  if (sig === "wOF2") {
    const numTables = b.readUInt16BE(12);
    const compressed = b.readUInt32BE(20);
    let p = 48;
    const base128 = () => {
      let v = 0;
      for (let i = 0; i < 5; i++) {
        const byte = b[p++];
        v = v * 128 + (byte & 0x7f);
        if (!(byte & 0x80)) return v;
      }
      throw new Error("bad UIntBase128");
    };
    const dir: { tag: string; length: number }[] = [];
    for (let i = 0; i < numTables; i++) {
      const flags = b[p++];
      let tag = WOFF2_TAGS[flags & 0x3f];
      if ((flags & 0x3f) === 0x3f) {
        tag = b.toString("latin1", p, p + 4);
        p += 4;
      }
      const version = flags >> 6;
      const orig = base128();
      // glyf and loca are transformed unless version 3; any other table only with a version != 0.
      const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
      dir.push({ tag, length: transformed ? base128() : orig });
    }
    if (b.toString("latin1", 4, 8) === "ttcf") return undefined;
    const data = brotliDecompressSync(b.subarray(p, p + compressed));
    let off = 0;
    for (const t of dir) {
      if (want.includes(t.tag)) out.set(t.tag, data.subarray(off, off + t.length));
      off += t.length;
    }
    return out;
  }
  if (sig === "wOFF") {
    const numTables = b.readUInt16BE(12);
    for (let i = 0; i < numTables; i++) {
      const e = 44 + i * 20;
      const tag = b.toString("latin1", e, e + 4);
      if (!want.includes(tag)) continue;
      const [offset, compLength, origLength] = [b.readUInt32BE(e + 4), b.readUInt32BE(e + 8), b.readUInt32BE(e + 12)];
      const raw = b.subarray(offset, offset + compLength);
      out.set(tag, compLength < origLength ? inflateSync(raw) : raw);
    }
    return out;
  }
  if (sig === "\0\x01\0\0" || sig === "OTTO" || sig === "true") {
    const numTables = b.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const e = 12 + i * 16;
      const tag = b.toString("latin1", e, e + 4);
      if (want.includes(tag)) out.set(tag, b.subarray(b.readUInt32BE(e + 8), b.readUInt32BE(e + 8) + b.readUInt32BE(e + 12)));
    }
    return out;
  }
  return undefined;
}

/** Units per em and variation axes, or undefined for a file this can't read (a collection, say). */
export function fontFileInfo(bytes: Buffer): FontFileInfo | undefined {
  try {
    const t = tables(bytes, ["head", "fvar"]);
    const head = t?.get("head");
    if (!head) return undefined;
    const axes: FontFileInfo["axes"] = [];
    const fvar = t!.get("fvar");
    if (fvar) {
      const [offset, count, size] = [fvar.readUInt16BE(4), fvar.readUInt16BE(8), fvar.readUInt16BE(10)];
      for (let i = 0; i < count; i++) {
        const a = offset + i * size;
        const fixed = (o: number) => fvar.readInt32BE(a + o) / 65536;
        axes.push({ tag: fvar.toString("latin1", a, a + 4), min: fixed(4), default: fixed(8), max: fixed(12) });
      }
    }
    return { unitsPerEm: head.readUInt16BE(18), axes };
  } catch {
    return undefined;
  }
}
