import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as OCL from 'openchemlib';
import {
  NO_HASH,
  getFunctions,
  getIndexes,
  getMoleculeSizes,
  getNoStereoHashes,
  getNoStereoTautomerHashes,
  getScreens,
  strongHash,
} from 'openchemlib-search-wasm';
import { expect, test } from 'vitest';

import {
  MAX_TAUTOMERS,
  computeFingerprints,
  computeRecords,
} from '../records.ts';
import { MOLECULE_WORDS, bandOfWeight } from '../tile.ts';

// Every fifth molecule of the committed sample: 419 molecules, the heavy ones included.
const idCodes = readFileSync(
  join(import.meta.dirname, '../../__tests__/data/molecules.txt'),
)
  .toString('latin1')
  .split('\n')
  .filter(Boolean)
  .filter((_, i) => i % 5 === 0);

test('the records agree with openchemlib-js on the canonical idCode, the atom count and the band', () => {
  const records = computeRecords(idCodes);
  const differences: string[] = [];
  for (let i = 0; i < idCodes.length; i++) {
    const molecule = OCL.Molecule.fromIDCode(idCodes[i] as string);
    const expected = [
      molecule.getIDCode(),
      molecule.getAllAtoms(),
      bandOfWeight(molecule.getMolecularFormula().relativeWeight),
    ];
    const actual = [records.idCodes[i], records.atoms[i], records.bands[i]];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      differences.push(`${i}: ${JSON.stringify([actual, expected])}`);
    }
  }

  expect(idCodes).toHaveLength(419);
  expect(records.errors.filter((error) => error !== null)).toStrictEqual([]);
  expect(differences).toStrictEqual([]);
});

test('the records agree with the separate wasm calls they replace', () => {
  const n = idCodes.length;
  const records = computeRecords(idCodes);
  const fragFps = getIndexes(idCodes);
  const screens = getScreens(idCodes);
  const sizes = getMoleculeSizes(idCodes);
  const noStereo = getNoStereoHashes(idCodes);
  const counts = new Int32Array(n);
  const tautomers = getNoStereoTautomerHashes(idCodes, {
    maxTautomers: MAX_TAUTOMERS,
    tautomerCounts: counts,
  });
  const words = new Int32Array(MOLECULE_WORDS * n);
  const tautomerHashes = new BigInt64Array(n);
  const truncated = new Uint8Array(n);
  const bands = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    words.set(fragFps[i] as Int32Array, MOLECULE_WORDS * i);
    words.set(screens[i] as Int32Array, MOLECULE_WORDS * i + 16);
    truncated[i] = (counts[i] as number) >= MAX_TAUTOMERS ? 1 : 0;
    tautomerHashes[i] =
      truncated[i] === 1 || tautomers[i] === NO_HASH
        ? (noStereo[i] as bigint)
        : (tautomers[i] as bigint);
    bands[i] = bandOfWeight(sizes.weights[i] as number);
  }

  expect(records.words).toStrictEqual(words);
  expect(records.noStereoHashes).toStrictEqual(noStereo);
  expect(records.tautomerHashes).toStrictEqual(tautomerHashes);
  expect(records.truncated).toStrictEqual(truncated);
  expect(records.atoms).toStrictEqual(sizes.atomCounts);
  expect(records.bands).toStrictEqual(bands);
});

/**
 * One fingerprint per molecule, joined.
 * @param fingerprints - 16 words each.
 * @returns The words, molecule after molecule.
 */
function joined(fingerprints: Int32Array[]): Int32Array {
  const out = new Int32Array(16 * fingerprints.length);
  for (const [i, words] of fingerprints.entries()) out.set(words, 16 * i);
  return out;
}

test('the records carry the function bits and the hash of the canonical idCode, and each way of computing a fingerprint gives the same words', () => {
  const sample = idCodes.slice(0, 120);
  const fragFp = joined(getIndexes(sample));
  const screen = joined(getScreens(sample));
  const functions = joined(getFunctions(sample));

  const records = computeRecords(sample);

  expect(records.functions).toStrictEqual(functions);
  expect(records.idCodeHashes).toStrictEqual(
    BigInt64Array.from(records.idCodes, (idCode) => strongHash(idCode)),
  );

  for (const need of [
    { fragFp: false, screen: true, functions: false },
    { fragFp: false, screen: false, functions: true },
    { fragFp: false, screen: true, functions: true },
    { fragFp: true, screen: true, functions: true },
  ]) {
    expect(computeFingerprints(sample, need)).toStrictEqual({
      fragFp: need.fragFp ? fragFp : null,
      screen: need.screen ? screen : null,
      functions: need.functions ? functions : null,
    });
  }
});
