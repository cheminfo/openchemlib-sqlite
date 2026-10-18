import { NO_HASH } from 'openchemlib-search-wasm';

import type { ChemistryPool } from './chemistryPool.ts';
import type { IdentityStatements } from './identity.ts';
import { sameNoStereo } from './identity.ts';
import type { ReaderPool } from './readerPool.ts';
import type { StoredRow } from './readerWorker.ts';

/** What a lookup reads with, besides the chemistry workers. */
export interface FindContext {
  /** The connection's identity statements. */
  identity: IdentityStatements;
  /** Readers off the caller's thread, for the molecules of the hashes that are stored. */
  readers?: ReaderPool;
}

/**
 * The ids of stored molecules, by idCode (canonical or not): the no-stereo hash narrows to the
 * stored stereoisomers, and the canonical idCode is computed only when none of them is the idCode
 * given. With readers, the stored molecules are read off the caller's thread.
 * @param pool - The chemistry workers.
 * @param idCodes - The molecules.
 * @param context - The connection and its statements, and the readers when the store has them.
 * @returns Per idCode, the id, or undefined when the store does not hold it.
 */
export async function findIds(
  pool: ChemistryPool,
  idCodes: readonly string[],
  context: FindContext,
): Promise<Array<number | undefined>> {
  const { identity, readers } = context;
  const hashes = await pool.noStereo(idCodes);
  const candidates: number[] = [];
  for (let i = 0; i < idCodes.length; i++) {
    if (hashes[i] !== NO_HASH) candidates.push(i);
  }
  const keys = candidates.map((i) => hashes[i] as bigint);
  const rows: StoredRow[][] =
    readers === undefined
      ? keys.map((hash) =>
          sameNoStereo(identity, hash).map((row): StoredRow => [
            row.id,
            row.idCode,
          ]),
        )
      : await readers.sameNoStereo(keys);
  const out = new Array<number | undefined>(idCodes.length).fill(undefined);
  const pending: number[] = [];
  for (let j = 0; j < candidates.length; j++) {
    const i = candidates[j] as number;
    const same = rows[j] as StoredRow[];
    const exact = same.find((row) => row[1] === idCodes[i]);
    if (exact !== undefined) out[i] = exact[0];
    else if (same.length > 0) pending.push(j);
  }
  if (pending.length > 0) {
    // Rare: a stereoisomer is stored, or the idCode given is not canonical.
    const records = await pool.records(
      pending.map((j) => idCodes[candidates[j] as number] as string),
    );
    for (const [k, j] of pending.entries()) {
      const canonical = records.idCodes[k];
      out[candidates[j] as number] = (rows[j] as StoredRow[]).find(
        (row) => row[1] === canonical,
      )?.[0];
    }
  }
  return out;
}
