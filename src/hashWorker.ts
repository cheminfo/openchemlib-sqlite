import { parentPort } from 'node:worker_threads';

import type { HashKind } from './utils/structureHash.ts';
import { structureHash } from './utils/structureHash.ts';

/** One molecule sent to a hashing worker. */
export interface HashRequest {
  kind: HashKind;
  idCode: string;
}

/** What the worker answers with, once the molecule is hashed. */
export interface HashResponse {
  /** The hash as a decimal string, or null when there is none for it. */
  hash: string | null;
}

/**
 * Hash one idCode, as the string the parent writes into the database.
 *
 * `postMessage` does carry a BigInt, but the parent binds the value to an SQLite
 * INTEGER column, and a decimal string converts back with no precision to lose
 * either way.
 * @param kind - Which hash to compute.
 * @param idCode - The molecule to hash.
 * @returns Its hash as a decimal string, or null when there is none.
 */
export function hashIdCode(kind: HashKind, idCode: string): string | null {
  const hash = structureHash(kind, idCode);
  return hash === null ? null : String(hash);
}

// Running as a worker: warm the wasm module before reporting ready, so the
// parent's cap never fires on the first molecule paying for the module load.
if (parentPort) {
  const port = parentPort;
  // Ethane: parsing it instantiates the module and nothing more.
  hashIdCode('noStereoTautomer', 'eF@Hp@');
  port.postMessage({ ready: true });
  port.on('message', (request: HashRequest) => {
    port.postMessage({
      hash: hashIdCode(request.kind, request.idCode),
    } satisfies HashResponse);
  });
}
