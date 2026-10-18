/** Candidates a screen collects: their keys and ids, grown as needed. */
export interface Collected {
  n: number;
  key: Float64Array;
  id: Float64Array;
}

/** What the screen of one block reads. */
export interface ScreenContext {
  /** The block's planes, and where each query plane starts in them (rarest first). */
  planes: Int32Array;
  poff: Int32Array;
  /** How many query planes come before the restriction word. */
  restrictionAt: number;
  /** The restriction bitmap, and the block's first word in it. */
  restr: Int32Array;
  base: number;
  /** The block's atom count times 2^36. */
  kBase: number;
  seq: Uint32Array;
  key: Float64Array;
  /** The slice [lo, hi), the walk's inclusive end, and the cursor (key, id) answered so far. */
  lo: number;
  hi: number;
  end: number;
  cursorKey: number;
  cursorId: number;
  /** The property filters, null without any. */
  keep: ((row: number, id: number) => boolean) | null;
}

/**
 * P1 over the words of entries [e0, e1) of one block, each entry being (block, first word, end
 * word, lane mask of the last word): the query planes rarest first, the restriction word ANDed in
 * at its own rank, a word dropped as soon as it is 0. Each surviving row is kept when its key is in
 * [lo, hi), at most `end`, after the cursor, and it passes the filters.
 * @param c - The block's context.
 * @param entries - The work entries.
 * @param e0 - The first entry.
 * @param e1 - One past the last entry.
 * @param out - Receives the candidates.
 */
export function screenWords(
  c: ScreenContext,
  entries: Float64Array,
  e0: number,
  e1: number,
  out: Collected,
): void {
  const { planes, poff, restr, base, kBase, seq, key, lo, hi, end } = c;
  const { cursorKey, cursorId, keep, restrictionAt: at } = c;
  const kq = poff.length;
  for (let e = e0; e < e1; e++) {
    const w0 = entries[4 * e + 1] as number;
    const w1 = entries[4 * e + 2] as number;
    const lastMask = (entries[4 * e + 3] as number) | 0;
    for (let w = w0; w < w1; w++) {
      let acc = w === w1 - 1 ? lastMask : -1;
      for (let j = 0; j < at && acc !== 0; j++) {
        acc &= planes[(poff[j] as number) + w] as number;
      }
      if (acc !== 0) acc &= restr[base + w] as number;
      for (let j = at; j < kq && acc !== 0; j++) {
        acc &= planes[(poff[j] as number) + w] as number;
      }
      while (acc !== 0) {
        const lowest = acc & -acc;
        acc ^= lowest;
        const r = (w << 5) | (31 - Math.clz32(lowest));
        const k = key[r] as number;
        if (!(k >= lo && k < hi && k <= end)) continue;
        const id = kBase + (seq[r] as number);
        if (!(k > cursorKey || (k === cursorKey && id > cursorId))) continue;
        if (keep !== null && !keep(r, id)) continue;
        if (out.n === out.key.length) grow(out);
        out.key[out.n] = k;
        out.id[out.n++] = id;
      }
    }
  }
}

function grow(out: Collected): void {
  const key = new Float64Array(2 * out.key.length);
  const id = new Float64Array(2 * out.id.length);
  key.set(out.key);
  id.set(out.id);
  out.key = key;
  out.id = id;
}
