import { XSadd } from 'ml-xsadd';
import { expect, test } from 'vitest';

import { popcount32 } from '../../../chemistry/bits.ts';
import { PLANES } from '../../../chemistry/tile.ts';
import type { BlockViews, ColumnLayout } from '../../blocks.ts';
import { INT16_LIMIT, INT16_NULL } from '../../blocks.ts';
import type { CountTally } from '../countSink.ts';
import { flushKeys, newTally, tallyBlock, tallyWord } from '../countSink.ts';
import type { CountPhase } from '../messages.ts';

const W = 256;

/**
 * The exact values of a row, as the columns SQL reads them: its int16 column 40,000 and more.
 * @param id - The row's id.
 * @returns Its id, key and column.
 */
function exact(id: number): number[] {
  return [id, 0, 40_000 + id];
}
const LAYOUT: ColumnLayout = {
  rowBytes: 0,
  seqAt: 0,
  fragFpBitsAt: 0,
  screenBitsAt: 0,
  functionBitsAt: 0,
  filters: [{ name: 'hba', type: 'int16', at: 0 }],
};

/**
 * A block of seeded planes and values, as the count's sinks read it.
 * @param seed - The seed.
 * @returns Its views: planes, keys, an int16 column with nulls and saturated values.
 */
function seededBlock(seed: number): BlockViews {
  const random = new XSadd(seed);
  const planes = new Int32Array(PLANES * W);
  for (let i = 0; i < planes.length; i++) planes[i] = random.getUint32() | 0;
  const key = new Float64Array(32 * W);
  const hba = new Int16Array(32 * W);
  for (let r = 0; r < 32 * W; r++) {
    key[r] = 100 + random.getFloat() * 300;
    const draw = random.getFloat();
    hba[r] =
      draw < 0.05
        ? INT16_NULL
        : draw < 0.08
          ? INT16_LIMIT
          : Math.floor(random.getFloat() * 12);
  }
  return {
    planes,
    W,
    key,
    seq: Uint32Array.from({ length: 32 * W }, (_, r) => r + 1),
    fragFpBits: new Uint16Array(32 * W),
    screenBits: new Uint16Array(32 * W),
    functionBits: new Uint16Array(32 * W),
    filters: [hba],
    zones: {} as BlockViews['zones'],
  };
}

/**
 * A count phase holding only what the sinks read.
 * @param fields - The tallies asked for.
 * @returns The phase.
 */
function phase(fields: Partial<CountPhase>): CountPhase {
  const base = {
    bySets: [],
    byKeys: new Int32Array(0),
    membership: [],
    histogram: null,
  };
  const merged = { ...base, ...fields } as CountPhase;
  const memberSize =
    merged.membership.length === 0
      ? 0
      : merged.membership.length <= 16
        ? 2 ** merged.membership.length
        : merged.membership.length + 1;
  merged.tallies =
    1 +
    merged.bySets.length +
    merged.byKeys.length +
    memberSize +
    (merged.histogram === null ? 0 : merged.histogram.bins + 3);
  return merged;
}

/**
 * Feeds the sinks the kept words of one entry [w0, w1).
 * @param t - The tallies.
 * @param words - The kept word of each word of the entry (0 for none kept).
 * @param w0 - The entry's first word.
 */
function feed(t: CountTally, words: Int32Array, w0: number): void {
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as number;
    if (word !== 0) tallyWord(t, w0 + i, w0 + i, word);
  }
  flushKeys(t, w0, w0 + words.length);
}

test.each([
  ['every word kept, read plane by plane', 1],
  ['one word in 40 kept, read one by one', 1 / 40],
])('byKeys with %s equals a brute count', (_name, share) => {
  const view = seededBlock(1);
  const keys = Int32Array.from([0, 31, 600, 1024, 1535]);
  const t = newTally(phase({ byKeys: keys }), () => undefined);
  tallyBlock(t, view, LAYOUT, 0);
  const random = new XSadd(2);
  const words = new Int32Array(W);
  for (let w = 0; w < W; w++) {
    if (random.getFloat() < share) words[w] = random.getUint32() | 1;
  }
  feed(t, words, 0);
  const expected = [0, 0, 0, 0, 0];
  for (const [k, plane] of keys.entries()) {
    for (let w = 0; w < W; w++) {
      expected[k] =
        (expected[k] as number) +
        popcount32(
          (view.planes[plane * W + w] as number) & (words[w] as number),
        );
    }
  }

  expect(Array.from(t.tallies.subarray(1, 6))).toStrictEqual(expected);
  expect(t.kept).toBe(0);
});

test('membership by combination and by count, and a histogram of an int16 column with nulls', () => {
  const view = seededBlock(3);
  const maps = [7, 8, 9].map((seed) => {
    const random = new XSadd(seed);
    return Int32Array.from({ length: W }, () => random.getUint32() | 0);
  });
  const buffers = maps.map((map) => {
    const buffer = new SharedArrayBuffer(4 * W);
    new Int32Array(buffer).set(map);
    return buffer;
  });
  const t = newTally(
    phase({
      membership: [
        buffers[0] as SharedArrayBuffer,
        null,
        buffers[2] as SharedArrayBuffer,
      ],
      histogram: { column: 0, min: 1, width: 3, bins: 3 },
    }),
    exact,
  );
  tallyBlock(t, view, LAYOUT, 0);
  const words = Int32Array.from({ length: 64 }, (_, w) =>
    w % 3 === 0 ? -1 : 0x00ff00ff,
  );
  feed(t, words, 0);
  const combinations = new Array<number>(8).fill(0);
  const histogram = new Array<number>(6).fill(0);
  for (let w = 0; w < 64; w++) {
    for (let lane = 0; lane < 32; lane++) {
      if ((((words[w] as number) >>> lane) & 1) === 0) continue;
      let mask = 0;
      if ((((maps[0] as Int32Array)[w] as number) >>> lane) & 1) mask |= 1;
      if ((((maps[2] as Int32Array)[w] as number) >>> lane) & 1) mask |= 4;
      combinations[mask] = (combinations[mask] as number) + 1;
      const r = 32 * w + lane;
      const value = view.filters[0]?.[r] as number;
      let slot = 5;
      if (value === INT16_LIMIT) {
        slot = 4;
      } else if (value !== INT16_NULL) {
        const bin = Math.floor((value - 1) / 3);
        slot = bin < 0 ? 0 : bin >= 3 ? 4 : bin + 1;
      }
      histogram[slot] = (histogram[slot] as number) + 1;
    }
  }

  expect(Array.from(t.tallies.subarray(1, 9))).toStrictEqual(combinations);
  expect(Array.from(t.tallies.subarray(9))).toStrictEqual(histogram);
  expect(histogram.every((count) => count > 0)).toBe(true);
  expect(t.tallies[0]).toBe(combinations.reduce((a, b) => a + b, 0));
});
