import * as OCL from 'openchemlib';
import { getIndex, getScreen } from 'openchemlib-search-wasm';
import { expect, test } from 'vitest';

import { countKeys } from '../bits.ts';
import { TILE_BYTES, addSlot, tileViews } from '../tile.ts';
import { countTileKeys } from '../tileWords.ts';

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();

/**
 * Whether a fingerprint holds key k, as the key lists of openchemlib-search-wasm document it.
 * @param words - The fingerprint's 16 words.
 * @param key - The key, 0 to 511.
 * @returns Whether its bit is set.
 */
function holds(words: Int32Array, key: number): boolean {
  return ((words[key >> 5] as number) & (1 << (31 - (key & 31)))) !== 0;
}

test('the counts are in key order: methanol holds FragFp key 3, "contains oxygen", methylamine key 16, "contains nitrogen"', () => {
  for (const [molecule, key] of [
    ['CO', 3],
    ['CN', 16],
  ] as const) {
    const words = getIndex(smiles(molecule));
    const counts = new Float64Array(512);
    countKeys(counts, 0, words, 0, 1);

    expect(counts[key]).toBe(1);
    expect(counts).toStrictEqual(
      Float64Array.from({ length: 512 }, (_, k) => (holds(words, k) ? 1 : 0)),
    );
  }
});

test('a molecule taken away leaves the counts as they were', () => {
  const words = getScreen(smiles('c1ccc(Cl)cc1C(=O)N'));
  const counts = new Float64Array(1024);
  countKeys(counts, 512, words, 0, 1);
  countKeys(counts, 512, words, 0, -1);

  expect(counts).toStrictEqual(new Float64Array(1024));
});

test("a tile's planes count as its slots' words do", () => {
  const tile = tileViews(new Uint8Array(TILE_BYTES));
  const expected = new Float64Array(1024);
  for (const [i, molecule] of ['CO', 'Oc1ccccc1', 'CCN', 'ClCCBr'].entries()) {
    const idCode = smiles(molecule);
    const words = new Int32Array(32);
    words.set(getIndex(idCode), 0);
    words.set(getScreen(idCode), 16);
    addSlot(tile, words, 0, i + 1, 0);
    countKeys(expected, 0, words, 0, 1);
    countKeys(expected, 512, words, 16, 1);
  }
  const counts = new Float64Array(1024);
  countTileKeys(counts, tile);

  expect(counts).toStrictEqual(expected);
});
