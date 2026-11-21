/**
 * The natural size of an image file (in CSS px, as Chromium takes it for an <img> without a
 * srcset): PNG, GIF, JPEG and WebP from their headers, SVG from its root's width and height in px.
 * undefined when the file isn't one of those or doesn't say (an SVG with only a viewBox has no
 * natural size of its own).
 */
import { readFileSync } from "node:fs";

export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  const ok = (width: number, height: number) => (width > 0 && height > 0 && isFinite(width) && isFinite(height) ? { width, height } : undefined);
  // PNG: IHDR right after the signature.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") return ok(buf.readUInt32BE(16), buf.readUInt32BE(20));
  // GIF: the logical screen size.
  if (buf.length >= 10 && /^GIF8[79]a$/.test(buf.toString("ascii", 0, 6))) return ok(buf.readUInt16LE(6), buf.readUInt16LE(8));
  // JPEG: the first start-of-frame marker. (An EXIF orientation that rotates it is applied by
  // Chromium, image-orientation: from-image: then its sides swap.)
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    let rotated = false;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return undefined;
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xe1 && buf.toString("ascii", i + 4, i + 8) === "Exif") rotated = exifRotated(buf.subarray(i + 10, i + 2 + len));
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = buf.readUInt16BE(i + 5);
        const w = buf.readUInt16BE(i + 7);
        return rotated ? ok(h, w) : ok(w, h);
      }
      i += 2 + len;
    }
    return undefined;
  }
  // WebP: lossy (VP8), lossless (VP8L) or extended (VP8X).
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8 ") return ok(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    if (kind === "VP8L") {
      const b = buf.readUInt32LE(21);
      return ok((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1);
    }
    if (kind === "VP8X") return ok(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
    return undefined;
  }
  // SVG: the root's width and height, in px (or unitless).
  const head = buf.toString("utf8", 0, Math.min(buf.length, 4096));
  const root = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (root) {
    const len = (name: string) => {
      const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(root);
      return m ? parseFloat(m[1]) : undefined;
    };
    const w = len("width");
    const h = len("height");
    return w !== undefined && h !== undefined ? ok(w, h) : undefined;
  }
  return undefined;
}

/** Whether a JPEG's EXIF orientation (tag 0x112) turns it a quarter (5 to 8): its width and height swap. */
function exifRotated(tiff: Buffer): boolean {
  if (tiff.length < 8) return false;
  const le = tiff.toString("ascii", 0, 2) === "II";
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return false;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > tiff.length) return false;
    if (u16(e) === 0x112) return u16(e + 8) >= 5 && u16(e + 8) <= 8;
  }
  return false;
}

export function imageFileSize(path: string): { width: number; height: number } | undefined {
  try {
    return imageSize(readFileSync(path));
  } catch {
    return undefined;
  }
}
