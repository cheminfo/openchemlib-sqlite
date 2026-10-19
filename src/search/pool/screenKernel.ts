import type { CountTally } from './countSink.ts';
import { flushKeys, tallyWord } from './countSink.ts';
import type { SetWords } from './setWords.ts';
import { restrictionWord } from './setWords.ts';

/** Candidates a screen collects: their keys and ids, grown as needed. */
export interface Collected {
  n: number;
  key: Float64Array;
  id: Float64Array;
}

/** What the screen, or the count, of one block reads. */
export interface ScreenContext {
  /** The block's planes, where each plane of the plan starts in them (by survival). */
  planes: Int32Array;
  poff: Int32Array;
  /** Per plane of the plan: 0 for a plane a row must hold, -1 for one it must lack. */
  flip: Int32Array;
  /** How many planes of the plan come before the restriction word. */
  restrictionAt: number;
  /** The set expression, and its one bitmap when it is a single one (read directly), else null. */
  sets: SetWords;
  single: Int32Array | null;
  /** Where each plane of the OR group starts in the block's planes, and how many: 0 for none. */
  aoff: Int32Array;
  anyCount: number;
  /** The block's first word in the row space. */
  base: number;
  /** The block's atom count times 2^36. */
  kBase: number;
  seq: Uint32Array;
  key: Float64Array;
  /** The range [lo, hi), the inclusive end, and the cursor (key, id) answered so far. */
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
 * word, lane mask of the last word): the planes of the plan by survival, each XORed with its flip,
 * the restriction word ANDed in at its own rank and the OR group after it, a word dropped as soon
 * as it is 0. That filter has two sinks. The walk (`out`) keeps each surviving row whose key is in
 * [lo, hi), at most `end`, after the cursor, and that passes the filters. The count (`tally`)
 * keeps the rows whose key is in the range, reading no key when `whole` says every one is, that
 * pass the filters, and tallies them.
 * @param c - The block's context.
 * @param entries - The work entries.
 * @param e0 - The first entry.
 * @param e1 - One past the last entry.
 * @param out - Receives the walk's candidates; null for a count.
 * @param tally - Receives the count's tallies; null for a walk.
 * @param whole - For a count, whether every row of the entries has a key inside the range.
 */
export function screenWords(
  c: ScreenContext,
  entries: Float64Array,
  e0: number,
  e1: number,
  out: Collected | null,
  tally: CountTally | null,
  whole: boolean,
): void {
  const { planes, poff, flip, sets, single, aoff, anyCount, base } = c;
  const { kBase, seq, key, lo, hi, end, cursorKey, cursorId, keep } = c;
  const { restrictionAt: at } = c;
  const kq = poff.length;
  for (let e = e0; e < e1; e++) {
    const w0 = entries[4 * e + 1] as number;
    const w1 = entries[4 * e + 2] as number;
    const lastMask = (entries[4 * e + 3] as number) | 0;
    for (let w = w0; w < w1; w++) {
      let acc = w === w1 - 1 ? lastMask : -1;
      for (let j = 0; j < at && acc !== 0; j++) {
        acc &=
          (planes[(poff[j] as number) + w] as number) ^ (flip[j] as number);
      }
      if (acc !== 0) {
        acc &=
          single !== null
            ? (single[base + w] as number)
            : restrictionWord(sets, base + w);
      }
      if (acc !== 0 && anyCount > 0) {
        let some = 0;
        for (let k = 0; k < anyCount; k++) {
          some |= planes[(aoff[k] as number) + w] as number;
        }
        acc &= some;
      }
      for (let j = at; j < kq && acc !== 0; j++) {
        acc &=
          (planes[(poff[j] as number) + w] as number) ^ (flip[j] as number);
      }
      if (acc === 0) continue;
      if (tally !== null) {
        if (!whole || keep !== null) acc = keptRows(c, w, acc, whole);
        if (acc !== 0) tallyWord(tally, base + w, w, acc);
        continue;
      }
      const found = out as Collected;
      while (acc !== 0) {
        const lowest = acc & -acc;
        acc ^= lowest;
        const r = (w << 5) | (31 - Math.clz32(lowest));
        const k = key[r] as number;
        if (!(k >= lo && k < hi && k <= end)) continue;
        const id = kBase + (seq[r] as number);
        if (!(k > cursorKey || (k === cursorKey && id > cursorId))) continue;
        if (keep !== null && !keep(r, id)) continue;
        if (found.n === found.key.length) grow(found);
        found.key[found.n] = k;
        found.id[found.n++] = id;
      }
    }
    if (tally !== null) flushKeys(tally, w0, w1);
  }
}

/**
 * The rows of a surviving word a count keeps: its key in [lo, hi) and at most `end` (not read when
 * every row's is), and the filters passed.
 * @param c - The block's context.
 * @param w - The word, in the block.
 * @param rows - Its surviving rows.
 * @param whole - Whether every row has a key inside the range.
 * @returns The rows kept.
 */
export function keptRows(
  c: ScreenContext,
  w: number,
  rows: number,
  whole: boolean,
): number {
  const { key, lo, hi, end, keep, kBase, seq } = c;
  let kept = 0;
  let left = rows;
  while (left !== 0) {
    const lowest = left & -left;
    left ^= lowest;
    const r = (w << 5) | (31 - Math.clz32(lowest));
    if (!whole) {
      const k = key[r] as number;
      if (!(k >= lo && k < hi && k <= end)) continue;
    }
    if (keep !== null && !keep(r, kBase + (seq[r] as number))) continue;
    kept |= lowest;
  }
  return kept;
}

function grow(out: Collected): void {
  const key = new Float64Array(2 * out.key.length);
  const id = new Float64Array(2 * out.id.length);
  key.set(out.key);
  id.set(out.id);
  out.key = key;
  out.id = id;
}
