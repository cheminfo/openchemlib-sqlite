import type * as OpenChemLib from 'openchemlib';

import type {
  SQLiteDatabase,
  SQLiteStatement,
  SearchResponse,
  SearchResult,
} from '../types.ts';

import { buildSSPrefilter } from './buildSSPrefilter.ts';
import { unpackSSIndex } from './packSSIndex.ts';

type OCLLibrary = typeof OpenChemLib;
type OCLMolecule = InstanceType<OCLLibrary['Molecule']>;

export interface SubstructureSearchParams {
  db: SQLiteDatabase;
  ocl: OCLLibrary;
  entriesTable: string;
  ssIndexCols: string;
  /** Primary-key column of the entries table. */
  pkColumn: string;
  /** idCode column of the entries table (fetched lazily per tested candidate). */
  idCodeColumn: string;
  /** Fragment flag must already be set to true before passing. */
  mol: OCLMolecule;
  from: number;
  limit: number;
  timeoutMs: number;
  maxCandidates: number;
  maxResults: number;
  onProgress?: (processed: number, total: number) => void;
  /**
   * Restrict to entries whose molecular weight is in the half-open range
   * `[lo, hi)`. Used to partition a parallel scan into contiguous mw bands
   * (sargable on the clustered ocl_ss_index primary key).
   */
  partition?: { lo: number; hi: number };
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
 * Stream rows lazily when the driver supports it, else fall back to all().
 * Lazy iteration lets the scan stop early (mid-table) once enough matches are
 * found, instead of materialising every candidate row up front.
 * @param stmt - Prepared statement to run.
 * @param params - Bound parameters for the statement.
 * @returns An iterable of result rows.
 */
function streamRows(
  stmt: SQLiteStatement,
  params: unknown[],
): Iterable<Record<string, unknown>> {
  if (stmt.iterate) {
    return stmt.iterate(...params) as Iterable<Record<string, unknown>>;
  }
  return stmt.all(...params) as Array<Record<string, unknown>>;
}

/**
 * Run a substructure search against the OCL index table.
 *
 * `ocl_ss_index` is clustered by molecular weight, so the fingerprint prescreen
 * scans it in ascending-mw order and is consumed as a lazy stream: for each
 * candidate the idCode is fetched on demand, parsed, and matched, and the scan
 * stops as soon as `maxResults` confirmed matches are collected (or the timeout
 * / `maxCandidates` cap is hit). Because the lightest molecules are visited
 * first, an early-stopped partial result holds the smallest superstructures —
 * the matches closest to the query. `mw` is read straight from the index (no
 * join), and results are returned ordered by ascending |queryMw − resultMw|.
 * @param params - Search parameters; params.mol.fragment must already be set to true.
 * @returns Search response, including `screened`, `matched`, and `elapsedMs`.
 */
export function runSubstructureSearch(
  params: SubstructureSearchParams,
): SearchResponse {
  const {
    db,
    ocl,
    entriesTable,
    ssIndexCols,
    pkColumn,
    idCodeColumn,
    mol,
    from,
    limit,
    timeoutMs,
    maxCandidates,
    maxResults,
    onProgress,
    partition,
  } = params;
  const { Molecule, SSSearcherWithIndex } = ocl;

  // mw band for this worker; sargable on the clustered (mw, entry_id) PK.
  const mwBound = partition ? ' s.mw >= ? AND s.mw < ?' : '';
  const mwParams = partition ? [partition.lo, partition.hi] : [];

  // Fetch idCode for one candidate by primary key — an indexed lookup paid only
  // for candidates actually tested. mw comes from the index scan, not here.
  const fetchStmt = db.prepare(
    `SELECT e.${idCodeColumn} AS id_code FROM ${entriesTable} e WHERE e.${pkColumn} = ?`,
  );

  const start = Date.now();
  const results: SearchResult[] = [];
  let screened = 0;
  let partial = false;
  const deadline = Date.now() + timeoutMs;

  // Empty fragment matches every molecule — skip the fingerprint prefilter and
  // OCL check; just collect the lightest entries up to maxResults.
  if (mol.getAllAtoms() === 0) {
    const where = partition ? ` WHERE${mwBound}` : '';
    const scanStmt = db.prepare(
      `SELECT s.entry_id, s.mw FROM ocl_ss_index s${where}`,
    );
    scanStmt.setReadBigInts?.(true);
    for (const row of streamRows(scanStmt, mwParams)) {
      screened++;
      const entryId = Number(row.entry_id);
      const entry = fetchStmt.get(entryId) as Record<string, unknown>;
      const result: SearchResult = {
        entryId,
        idCode: entry.id_code as string,
      };
      if (row.mw != null) result.mw = Number(row.mw);
      results.push(result);
      if (results.length >= maxResults) {
        partial = true;
        break;
      }
    }
    onProgress?.(screened, screened);
    return {
      results: results.slice(from, from + limit),
      total: results.length,
      screened,
      matched: results.length,
      elapsedMs: Date.now() - start,
      partial,
    };
  }

  // mol has fragment=true; getMolecularFormula needs fragment=false — use a copy.
  let queryMw = 0;
  try {
    const mwMol = mol.getCompactCopy();
    mwMol.setFragment(false);
    queryMw = mwMol.getMolecularFormula().relativeWeight;
  } catch {
    // query with no computable formula — mass ordering falls back to mw asc
  }

  const queryIndex = mol.getIndex();
  const prefilter = buildSSPrefilter(queryIndex);
  const rangeCond = partition ? ` AND${mwBound}` : '';
  const scanStmt = db.prepare(
    `SELECT s.entry_id, s.mw, ${ssIndexCols} FROM ocl_ss_index s WHERE ${prefilter.sql}${rangeCond}`,
  );
  scanStmt.setReadBigInts?.(true);

  const searcher = new SSSearcherWithIndex();
  searcher.setFragment(mol, queryIndex);

  for (const row of streamRows(scanStmt, [...prefilter.params, ...mwParams])) {
    if (screened >= maxCandidates) {
      partial = true;
      break;
    }
    screened++;
    const entryId = Number(row.entry_id);
    const targetIndex = unpackSSIndex(row);
    const entry = fetchStmt.get(entryId) as Record<string, unknown>;
    // Skip 2D-coordinate invention: it is the dominant cost when parsing every
    // candidate and substructure matching only needs the atom/bond graph.
    const targetMol = Molecule.fromIDCode(entry.id_code as string, false);
    searcher.setMolecule(targetMol, targetIndex);
    if (searcher.isFragmentInMolecule()) {
      const result: SearchResult = { entryId, idCode: entry.id_code as string };
      if (row.mw != null) result.mw = Number(row.mw);
      results.push(result);
      if (results.length >= maxResults) {
        partial = true;
        break;
      }
    }
    if (screened % 500 === 0) {
      onProgress?.(screened, screened);
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
    }
  }
  onProgress?.(screened, screened);

  const sorted = sortByMassDiff(results, queryMw);
  return {
    results: sorted.slice(from, from + limit),
    total: sorted.length,
    screened,
    matched: results.length,
    elapsedMs: Date.now() - start,
    partial,
  };
}
