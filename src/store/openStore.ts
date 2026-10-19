import { availableParallelism } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

import type { Signatures } from '../chemistry/stamp.ts';
import { computeSignatures, computeStamp } from '../chemistry/stamp.ts';

import { countingOf } from './bitCounts.ts';
import { checkSample, mismatchError } from './check.ts';
import { ChemistryPool } from './chemistryPool.ts';
import { ensureDistinctCounts } from './distinctCounts.ts';
import { validateMeta } from './metaChecks.ts';
import { ReaderPool } from './readerPool.ts';
import { createStore, hasStore, readMeta } from './schema.ts';
import type { MoleculeStoreOptions } from './storeOptions.ts';
import { refuseV5 } from './v5Schema.ts';
import type { WriteState } from './writeState.ts';

/** What an open store is made of, besides the connection. */
export interface StoreParts {
  /** The stamp of this build. */
  stamp: string;
  /** The signatures of this build. */
  signatures: Signatures;
  /** The file's generation, and which bit counts its writes keep. */
  state: WriteState;
  /** The chemistry workers. */
  pool: ChemistryPool;
  /** The readers, when asked for. */
  readers: ReaderPool | undefined;
}

/**
 * Opens the store's tables in a database: creates them in a new one, refuses one written in
 * another format, by a pre-release 6.0 build or under other signatures, counts the distinct hashes
 * of one written before the library kept them, recomputes a sample of its molecules, then starts
 * the readers when asked to.
 * @param db - The application's connection, outside any transaction.
 * @param options - Threads, the opening check and the readers.
 * @param migrating - Whether a migration from 5.x opens it, which takes a file still holding 5.x
 * tables.
 * @returns The parts of the store.
 */
export async function openStoreParts(
  db: DatabaseSync,
  options: MoleculeStoreOptions,
  migrating = false,
): Promise<StoreParts> {
  const {
    threads = Math.max(1, availableParallelism() - 1),
    checkRows = 32,
    checkSeed = 1,
    readers = 0,
  } = options;
  const file = readers > 0 ? db.location() : null;
  if (readers > 0 && file === null) {
    throw new Error(
      'readers open the database file: an in-memory database has none',
    );
  }
  if (!migrating) refuseV5(db);
  const stamp = await computeStamp();
  const signatures = await computeSignatures();
  if (hasStore(db)) {
    validateMeta(readMeta(db), stamp, signatures);
  } else {
    createStore(db, stamp, signatures);
  }
  ensureDistinctCounts(db);
  const meta = readMeta(db);
  const pool = new ChemistryPool(threads);
  if (checkRows > 0) {
    const mismatches = await checkSample(db, pool, checkRows, checkSeed);
    if (mismatches.length > 0) {
      await pool.close();
      throw mismatchError(mismatches);
    }
  }
  return {
    stamp,
    signatures,
    state: {
      generation: meta.generation,
      counting: countingOf(meta.counted, signatures),
    },
    pool,
    readers: file === null ? undefined : new ReaderPool(file, readers),
  };
}
