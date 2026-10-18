import type { DatabaseSync } from 'node:sqlite';

import type { ChemistryPool } from './chemistryPool.ts';
import type { HashKind, IdentityStatements, MoleculeKeys } from './identity.ts';
import {
  groupIds,
  idsByHashes,
  prepareIdentityStatements,
  readKeys,
} from './identity.ts';
import type { DistinctHashes } from './schema.ts';
import { readMeta } from './schema.ts';
import type { GroupOptions } from './storeOptions.ts';

/**
 * The reads of a store that its identity statements answer: the stored stereoisomers and
 * tautomers of a molecule, the ids of hashes, the keys of ids and the counts `ocl_meta` keeps.
 */
export class StoreReads {
  /** The application's connection. */
  protected readonly db: DatabaseSync;
  /** The chemistry workers. */
  protected readonly pool: ChemistryPool;
  /** The identity statements of the connection. */
  protected readonly identity: IdentityStatements;

  /**
   * Prepares the identity statements on the connection.
   * @param db - The application's connection.
   * @param pool - The chemistry workers.
   */
  protected constructor(db: DatabaseSync, pool: ChemistryPool) {
    this.db = db;
    this.pool = pool;
    this.identity = prepareIdentityStatements(db);
  }

  /**
   * The stored stereoisomers of a molecule (the same no-stereo hash), in id order.
   * @param idCode - The molecule.
   * @param options - Paging.
   * @returns Their ids.
   */
  async stereoisomers(
    idCode: string,
    options: GroupOptions = {},
  ): Promise<number[]> {
    const [hash] = await this.pool.noStereo([idCode]);
    return groupIds(this.identity, 'noStereo', hash as bigint, options);
  }

  /**
   * The stored tautomers and stereoisomers of a molecule (the same tautomer hash), in id order.
   * @param idCode - The molecule.
   * @param options - Paging.
   * @returns Their ids.
   */
  async tautomers(
    idCode: string,
    options: GroupOptions = {},
  ): Promise<number[]> {
    const { tautomerHashes } = await this.pool.identity([idCode]);
    const hash = tautomerHashes[0] as bigint;
    return groupIds(this.identity, 'tautomer', hash, options);
  }

  /**
   * The ids holding each hash. A hash only finds: a wrong one misses.
   * @param kind - Which hash.
   * @param hashes - The hashes.
   * @returns One id list per hash, in id order.
   */
  byHashes(kind: HashKind, hashes: readonly bigint[]): number[][] {
    return idsByHashes(this.identity, kind, hashes);
  }

  /**
   * The identity of stored molecules.
   * @param ids - The ids.
   * @returns The keys of those the store holds.
   */
  keys(ids: readonly number[]): Map<number, MoleculeKeys> {
    return readKeys(this.identity, ids);
  }

  /**
   * How many molecules the store holds.
   * @returns The count `ocl_meta` keeps.
   */
  count(): number {
    return readMeta(this.db).count;
  }

  /**
   * The last seq issued.
   * @returns It; every id committed so far has a seq at most this.
   */
  lastSeq(): number {
    return readMeta(this.db).seq;
  }

  /**
   * How many distinct identity hashes the stored molecules carry, kept exact by every commit and
   * removal: what `count(DISTINCT …)` over `ocl_molecule` answers, without reading it.
   * @returns The distinct no-stereo hashes (compounds) and tautomer hashes (tautomer families).
   */
  distinctHashes(): DistinctHashes {
    const meta = readMeta(this.db);
    return { noStereo: meta.distinctNoStereo, tautomer: meta.distinctTautomer };
  }
}
