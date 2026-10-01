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

/**
 * The ceiling on tautomer enumeration, which is what bounds the cost of the
 * tautomer hash — and what decides which molecules have one at all.
 *
 * It is a work bound, not a time bound: the same molecule reaches the ceiling on
 * every machine, so a database holds the same hashes wherever it was filled.
 * 5000 gives up on 2.6% of a drug-like corpus against the 2.3% the old 100 ms
 * clock gave up on, while taking the pass from 58 s to 7 s per 2000 molecules
 * and the slowest molecule from 2.8 s to 320 ms.
 *
 * Changing it changes which molecules have a tautomer hash, so it is recorded in
 * the database and a change rebuilds that table — see `reconcileCeiling`.
 */
export const DEFAULT_MAX_TAUTOMERS = 5000;

/**
 * One of the two structure hashes of an idCode, or null when there is none.
 *
 * Null covers every way a molecule can fail to have one, because they are the
 * same answer to every caller: `NO_HASH` for an idCode OpenChemLib cannot read,
 * and anything thrown. Stored, both become the NULL that means "this entry has
 * no such hash"; queried, both mean a query that matches nothing.
 *
 * `NO_HASH` is folded in here rather than stored, so that an entry legitimately
 * hashing to 0 could never be returned for every unparsable query. The catch is
 * belt and braces: openchemlib-search-wasm 2.0.0 answers `NO_HASH` for a
 * malformed idcode where 1.x let WebAssembly's trap out.
 * @param kind - Which hash to compute.
 * @param idCode - The molecule to hash.
 * @param maxTautomers - The ceiling on tautomer enumeration.
 * @returns Its hash, or null when there is none.
 */
export function structureHash(
  kind: HashKind,
  idCode: string,
  maxTautomers: number = DEFAULT_MAX_TAUTOMERS,
): bigint | null {
  return structureHashOutcome(kind, idCode, maxTautomers).hash;
}

/** A hash, and why there is none when there is none. */
export interface StructureHashOutcome {
  /** The hash, or null when this molecule has none. */
  hash: bigint | null;
  /**
   * Whether the enumeration reached `maxTautomers` instead of finishing. Stored
   * identically to any other absent hash — as NULL — but it tells an operator
   * something different: the ceiling is where this corpus loses entries, and it
   * can be raised.
   */
  truncated: boolean;
}

/**
 * {@link structureHash}, with the reason an absent hash is absent.
 *
 * One computation answers both: asking afterwards whether the ceiling was
 * reached would canonize the molecule a second time, and these are exactly the
 * molecules that cost the most.
 * @param kind - Which hash to compute.
 * @param idCode - The molecule to hash.
 * @param maxTautomers - The ceiling on tautomer enumeration.
 * @returns The hash, and whether the ceiling cut the enumeration short.
 */
export function structureHashOutcome(
  kind: HashKind,
  idCode: string,
  maxTautomers: number = DEFAULT_MAX_TAUTOMERS,
): StructureHashOutcome {
  try {
    if (kind === 'noStereo') {
      const hash = getNoStereoHash(idCode);
      return { hash: hash === NO_HASH ? null : hash, truncated: false };
    }
    // A molecule that reaches the ceiling was not enumerated to the end, so its
    // generic tautomer is whatever the search had reached — not the canonical
    // one, and not a value another molecule's full enumeration would be compared
    // against. It has no hash, which is the same answer as a molecule
    // OpenChemLib cannot read.
    const tautomerCounts = new Int32Array(1);
    const hash = getNoStereoTautomerHash(idCode, {
      maxTautomers,
      tautomerCounts,
    });
    const truncated = (tautomerCounts[0] as number) >= maxTautomers;
    return {
      hash: hash === NO_HASH || truncated ? null : hash,
      truncated,
    };
  } catch {
    return { hash: null, truncated: false };
  }
}
