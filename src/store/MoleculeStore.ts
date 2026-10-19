import type { DatabaseSync } from 'node:sqlite';

import type { RecordColumns } from '../chemistry/records.ts';
import type { Signatures } from '../chemistry/stamp.ts';
import { computeSignatures } from '../chemistry/stamp.ts';

import type { BitCounts } from './bitCounts.ts';
import { readBitCounts } from './bitCounts.ts';
import type { CommitResult, WriteStatements } from './commit.ts';
import { commitRecords, prepareWriteStatements } from './commit.ts';
import type { FindContext } from './find.ts';
import { findIds } from './find.ts';
import type { StoreParts } from './openStore.ts';
import { openStoreParts } from './openStore.ts';
import type { PrefetchRead } from './prefetch.ts';
import { prefetchBatch } from './prefetch.ts';
import type { PreparedBatch } from './prepared.ts';
import { preparedBatch } from './prepared.ts';
import { rebuildStore } from './rebuild.ts';
import { abandonRebuild } from './rebuildState.ts';
import type {
  RebuildOptions,
  RebuildResult,
  StoreUpdates,
} from './rebuildTypes.ts';
import { updatesOf } from './rebuildTypes.ts';
import { removeMolecules } from './remove.ts';
import { readMeta } from './schema.ts';
import type { MoleculeStoreOptions } from './storeOptions.ts';
import { StoreReads } from './storeReads.ts';
import type { WriteCheck, WriteState } from './writeState.ts';
import { checkWritable } from './writeState.ts';

/**
 * The write side and the identity of the library's tables (`ocl_molecule`, `ocl_tile`,
 * `ocl_bits`, `ocl_meta`), in the application's own SQLite file. Everything it stores is computed
 * by the library from the idCode alone: the canonical idCode, the atom count, the band, FragFp, the
 * screen, both identity hashes, and how many molecules hold each FragFp, screen and function key.
 * The application keys its own tables by the same id.
 */
export class MoleculeStore extends StoreReads {
  readonly #find: FindContext;
  readonly #write: WriteStatements;
  readonly #batches = new WeakMap<PreparedBatch, RecordColumns>();
  readonly #signatures: Signatures;
  readonly #state: WriteState;
  /** The stamp of this build, which the file was written under. */
  readonly stamp: string;

  private constructor(db: DatabaseSync, parts: StoreParts) {
    super(db, parts.pool);
    this.stamp = parts.stamp;
    this.#signatures = parts.signatures;
    this.#state = parts.state;
    this.#write = prepareWriteStatements(db);
    this.#find = { ...parts, identity: this.identity };
  }

  /**
   * Opens the store in a database: creates the library's tables in a new one, refuses one written
   * in another format or under another stamp, counts the distinct hashes of one written before
   * the library kept them, and recomputes a sample of its molecules.
   * @param db - The application's connection, outside any transaction.
   * @param options - Threads, the opening check and the readers.
   * @returns The store.
   */
  static async open(
    db: DatabaseSync,
    options: MoleculeStoreOptions = {},
  ): Promise<MoleculeStore> {
    return new MoleculeStore(db, await openStoreParts(db, options));
  }

  /**
   * What a file needs before this build can use all of it: the fingerprints whose keys changed
   * since it was written, and those whose bits are not counted under this build's keys. Nothing
   * is written.
   * @param db - The application's connection.
   * @returns What {@link MoleculeStore.rebuild} would do, and whether the molecules themselves
   * must be committed again.
   */
  static async updates(db: DatabaseSync): Promise<StoreUpdates> {
    return updatesOf(readMeta(db), await computeSignatures());
  }

  /**
   * Brings a file to this build while the build that wrote it keeps serving it: the bits of the
   * fingerprints whose keys changed are computed again from the idCodes and the bits counted again,
   * beside those in use. Writes go on meanwhile and log what they change; the rebuild catches up
   * on that log, and puts its tiles and counts in place in one short transaction. Resumable.
   * @param db - A connection of its own, outside any transaction: the switch holds the write lock.
   * @param options - Threads, step size, cancellation and progress.
   * @returns What was done.
   */
  static rebuild(
    db: DatabaseSync,
    options: RebuildOptions = {},
  ): Promise<RebuildResult> {
    return rebuildStore(db, options);
  }

  /**
   * Stops a rebuild under way and throws away what it built: the writes stop logging.
   * @param db - The application's connection, outside any transaction.
   * @returns Once what it built is freed.
   */
  static abandonRebuild(db: DatabaseSync): Promise<void> {
    return abandonRebuild(db);
  }

  /**
   * How many stored molecules hold each FragFp, screen and function key, kept exact by every
   * commit and removal. A fingerprint whose bits were counted under other keys reads null until
   * {@link MoleculeStore.rebuild} counts them again.
   * @returns The counts, in key order.
   */
  bitCounts(): BitCounts {
    return readBitCounts(this.db, readMeta(this.db), this.#signatures);
  }

  /**
   * Computes, in worker threads, everything the store holds about each molecule. Nothing is
   * written: pass the batch to {@link MoleculeStore.commit}.
   * @param idCodes - The molecules, as idCodes.
   * @returns The batch, one entry per idCode, in order; a molecule that cannot be stored carries
   * an `error`.
   */
  async prepare(idCodes: readonly string[]): Promise<PreparedBatch> {
    const columns = await this.pool.records(idCodes);
    const batch = preparedBatch(idCodes, columns);
    this.#batches.set(batch, columns);
    return batch;
  }

  /**
   * Writes a prepared batch, inside the caller's transaction, so the application's rows and the
   * library's land together. Rewrites only the open tile of each cell touched.
   * @param batch - A batch {@link MoleculeStore.prepare} made.
   * @returns Per molecule of the batch, its id and whether it is new; undefined where the molecule
   * carries an error.
   */
  commit(batch: PreparedBatch): Array<CommitResult | undefined> {
    const columns = this.#batches.get(batch);
    if (columns === undefined) {
      throw new Error('commit() takes a batch prepared by this store');
    }
    return commitRecords(this.db, this.#write, columns, () => this.#writable());
  }

  /**
   * The ids of molecules the store holds, by idCode (canonical or not).
   * @param idCodes - The molecules.
   * @returns Per idCode, the id, or undefined when the store does not hold it.
   */
  find(idCodes: readonly string[]): Promise<Array<number | undefined>> {
    return findIds(this.pool, idCodes, this.#find);
  }

  /**
   * Reads ahead, with the readers, the index pages a commit of the batch will write, and runs
   * each of the application's reads once per key, so that the commit finds those pages in the
   * operating system's cache rather than waiting on the disk. Nothing is returned, and without
   * readers nothing is read.
   * @param batch - A batch {@link MoleculeStore.prepare} made.
   * @param reads - Statements of the application's, each run once per key.
   * @returns Once read.
   */
  prefetch(
    batch: PreparedBatch,
    reads: readonly PrefetchRead[] = [],
  ): Promise<void> {
    return prefetchBatch(this.#find.readers, this.#batches.get(batch), reads);
  }

  /**
   * Removes molecules (an administrative clean-up), inside the caller's transaction. Their seqs are
   * never reused. Remove the application's rows first, so its change log tells the index.
   * @param ids - The ids.
   * @returns How many were removed.
   */
  remove(ids: readonly number[]): number {
    return removeMolecules(this.db, ids, () => this.#writable());
  }

  /**
   * Refuses a write the file cannot take now.
   * @returns What the write keeps and logs besides its own rows.
   */
  #writable(): WriteCheck {
    return checkWritable(this.db, this.#state, this.stamp, this.#signatures);
  }

  /**
   * Stops the worker threads. The connection stays the caller's.
   * @returns Once they are stopped.
   */
  async close(): Promise<void> {
    await Promise.all([this.pool.close(), this.#find.readers?.close()]);
  }
}
