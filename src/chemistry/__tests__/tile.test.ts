import { RECORD_WORDS } from 'openchemlib-search-wasm';
import { expect, test } from 'vitest';

import { MAX_ATOMS, SEQ_SPAN, atomCountOf, makeId, seqOf } from '../key.ts';
import {
  FUNCTION_PLANES_AT,
  MAX_BAND,
  MOLECULE_WORDS,
  PLANES,
  addSlot,
  bandOfWeight,
  clearSlot,
  newTile,
  slotWords,
  splitTileKey,
  tileKey,
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

test('a slot holds its 48 words as bits of the 1,536 planes, and an emptied slot stays used', () => {
  const tile = newTile();
  const words = new Int32Array(96);
  for (let i = 0; i < 96; i++) words[i] = Math.imul(i + 1, 0x9e3779b1);

  expect(addSlot(tile, words, 0, 11, 300)).toBe(0);
  expect(addSlot(tile, words, 48, 12, 301)).toBe(1);
  expect(Array.from(slotWords(tile, 0))).toStrictEqual(
    Array.from(words.subarray(0, 48)),
  );
  expect(Array.from(slotWords(tile, 1))).toStrictEqual(
    Array.from(words.subarray(48)),
  );
  expect([tile.seqs[1], tile.bits[1], tile.used[0]]).toStrictEqual([
    12, 301, 2,
  ]);

  clearSlot(tile, 0);

  expect(Array.from(slotWords(tile, 0))).toStrictEqual(new Array(48).fill(0));
  expect(Array.from(slotWords(tile, 1))).toStrictEqual(
    Array.from(words.subarray(48)),
  );
  expect([tile.seqs[0], tile.used[0]]).toStrictEqual([0, 2]);
});

test('the words of every slot read back in one pass, a slot written in place included', () => {
  const tile = newTile();
  const words = new Int32Array(144);
  for (let i = 0; i < 144; i++) words[i] = Math.imul(i + 7, 0x85ebca6b);
  addSlot(tile, words, 0, 1, 10);
  addSlot(tile, words, 48, 2, 11);
  tile.used[0] = 32;
  writeSlot(tile, 31, words, 96, 3, 12);
  const all = tileWords(tile);

  for (const slot of [0, 1, 31]) {
    expect(Array.from(all.subarray(48 * slot, 48 * slot + 48))).toStrictEqual(
      Array.from(slotWords(tile, slot)),
    );
  }

  expect(Array.from(all.subarray(48 * 31))).toStrictEqual(
    Array.from(words.subarray(96)),
  );
  expect(Array.from(all.subarray(96, 48 * 31))).toStrictEqual(
    Array.from({ length: 48 * 29 }, () => 0),
  );
  expect([tile.seqs[31], tile.bits[31], tile.used[0]]).toStrictEqual([
    3, 12, 32,
  ]);
});

test('a function key k lands on plane 1024 + (k ^ 31), and clearSlot clears the function planes', () => {
  const tile = newTile();
  const words = new Int32Array(MOLECULE_WORDS);
  // Function key 0 is the highest bit of word 32, key 37 bit 26 of word 33, key 511 bit 0 of word 47.
  for (const key of [0, 37, 511]) {
    const word = 32 + (key >> 5);
    words[word] = (words[word] as number) | (1 << (31 - (key & 31)));
  }
  addSlot(tile, words, 0, 1, 0);
  addSlot(tile, words, 0, 2, 0);
  const set: number[] = [];
  for (let plane = 0; plane < PLANES; plane++) {
    if (tile.planes[plane] !== 0) set.push(plane);
  }

  expect(set).toStrictEqual(
    [0 ^ 31, 37 ^ 31, 511 ^ 31].map((key) => FUNCTION_PLANES_AT + key),
  );
  expect(tile.planes[FUNCTION_PLANES_AT + (37 ^ 31)]).toBe(0b11);

  clearSlot(tile, 0);

  expect(tile.planes[FUNCTION_PLANES_AT + (37 ^ 31)]).toBe(0b10);

  clearSlot(tile, 1);

  expect(tile.planes.subarray(FUNCTION_PLANES_AT)).toStrictEqual(
    new Int32Array(PLANES - FUNCTION_PLANES_AT),
  );
});

test('a molecule takes the 48 words of the wasm record as they are', () => {
  expect(RECORD_WORDS).toBe(MOLECULE_WORDS);
});
