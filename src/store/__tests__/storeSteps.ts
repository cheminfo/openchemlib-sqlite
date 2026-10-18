import type { DatabaseSync } from 'node:sqlite';

import type { MoleculeStore } from '../MoleculeStore.ts';
import type { DistinctHashes } from '../schema.ts';

/**
 * Prepares and commits molecules in one transaction.
 * @param store - The store.
 * @param db - Its connection.
 * @param idCodes - The molecules.
 * @param end - How the transaction ends.
 * @returns The id of each and whether it was created; undefined for a molecule with an error.
 */
export async function commitSteps(
  store: MoleculeStore,
  db: DatabaseSync,
  idCodes: readonly string[],
  end: 'COMMIT' | 'ROLLBACK' = 'COMMIT',
): Promise<Array<[number, boolean] | undefined>> {
  const batch = await store.prepare(idCodes);
  db.exec('BEGIN IMMEDIATE');
  const results = store.commit(batch);
  db.exec(end);
  return results.map((result) =>
    result === undefined ? undefined : [result.id, result.created],
  );
}

/**
 * Prepares and commits molecules in one transaction.
 * @param store - The store.
 * @param db - Its connection.
 * @param idCodes - The molecules, none with an error.
 * @returns The id of each.
 */
export async function commitIds(
  store: MoleculeStore,
  db: DatabaseSync,
  idCodes: readonly string[],
): Promise<number[]> {
  const results = await commitSteps(store, db, idCodes);
  return results.map((result) => result?.[0] as number);
}

/**
 * Removes molecules in one transaction.
 * @param store - The store.
 * @param db - Its connection.
 * @param ids - The molecules.
 */
export function removeIds(
  store: MoleculeStore,
  db: DatabaseSync,
  ids: readonly number[],
): void {
  db.exec('BEGIN IMMEDIATE');
  store.remove(ids);
  db.exec('COMMIT');
}

/**
 * What `count(DISTINCT …)` over the stored molecules answers.
 * @param db - The connection.
 * @returns The distinct hashes of each kind.
 */
export function countedDistinct(db: DatabaseSync): DistinctHashes {
  const row = db
    .prepare(
      'SELECT count(DISTINCT noStereoHash) AS noStereo, count(DISTINCT tautomerHash) AS tautomer FROM ocl_molecule',
    )
    .get() as { noStereo: number; tautomer: number };
  return { noStereo: row.noStereo, tautomer: row.tautomer };
}
