import { expect, test } from 'vitest';

import { MAX_ATOMS, SEQ_SPAN, atomCountOf, makeId, seqOf } from '../key.ts';
import {
  MAX_BAND,
  TILE_BYTES,
  addSlot,
  bandOfWeight,
  clearSlot,
  slotWords,
  splitTileKey,
  tileKey,
  tileViews,
  writeSlot,
} from '../tile.ts';
import { tileWords } from '../tileWords.ts';

test('ids and tile keys hold their parts exactly', () => {
  const id = makeId(70_000, 2 ** 32 - 1);

  expect(atomCountOf(id)).toBe(MAX_ATOMS);
  expect(seqOf(id)).toBe(2 ** 32 - 1);
  expect(makeId(12, 5)).toBe(12 * SEQ_SPAN + 5);

  const key = tileKey(MAX_ATOMS, MAX_BAND, 2 ** 21 - 1);

  expect(Number.isSafeInteger(key)).toBe(true);
  expect(splitTileKey(key)).toStrictEqual({
    atoms: MAX_ATOMS,
    band: MAX_BAND,
    tileSeq: 2 ** 21 - 1,
  });
  expect(splitTileKey(tileKey(7, 98, 3))).toStrictEqual({
    atoms: 7,
    band: 98,
    tileSeq: 3,
  });
});

test('the band is the floor of the weight, clamped', () => {
  expect([
    bandOfWeight(78.11),
    bandOfWeight(-1),
    bandOfWeight(Number.NaN),
    bandOfWeight(1e9),
  ]).toStrictEqual([78, 0, 0, MAX_BAND]);
});

test('a slot holds its 32 words as bits of the 1,024 planes, and an emptied slot stays used', () => {
  const tile = tileViews(new Uint8Array(TILE_BYTES));
  const words = new Int32Array(64);
  for (let i = 0; i < 64; i++) words[i] = Math.imul(i + 1, 0x9e3779b1);

  expect(addSlot(tile, words, 0, 11, 300)).toBe(0);
  expect(addSlot(tile, words, 32, 12, 301)).toBe(1);
  expect(Array.from(slotWords(tile, 0))).toStrictEqual(
    Array.from(words.subarray(0, 32)),
  );
  expect(Array.from(slotWords(tile, 1))).toStrictEqual(
    Array.from(words.subarray(32)),
  );
  expect([tile.seqs[1], tile.bits[1], tile.used[0]]).toStrictEqual([
    12, 301, 2,
  ]);

  clearSlot(tile, 0);

  expect(Array.from(slotWords(tile, 0))).toStrictEqual(new Array(32).fill(0));
  expect(Array.from(slotWords(tile, 1))).toStrictEqual(
    Array.from(words.subarray(32)),
  );
  expect([tile.seqs[0], tile.used[0]]).toStrictEqual([0, 2]);
});

test('the words of every slot read back in one pass, a slot written in place included', () => {
  const tile = tileViews(new Uint8Array(TILE_BYTES));
  const words = new Int32Array(96);
  for (let i = 0; i < 96; i++) words[i] = Math.imul(i + 7, 0x85ebca6b);
  addSlot(tile, words, 0, 1, 10);
  addSlot(tile, words, 32, 2, 11);
  tile.used[0] = 32;
  writeSlot(tile, 31, words, 64, 3, 12);
  const all = tileWords(tile);

  for (const slot of [0, 1, 31]) {
    expect(Array.from(all.subarray(32 * slot, 32 * slot + 32))).toStrictEqual(
      Array.from(slotWords(tile, slot)),
    );
  }

  expect(Array.from(all.subarray(32 * 31))).toStrictEqual(
    Array.from(words.subarray(64)),
  );
  expect(Array.from(all.subarray(64, 32 * 31))).toStrictEqual(
    Array.from({ length: 32 * 29 }, () => 0),
  );
  expect([tile.seqs[31], tile.bits[31], tile.used[0]]).toStrictEqual([
    3, 12, 32,
  ]);
});
