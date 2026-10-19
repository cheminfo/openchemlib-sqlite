import type { Signatures } from '../chemistry/stamp.ts';

import type { CountedFingerprint } from './bitCounts.ts';
import { COUNTED_FINGERPRINTS } from './bitCounts.ts';
import type { StoredFingerprint } from './metaChecks.ts';
import { isPreRelease, staleTiles } from './metaChecks.ts';
import type { StoreMeta } from './schema.ts';

/** What a file needs before this build can use all of it. */
export interface StoreUpdates {
  /**
   * Its molecules were canonized or hashed differently, or a pre-release 6.0 build wrote it: they
   * must be committed again into a new file, which no rebuild does.
   */
  identity: boolean;
  /** The fingerprints whose stored bits a rebuild computes again. */
  tiles: StoredFingerprint[];
  /** The fingerprints whose bits a rebuild counts again. */
  counts: CountedFingerprint[];
  /** Whether a rebuild writes the idCode hashes, missing or computed otherwise. */
  idCodeHash: boolean;
  /** Whether a rebuild is under way: the writes log what they change, for it to catch up. */
  rebuilding: boolean;
}

/** Options of `MoleculeStore.rebuild()`. */
export interface RebuildOptions {
  /**
   * Worker threads computing the fingerprints.
   * @default availableParallelism() - 1, at least 1
   */
  threads?: number;
  /**
   * Tiles (32 molecules each) per step of the first pass; each step ends in one short write
   * transaction.
   * @default 256
   */
  tilesPerStep?: number;
  /** Stops the rebuild between steps; calling `rebuild()` again resumes it. */
  signal?: AbortSignal;
  /** Hears each step. */
  onProgress?: (progress: RebuildProgress) => void;
}

/** How far a rebuild is. */
export interface RebuildProgress {
  /**
   * `idCodeHash`: the pass writing the idCode hashes, whose `molecules` counts this call's;
   * `tiles`: the pass building the new tiles and counts, whose `molecules` counts this call's and
   * those of the calls it resumes.
   */
  step: 'idCodeHash' | 'tiles';
  /** Molecules done. */
  molecules: number;
  /** Molecules the file held when this call started. */
  total: number;
}

/** What a rebuild did. */
export interface RebuildResult {
  /** The fingerprints whose stored bits were computed again. */
  rebuilt: StoredFingerprint[];
  /** The fingerprints whose bits were counted again. */
  counted: CountedFingerprint[];
  /** Molecules whose tiles or counts this call computed, those the writes added meanwhile included. */
  molecules: number;
  /** idCode hashes this call wrote. */
  hashed: number;
}

/**
 * What a file needs before this build can use all of it.
 * @param meta - The file's `ocl_meta`.
 * @param signatures - This build's signatures.
 * @returns The updates.
 */
export function updatesOf(
  meta: StoreMeta,
  signatures: Signatures,
): StoreUpdates {
  const rebuilding = meta.rebuild !== '';
  const stored = meta.signatures;
  if (
    stored === null ||
    isPreRelease(meta) ||
    stored.identity !== signatures.identity
  ) {
    return {
      identity: true,
      tiles: [],
      counts: [],
      idCodeHash: false,
      rebuilding,
    };
  }
  return {
    identity: false,
    tiles: staleTiles(stored, signatures),
    counts: COUNTED_FINGERPRINTS.filter(
      (fingerprint) => meta.counted[fingerprint] !== signatures[fingerprint],
    ),
    idCodeHash: stored.idCodeHash !== signatures.idCodeHash,
    rebuilding,
  };
}
