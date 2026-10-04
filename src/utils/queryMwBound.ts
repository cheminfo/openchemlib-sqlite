import type * as OpenChemLib from 'openchemlib';

import type { SQLiteDatabase } from '../types.ts';

import type { PrescreenParams } from './prescreenTypes.ts';

type OCLMolecule = InstanceType<(typeof OpenChemLib)['Molecule']>;

/**
 * The lightest a superstructure of this fragment can be, or null when no bound
 * can be proved.
 *
 * `ocl_ss_index` is clustered by molecular weight, so a floor on the weight
 * turns the start of the prescreen from a scan into a seek: every entry lighter
 * than the fragment is skipped without being read.
 *
 * The bound is sound because a fragment's `getMolecularFormula()` counts **only
 * its heavy atoms** — benzene reads `C6`, 72.07, not `C6H6`, 78.11 — and a match
 * maps every one of those heavy atoms onto a heavy atom of the same element in
 * the molecule. Whatever else the molecule carries, including the hydrogens the
 * fragment's formula left out, only adds mass.
 *
 * It is refused for a fragment carrying any query feature. An atom list or a
 * wildcard lets a heavy atom match a lighter element than the formula assumed,
 * and an exclude group puts atoms in the fragment's formula that a match must
 * **not** have — either way the floor would be too high and real matches would
 * be dropped. `removeQueryFeatures()` on a throwaway copy reports all of them,
 * including the exclude-group flag that `getAtomQueryFeaturesObject()` does not
 * expose.
 * @param mol - The query fragment; its fragment flag must already be set.
 * @returns The weight floor in daltons, or null when there is no sound bound.
 */
export function queryMwBound(mol: OCLMolecule): number | null {
  if (mol.getAllAtoms() === 0) return null;
  if (mol.getCompactCopy().removeQueryFeatures()) return null;
  const weight = mol.getMolecularFormula().relativeWeight;
  return weight > 0 ? weight : null;
}

/**
 * Whether the index holds an entry whose molecular weight is not known.
 *
 * `insert()` stores `COALESCE(mwColumn, 0)`, and a migration carries an entry
 * whose idCode will not parse at weight 0, so 0 means "unknown" as much as it
 * means "weightless". Such an entry would be dropped by a weight floor although
 * it may well be a match, so finding one disables the bound altogether rather
 * than widening the predicate: an `OR s.mw = 0` would cost the single range the
 * streaming, mw-ordered plan depends on.
 *
 * Cheap whatever the table's size — weight 0 sorts first in a table clustered by
 * `(mw, entry_id)`, so this is a seek to the first key.
 * @param db - The database to read.
 * @returns True when at least one entry has weight 0.
 */
export function indexHasUnknownMw(db: SQLiteDatabase): boolean {
  const row = db
    .prepare('SELECT 1 AS present FROM ocl_ss_index WHERE mw = 0 LIMIT 1')
    .get();
  return row !== undefined;
}

/**
 * The weight floor a scan may seek to: the one already worked out for it, or
 * the fragment's own when the index's weights are molecular weights and none
 * is unknown.
 *
 * Refused when any entry's weight is unknown, because 0 doubles as the
 * sentinel for that and such an entry may still be a match.
 * @param params - The scan.
 * @returns The floor in daltons, or null when none applies.
 */
export function weightFloor(
  params: Pick<
    PrescreenParams,
    'db' | 'mol' | 'mwFloor' | 'mwIsMolecularWeight'
  >,
): number | null {
  if (params.mwFloor !== undefined) return params.mwFloor;
  return params.mwIsMolecularWeight === true && !indexHasUnknownMw(params.db)
    ? queryMwBound(params.mol)
    : null;
}
