import { parentPort } from 'node:worker_threads';

import type { HashKind } from './utils/structureHash.ts';
import { structureHashOutcome } from './utils/structureHash.ts';

/** One molecule sent to a hashing worker. */
export interface HashRequest {
  kind: HashKind;
  idCode: string;
  /** The ceiling on tautomer enumeration; see `structureHash`. */
  maxTautomers: number;
}

/** What the worker answers with, once the molecule is hashed. */
export interface HashResponse {
  /** The hash as a decimal string, or null when there is none for it. */
  hash: string | null;
  /** Whether the ceiling cut the tautomer enumeration short. */
  truncated: boolean;
}

/**
 * Hash one idCode, as the string the parent writes into the database.
 *
 * `postMessage` does carry a BigInt, but the parent binds the value to an SQLite
 * INTEGER column, and a decimal string converts back with no precision to lose
 * either way.
 * @param kind - Which hash to compute.
 * @param idCode - The molecule to hash.
 * @param maxTautomers - The ceiling on tautomer enumeration.
 * @returns Its hash as a decimal string, or null when there is none.
 */
export function hashIdCode(
  kind: HashKind,
  idCode: string,
  maxTautomers?: number,
): string | null {
  return hashResponse(kind, idCode, maxTautomers).hash;
}

/**
 * The same, with why an absent hash is absent, which is what the parent needs to
 * tell "we stopped" from "OpenChemLib cannot answer".
 * @param kind - Which hash to compute.
 * @param idCode - The molecule to hash.
 * @param maxTautomers - The ceiling on tautomer enumeration.
 * @returns The hash as a decimal string, and whether the ceiling cut it short.
 */
export function hashResponse(
  kind: HashKind,
  idCode: string,
  maxTautomers?: number,
): HashResponse {
  const { hash, truncated } = structureHashOutcome(kind, idCode, maxTautomers);
  return { hash: hash === null ? null : String(hash), truncated };
}

// Running as a worker: warm the wasm module before reporting ready, so the
// parent's cap never fires on the first molecule paying for the module load.
if (parentPort) {
  const port = parentPort;
  // Ethane: parsing it instantiates the module and nothing more.
  hashIdCode('noStereoTautomer', 'eF@Hp@');
  port.postMessage({ ready: true });
  port.on('message', (request: HashRequest) => {
    port.postMessage(
      hashResponse(
        request.kind,
        request.idCode,
        request.maxTautomers,
      ) satisfies HashResponse,
    );
  });
}
