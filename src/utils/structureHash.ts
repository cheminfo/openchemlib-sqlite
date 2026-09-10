import {
  NO_HASH,
  getNoStereoHash,
  getNoStereoTautomerHash,
} from 'openchemlib-search-wasm';

import {
  NO_STEREO_HASH_TABLE,
  NO_STEREO_TAUTOMER_HASH_TABLE,
} from '../schema.ts';

/** Which of the two structure hashes to compute. */
export type HashKind = 'noStereo' | 'noStereoTautomer';

/** The table each hash is stored in. */
export const HASH_TABLE: Record<HashKind, string> = {
  noStereo: NO_STEREO_HASH_TABLE,
  noStereoTautomer: NO_STEREO_TAUTOMER_HASH_TABLE,
};

const HASH_FUNCTION: Record<HashKind, (idCode: string) => bigint> = {
  noStereo: getNoStereoHash,
  noStereoTautomer: getNoStereoTautomerHash,
};

/**
 * One of the two structure hashes of an idCode, or null when there is none.
 *
 * Null covers every way a molecule can fail to have one, because they are the
 * same answer to every caller: OpenChemLib returns `NO_HASH` for an idCode it
 * cannot parse, but a *malformed* one makes it throw instead ("array element
 * access out of bounds"). Stored, both become the NULL that means "this entry
 * has no such hash"; queried, both mean a query that matches nothing.
 *
 * `NO_HASH` is folded in here rather than stored, so that an entry legitimately
 * hashing to 0 could never be returned for every unparsable query.
 * @param kind - Which hash to compute.
 * @param idCode - The molecule to hash.
 * @returns Its hash, or null when there is none.
 */
export function structureHash(kind: HashKind, idCode: string): bigint | null {
  try {
    const hash = HASH_FUNCTION[kind](idCode);
    return hash === NO_HASH ? null : hash;
  } catch {
    return null;
  }
}
