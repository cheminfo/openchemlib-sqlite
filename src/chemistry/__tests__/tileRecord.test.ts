import { XSadd } from 'ml-xsadd';
import { expect, test } from 'vitest';

import type { TileViews } from '../tile.ts';
import {
  FUNCTION_PLANES,
  FUNCTION_PLANES_AT,
  PLANES,
  SLOTS,
  TILE_FIXED_BYTES,
  newTile,
} from '../tile.ts';
import {
  recordWords,
  scatterFunctionPlanes,
  tileBytes,
  tileViews,
} from '../tileRecord.ts';

/**
 * A full tile of seeded planes, `functions` of its function planes non-zero.
 * @param seed - The seed.
 * @param functions - The function planes to fill: none, every one, or each with a probability.
 * @returns The tile and how many function planes it holds.
 */
function seededTile(
  seed: number,
  functions: 'none' | 'all' | number,
): { tile: TileViews; stored: number } {
  const random = new XSadd(seed);
  const tile = newTile();
  for (let p = 0; p < FUNCTION_PLANES_AT; p++) {
    tile.planes[p] = random.getUint32() | 0;
  }
  let stored = 0;
  for (let p = FUNCTION_PLANES_AT; p < PLANES; p++) {
    const fill =
      functions === 'all' ||
      (typeof functions === 'number' && random.getFloat() < functions);
    if (!fill) continue;
    // Never zero: bit 31 marks a word that must be stored.
    tile.planes[p] = random.getUint32() | (1 << 31);
    stored++;
  }
  for (let slot = 0; slot < SLOTS; slot++) {
    tile.seqs[slot] = (random.getUint32() >>> 1) + slot;
    tile.bits[slot] = random.getUint32() & 0xffff;
  }
  tile.used[0] = SLOTS;
  return { tile, stored };
}

test.each([
  ['no function word', 'none', 0],
  ['all 512 function words', 'all', FUNCTION_PLANES],
  ['a seeded half of the function words', 0.5, 268],
] as const)(
  'a tile with %s is stored in TILE_FIXED_BYTES + 4 per non-zero function word, and read back dense',
  (_name, functions, expected) => {
    const { tile, stored } = seededTile(17, functions);
    const record = tileBytes(tile);

    expect(stored).toBe(expected);
    expect(record.byteLength).toBe(TILE_FIXED_BYTES + 4 * expected);

    const read = tileViews(record);

    expect(read.planes).toStrictEqual(tile.planes);
    expect(read.seqs).toStrictEqual(tile.seqs);
    expect(read.bits).toStrictEqual(tile.bits);
    expect(read.used).toStrictEqual(tile.used);
    expect(tileBytes(read)).toStrictEqual(record);
  },
);

test('the empty tile is 4,356 bytes and the full one 6,404', () => {
  expect(tileBytes(newTile()).byteLength).toBe(4356);
  expect(tileBytes(seededTile(3, 'all').tile).byteLength).toBe(6404);
});

test('a record SQLite hands unaligned is read from a copy', () => {
  const { tile } = seededTile(5, 0.3);
  const record = tileBytes(tile);
  const shifted = new Uint8Array(record.byteLength + 1);
  shifted.set(record, 1);
  const read = tileViews(shifted.subarray(1));

  expect(read.planes).toStrictEqual(tile.planes);
  expect(read.seqs).toStrictEqual(tile.seqs);
});

test('a 4,292-byte record of a pre-release build, or a record cut short, is refused', () => {
  expect(() => tileViews(new Uint8Array(4292))).toThrow(
    'a tile holds 4356 bytes for its function mask, not 4292: a file of a pre-release 6.0 build, which this build refuses',
  );

  const record = tileBytes(seededTile(9, 0.25).tile);

  expect(() => recordWords(record.subarray(0, record.byteLength - 4))).toThrow(
    `a tile holds ${record.byteLength} bytes for its function mask, not ${record.byteLength - 4}`,
  );
});

test('the stored function words scatter into strided planes, masked, the others left alone', () => {
  const { tile } = seededTile(11, 0.5);
  const words = recordWords(tileBytes(tile));
  const W = 3;
  const target = new Int32Array(PLANES * W).fill(7);
  const mask = 0x0000ffff;
  scatterFunctionPlanes(words, target, W, 1, mask);
  for (let p = FUNCTION_PLANES_AT; p < PLANES; p++) {
    const word = tile.planes[p] as number;

    expect(target[p * W + 1], `plane ${p}`).toBe(word === 0 ? 7 : word & mask);
    expect(target[p * W]).toBe(7);
  }
});
