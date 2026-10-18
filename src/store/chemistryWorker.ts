import { parentPort } from 'node:worker_threads';

import {
  NO_HASH,
  getNoStereoHashes,
  getNoStereoTautomerHashes,
} from 'openchemlib-search-wasm';

import type { FingerprintNeed } from '../chemistry/records.ts';
import {
  MAX_TAUTOMERS,
  computeFingerprints,
  computeRecords,
} from '../chemistry/records.ts';

/** A job for a chemistry worker. */
export interface ChemistryRequest {
  /** Matches the reply to the request. */
  id: number;
  /**
   * `records`: everything stored; `fingerprints`: some fingerprints of stored molecules;
   * `identity`: both hashes; `noStereo`: the no-stereo hash.
   */
  type: 'records' | 'fingerprints' | 'identity' | 'noStereo';
  /** The molecules. */
  idCodes: string[];
  /** For `fingerprints`: which ones. */
  need?: FingerprintNeed;
}

/** Both hashes of each molecule, under the library's tautomer convention. */
export interface IdentityColumns {
  noStereoHashes: BigInt64Array;
  tautomerHashes: BigInt64Array;
}

if (parentPort !== null) {
  const port = parentPort;
  port.on('message', (request: ChemistryRequest) => {
    try {
      const result = run(request);
      port.postMessage({ id: request.id, result });
    } catch (error) {
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function run(request: ChemistryRequest): unknown {
  if (request.type === 'records') return computeRecords(request.idCodes);
  if (request.type === 'fingerprints') {
    return computeFingerprints(
      request.idCodes,
      request.need as FingerprintNeed,
    );
  }
  if (request.type === 'noStereo') return getNoStereoHashes(request.idCodes);
  return identityHashes(request.idCodes);
}

/**
 * The no-stereo and tautomer hashes of each molecule; the tautomer hash is the no-stereo hash when
 * the enumeration reaches {@link MAX_TAUTOMERS} or fails, as stored rows have it.
 * @param idCodes - The molecules.
 * @returns The hashes, NO_HASH for a molecule that cannot be read.
 */
export function identityHashes(idCodes: string[]): IdentityColumns {
  const noStereoHashes = getNoStereoHashes(idCodes);
  const counts = new Int32Array(idCodes.length);
  const tautomerHashes = getNoStereoTautomerHashes(idCodes, {
    maxTautomers: MAX_TAUTOMERS,
    tautomerCounts: counts,
  });
  for (let i = 0; i < idCodes.length; i++) {
    if (
      (counts[i] as number) >= MAX_TAUTOMERS ||
      tautomerHashes[i] === NO_HASH
    ) {
      tautomerHashes[i] = noStereoHashes[i] as bigint;
    }
  }
  return { noStereoHashes, tautomerHashes };
}
