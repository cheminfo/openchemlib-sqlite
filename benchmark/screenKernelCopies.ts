// Copies of the screen kernel for benchmark/screenKernel.ts, so each case has its own function and
// its own inline caches: the kernel before set expressions (A, one restriction array, no flips, no
// OR group), and two copies of src/search/pool/screenKernel.ts (C, D). Case B runs that module's
// own function. Keep C and D identical to it.
import type { CountTally } from '../src/search/pool/countSink.ts';
import { flushKeys, tallyWord } from '../src/search/pool/countSink.ts';
import type {
  Collected,
  ScreenContext,
} from '../src/search/pool/screenKernel.ts';
import { keptRows } from '../src/search/pool/screenKernel.ts';
import { restrictionWord } from '../src/search/pool/setWords.ts';

/** What the kernel before set expressions read of a block. */
export interface OldScreenContext extends Omit<
  ScreenContext,
  'flip' | 'sets' | 'single' | 'aoff' | 'anyCount'
> {
  restr: Int32Array;
}

/**
 * The kernel before set expressions: the planes rarest first, the restriction word at its rank.
 * @param c - The block's context.
 * @param entries - The work entries.
 * @param e0 - The first entry.
 * @param e1 - One past the last entry.
 * @param out - Receives the candidates.
 */
export function oldScreenWords(
  c: OldScreenContext,
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

/**
 * Copy C of the production kernel.
 * @param c - The block's context.
 * @param entries - The work entries.
 * @param e0 - The first entry.
 * @param e1 - One past the last entry.
 * @param out - Receives the walk's candidates; null for a count.
 * @param tally - Receives the count's tallies; null for a walk.
 * @param whole - For a count, whether every row of the entries has a key inside the range.
 */
export function screenWordsC(
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
 * Copy D of the production kernel, the same as C.
 * @param c - The block's context.
 * @param entries - The work entries.
 * @param e0 - The first entry.
 * @param e1 - One past the last entry.
 * @param out - Receives the walk's candidates; null for a count.
 * @param tally - Receives the count's tallies; null for a walk.
 * @param whole - For a count, whether every row of the entries has a key inside the range.
 */
export function screenWordsD(
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

function grow(out: Collected): void {
  const key = new Float64Array(2 * out.key.length);
  const id = new Float64Array(2 * out.id.length);
  key.set(out.key);
  id.set(out.id);
  out.key = key;
  out.id = id;
}
