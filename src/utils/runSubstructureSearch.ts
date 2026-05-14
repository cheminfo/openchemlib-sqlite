import type * as OpenChemLib from 'openchemlib';

import type { SQLiteDatabase, SearchResponse, SearchResult } from '../types.ts';

import { buildSSPrefilter } from './buildSSPrefilter.ts';
import { unpackSSIndex } from './packSSIndex.ts';
import { rowToResult } from './searchHelpers.ts';

type OCLLibrary = typeof OpenChemLib;
type OCLMolecule = InstanceType<OCLLibrary['Molecule']>;

export interface SubstructureSearchParams {
  db: SQLiteDatabase;
  ocl: OCLLibrary;
  entriesTable: string;
  selectCols: string;
  ssIndexCols: string;
  ssJoin: string;
  mwColumn: string | null;
  /** Fragment flag must already be set to true before passing. */
  mol: OCLMolecule;
  from: number;
  limit: number;
  timeoutMs: number;
}

function sortByMassDiff(
  results: SearchResult[],
  queryMw: number,
): SearchResult[] {
  return results.toSorted(
    (a, b) => Math.abs((a.mw ?? 0) - queryMw) - Math.abs((b.mw ?? 0) - queryMw),
  );
}

/**
 * Run a substructure search against the OCL index table.
 * Results are sorted by ascending |queryMw − resultMw| when mwColumn is configured.
 * @param params - Search parameters; params.mol.fragment must already be set to true.
 * @returns Search response.
 */
export function runSubstructureSearch(
  params: SubstructureSearchParams,
): SearchResponse {
  const {
    db,
    ocl,
    entriesTable,
    selectCols,
    ssIndexCols,
    ssJoin,
    mwColumn,
    mol,
    from,
    limit,
    timeoutMs,
  } = params;
  const { Molecule, SSSearcherWithIndex } = ocl;
  const mwSelectCol = mwColumn ? `, e.${mwColumn} AS mw` : '';

  // Optimization: empty fragment matches every molecule — skip fingerprint prefilter and OCL check.
  if (mol.getAllAtoms() === 0) {
    const stmt = db.prepare(
      `SELECT ${selectCols}${mwSelectCol} FROM ${entriesTable} e ${ssJoin}`,
    );
    const allRows = stmt.all() as Array<Record<string, unknown>>;
    return {
      results: allRows.slice(from, from + limit).map(rowToResult),
      total: allRows.length,
      screened: allRows.length,
      partial: false,
    };
  }

  // mol has fragment=true; getMolecularFormula needs fragment=false — use a temporary copy.
  let queryMw = 0;
  if (mwColumn) {
    const mwMol = mol.getCompactCopy();
    mwMol.setFragment(false);
    queryMw = mwMol.getMolecularFormula().relativeWeight;
  }

  const queryIndex = mol.getIndex();
  const prefilter = buildSSPrefilter(queryIndex);
  const stmt = db.prepare(
    `SELECT ${selectCols}${mwSelectCol}, ${ssIndexCols} FROM ${entriesTable} e ${ssJoin} WHERE ${prefilter.sql}`,
  );
  stmt.setReadBigInts?.(true);
  const candidates = stmt.all(...prefilter.params) as Array<
    Record<string, unknown>
  >;

  const searcher = new SSSearcherWithIndex();
  searcher.setFragment(mol, queryIndex);
  const deadline = Date.now() + timeoutMs;
  const results: SearchResult[] = [];
  let partial = false;
  let screened = candidates.length;

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i];
    if (!row) continue;
    const targetIndex = unpackSSIndex(row);
    const targetMol = Molecule.fromIDCode(row.id_code as string);
    searcher.setMolecule(targetMol, targetIndex);
    if (searcher.isFragmentInMolecule()) results.push(rowToResult(row));
    if (i % 500 === 499 && Date.now() > deadline) {
      partial = true;
      screened = i + 1;
      break;
    }
  }

  const sorted = mwColumn ? sortByMassDiff(results, queryMw) : results;
  return {
    results: sorted.slice(from, from + limit),
    total: sorted.length,
    screened,
    partial,
  };
}
