import { popcount32 } from '../../chemistry/bits.ts';
import { INT16_LIMIT, INT16_NULL, INT32_LIMIT, INT32_NULL } from '../blocks.ts';

import type { CountTally } from './countSink.ts';
import type { HistogramTask } from './messages.ts';

/** How a histogram's column holds its values: a float (or the key), an int32, an int16. */
export const FLOAT = 0;
export const INT32 = 2;
export const INT16 = 3;

/**
 * The membership sink: each kept row counted by the sets of `membershipOf` it belongs to, by
 * combination (16 sets or fewer) or by how many.
 * @param t - The tallies.
 * @param g - The word, in the row space.
 * @param word - Its rows kept, one bit each.
 */
export function tallyMembership(t: CountTally, g: number, word: number): void {
  const { memberMaps, member, tallies, memberAt, combinations } = t;
  const n = memberMaps.length;
  for (let s = 0; s < n; s++) {
    const map = memberMaps[s];
    member[s] =
      map === null || map === undefined ? 0 : word & (map[g] as number);
  }
  let lanes = word;
  while (lanes !== 0) {
    const lowest = lanes & -lanes;
    lanes ^= lowest;
    const lane = 31 - Math.clz32(lowest);
    let mask = 0;
    for (let s = 0; s < n; s++) {
      mask |= (((member[s] as number) >>> lane) & 1) << s;
    }
    const at = memberAt + (combinations ? mask : popcount32(mask));
    tallies[at] = (tallies[at] as number) + 1;
  }
}

/**
 * The histogram sink: each kept row's value binned, below the first bin, above the last, or
 * missing (a null; a saturated int is read again on its exact value).
 * @param t - The tallies.
 * @param w - The word, in the block.
 * @param word - Its rows kept, one bit each.
 */
export function tallyHistogram(t: CountTally, w: number, word: number): void {
  const { values, kind, tallies, histogramAt, histogram } = t;
  const { min, width, bins } = histogram as HistogramTask;
  let lanes = word;
  while (lanes !== 0) {
    const lowest = lanes & -lanes;
    lanes ^= lowest;
    const r = (w << 5) | (31 - Math.clz32(lowest));
    let v = values[r] as number;
    if (kind !== FLOAT) {
      const limit = kind === INT32 ? INT32_LIMIT : INT16_LIMIT;
      if (v === (kind === INT32 ? INT32_NULL : INT16_NULL)) v = Number.NaN;
      else if (v === limit || v === -limit) v = exactValue(t, r);
    }
    let slot = bins + 2;
    if (!Number.isNaN(v)) {
      const bin = Math.floor((v - min) / width);
      slot = bin < 0 ? 0 : bin >= bins ? bins + 1 : bin + 1;
    }
    tallies[histogramAt + slot] = (tallies[histogramAt + slot] as number) + 1;
  }
}

/**
 * The exact value of a saturated int, read with the columns SQL.
 * @param t - The tallies.
 * @param r - The row in the block.
 * @returns The value, NaN when the row has none.
 */
function exactValue(t: CountTally, r: number): number {
  const row = t.exact(t.kBase + (t.seq[r] as number));
  const value = row?.[2 + (t.histogram as HistogramTask).column];
  return value === null || value === undefined ? Number.NaN : Number(value);
}
