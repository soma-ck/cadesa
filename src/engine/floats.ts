/**
 * Floats: the exclusion space of a block formatting context, as Chromium's LayoutNG keeps it.
 *
 * Every float placed in a formatting context is an exclusion: its margin box, in the context's
 * coordinates. A float is placed at the highest block offset (no higher than where it occurs, nor
 * than an earlier float's top) where the band as tall as its margin box, between the floats beside
 * it, is wide enough, as far left (right) as that band allows (CSS 2.1 §9.5.1). A line of text, or
 * a box that makes a formatting context of its own, is placed in the first such band (starting at
 * its offset, and then below each float that ends there) that its content fits, or below every float.
 */

export interface Exclusion {
  side: "left" | "right";
  /** The float's margin box (px, the formatting context's coordinates). */
  l: number;
  r: number;
  t: number;
  b: number;
}

/** Layout units (1/64 px) absorb floating-point error in comparisons. */
const EPS = 1e-6;

export class Exclusions {
  floats: Exclusion[] = [];
  /** No float is placed above an earlier one's top (CSS 2.1 §9.5.1 rule 5). */
  lastTop = -Infinity;

  /** What is placed so far, to undo a layout pass that is done again (see reset). */
  mark(): [number, number] {
    return [this.floats.length, this.lastTop];
  }
  reset([n, top]: [number, number]) {
    this.floats.length = n;
    this.lastTop = top;
  }

  get empty() {
    return this.floats.length === 0;
  }

  /** The lowest bottom of the floats (or -Infinity). */
  get bottom() {
    return Math.max(-Infinity, ...this.floats.map((f) => f.b));
  }

  /** Where a box clearing `side` floats starts at the earliest: below each one of them (or -Infinity). */
  clearance(side: "left" | "right" | "both"): number {
    return Math.max(-Infinity, ...this.floats.filter((f) => side === "both" || f.side === side).map((f) => f.b));
  }

  /**
   * The room between the floats beside the band [top, top + h) (a zero-height band: the floats
   * across its top edge), inside [L, R): `l`, `r`, and whether any float is beside it.
   */
  band(top: number, h: number, L: number, R: number): { l: number; r: number; beside: boolean } {
    let l = L;
    let r = R;
    let beside = false;
    for (const f of this.floats) {
      const over = h > 0 ? f.t < top + h - EPS && f.b > top + EPS : f.t <= top + EPS && f.b > top + EPS;
      // A float with no height, or past this container's sides, takes no room here.
      if (!over || f.b - f.t <= EPS) continue;
      if (f.side === "left" && f.r > l + EPS) {
        if (f.r > L + EPS) beside = true;
        l = Math.max(l, f.r);
      }
      if (f.side === "right" && f.l < r - EPS) {
        if (f.l < R - EPS) beside = true;
        r = Math.min(r, f.l);
      }
    }
    return { l, r, beside };
  }

  /** The next offset below `top` where a float beside the band [top, top + h) ends (Infinity: none). */
  private next(top: number, h: number, L: number, R: number): number {
    let n = Infinity;
    for (const f of this.floats) {
      const over = h > 0 ? f.t < top + h - EPS && f.b > top + EPS : f.t <= top + EPS && f.b > top + EPS;
      if (over && f.b > top + EPS && ((f.side === "left" && f.r > L + EPS) || (f.side === "right" && f.l < R - EPS))) n = Math.min(n, f.b);
    }
    return n;
  }

  /**
   * The first band from `top` down, `h` tall, whose room `fits` (or that no float is beside): its
   * top and its room. A band is tried at `top` and then just below each float beside it that ends.
   */
  find(top: number, h: number, L: number, R: number, fits: (w: number) => boolean): { top: number; l: number; r: number } {
    for (let y = top, guard = 0; guard < 10000; guard++) {
      const b = this.band(y, h, L, R);
      if (!b.beside || fits(b.r - b.l)) return { top: y, l: b.l, r: b.r };
      const n = this.next(y, h, L, R);
      if (!isFinite(n)) return { top: y, l: b.l, r: b.r };
      y = n;
    }
    return { top, l: L, r: R };
  }

  /**
   * Place a float of margin box `w` × `h` occurring at block offset `top` in a container whose
   * content box spans [L, R): its margin box's top left corner. It is then an exclusion.
   */
  place(side: "left" | "right", w: number, h: number, top: number, L: number, R: number): { x: number; y: number } {
    const at = this.find(Math.max(top, this.lastTop), Math.max(0, h), L, R, (room) => w <= room + EPS);
    const x = side === "left" ? at.l : at.r - w;
    this.floats.push({ side, l: x, r: x + w, t: at.top, b: at.top + h });
    this.lastTop = at.top;
    return { x, y: at.top };
  }
}
