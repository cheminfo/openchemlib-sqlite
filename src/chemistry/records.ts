import {
  NO_HASH,
  NO_ID_CODE,
  RECORD_WORDS,
  getFunctions,
  getMoleculeRecords,
  getScreens,
  strongHash,
} from 'openchemlib-search-wasm';

import { FINGERPRINT_WORDS, FUNCTION_WORDS_AT, countBits } from './bits.ts';
import { clampAtoms } from './key.ts';
import { MOLECULE_WORDS, bandOfWeight } from './tile.ts';

/**
 * The tautomer enumeration cap: a work bound, no clock. A molecule that reaches it takes its
 * no-stereo hash as tautomer hash. Part of the stamp.
 */
export const MAX_TAUTOMERS = 5000;

/** What the library computes from a batch of idCodes, one column per value. */
export interface RecordColumns {
  /** The canonical idCode of each molecule, `''` when it has an error. */
  idCodes: string[];
  /** Why each molecule cannot be stored, `null` when it can. */
  errors: Array<string | null>;
  /** Atom counts, explicit hydrogens included, clamped to the key's range. */
  atoms: Int32Array;
  /** Bands: the floor of OpenChemLib's own weight, clamped. */
  bands: Int32Array;
  /** FragFp bit counts. */
  bits: Int32Array;
  /** 48 words per molecule: FragFp, the screen, the function keys; the record of getMoleculeRecords. */
  words: Int32Array;
  /** Hashes of the canonical idCode (StrongHasher); 0 for a molecule with an error. */
  idCodeHashes: BigInt64Array;
  /** No-stereo hashes. */
  noStereoHashes: BigInt64Array;
  /** Tautomer hashes; the no-stereo hash when the enumeration was truncated. */
  tautomerHashes: BigInt64Array;
  /** 1 where the tautomer enumeration reached {@link MAX_TAUTOMERS}. */
  truncated: Uint8Array;
}

/** Which fingerprints to compute. */
export interface FingerprintNeed {
  fragFp: boolean;
  screen: boolean;
  functions: boolean;
}

/** 16 words per molecule of each fingerprint asked for; null for one that was not. */
export interface FingerprintColumns {
  fragFp: Int32Array | null;
  screen: Int32Array | null;
  functions: Int32Array | null;
}

/**
 * Computes, from the idCodes alone and through openchemlib-search-wasm, everything the library
 * stores about each molecule. One parse per molecule.
 * @param inputs - The idCodes.
 * @returns The values, column by column, in input order.
 */
export function computeRecords(inputs: readonly string[]): RecordColumns {
  const records = getMoleculeRecords([...inputs], {
    maxTautomers: MAX_TAUTOMERS,
  });
  const n = inputs.length;
  const columns: RecordColumns = {
    idCodes: new Array<string>(n),
    errors: new Array<string | null>(n),
    atoms: new Int32Array(n),
    bands: new Int32Array(n),
    bits: new Int32Array(n),
    words: records.words,
    idCodeHashes: new BigInt64Array(n),
    noStereoHashes: records.noStereoHashes,
    tautomerHashes: records.tautomerHashes,
    truncated: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    const idCode = records.idCodes[i] as string;
    const atoms = records.atomCounts[i] as number;
    let error: string | null = null;
    if (idCode === NO_ID_CODE || atoms === 0) {
      error = 'the idCode cannot be read';
    } else if (records.noStereoHashes[i] === NO_HASH) {
      error = 'the molecule cannot be canonized';
    }
    columns.errors[i] = error;
    columns.idCodes[i] = error === null ? idCode : '';
    if (error === null) columns.idCodeHashes[i] = strongHash(idCode);
    columns.atoms[i] = clampAtoms(atoms);
    columns.bands[i] = bandOfWeight(records.weights[i] as number);
    columns.bits[i] = countBits(
      columns.words,
      i * MOLECULE_WORDS,
      i * MOLECULE_WORDS + FINGERPRINT_WORDS,
    );
    columns.truncated[i] =
      (records.tautomerCounts[i] as number) >= MAX_TAUTOMERS ? 1 : 0;
  }
  return columns;
}

/**
 * Computes some fingerprints of molecules already stored, with the cheapest call that gives them:
 * the screen alone or the function bits alone with their own call, anything more with one parse
 * for every word, the tautomer enumeration skipped since no hash is wanted.
 * @param inputs - The idCodes.
 * @param need - Which fingerprints.
 * @returns 16 words per molecule of each one asked for.
 */
export function computeFingerprints(
  inputs: readonly string[],
  need: FingerprintNeed,
): FingerprintColumns {
  const n = inputs.length;
  if (need.fragFp || (need.screen && need.functions)) {
    const { words } = getMoleculeRecords([...inputs], { maxTautomers: 0 });
    const part = (from: number) => wordsOf(words, n, from, FINGERPRINT_WORDS);
    return {
      fragFp: need.fragFp ? part(0) : null,
      screen: need.screen ? part(FINGERPRINT_WORDS) : null,
      functions: need.functions ? part(FUNCTION_WORDS_AT) : null,
    };
  }
  return {
    fragFp: null,
    screen: need.screen ? joinWords(getScreens([...inputs])) : null,
    functions: need.functions ? joinWords(getFunctions([...inputs])) : null,
  };
}

/**
 * Some of the words of `getMoleculeRecords`, which holds `RECORD_WORDS` per molecule.
 * @param words - Its words.
 * @param n - How many molecules.
 * @param from - The first word taken from each molecule's record.
 * @param count - How many words are taken.
 * @returns `count` words per molecule.
 */
function wordsOf(
  words: Int32Array,
  n: number,
  from: number,
  count: number,
): Int32Array {
  const out = new Int32Array(n * count);
  for (let i = 0; i < n; i++) {
    const at = i * RECORD_WORDS + from;
    out.set(words.subarray(at, at + count), i * count);
  }
  return out;
}

/**
 * One fingerprint per molecule, joined into one array.
 * @param fingerprints - 16 words per molecule, a view each.
 * @returns The words, molecule after molecule.
 */
function joinWords(fingerprints: Int32Array[]): Int32Array {
  const out = new Int32Array(fingerprints.length * FINGERPRINT_WORDS);
  for (let i = 0; i < fingerprints.length; i++) {
    out.set(fingerprints[i] as Int32Array, i * FINGERPRINT_WORDS);
  }
  return out;
}
