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
  mwColumn: string | null;
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
  /** Restrict to entries whose pk is in the half-open range [lo, hi). */
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
 * The fingerprint prescreen scans the narrow `ocl_ss_index` table alone
 * (covering — no join to the wide entries table) and is consumed as a lazy
 * stream: for each candidate the idCode is fetched on demand, parsed, and
 * matched, and the scan stops as soon as `maxResults` confirmed matches are
 * collected (or the timeout / `maxCandidates` cap is hit). For a common
 * substructure this reads only a small prefix of the table instead of screening
 * every candidate. Results are sorted by ascending |queryMw − resultMw| when
 * mwColumn is configured.
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
    mwColumn,
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
  const mwSelectCol = mwColumn ? `, e.${mwColumn} AS mw` : '';
  // Partitioned scan: only entries whose pk falls in this worker's range. The
  // ocl_ss_index PK is entry_id, so a range is sargable and each worker reads
  // only its slice. Bounds are trusted integers (set by the pool); coerced.
  const rangeCond = partition
    ? ` AND s.entry_id >= ${Math.trunc(partition.lo)} AND s.entry_id < ${Math.trunc(partition.hi)}`
    : '';
  const rangeWhere = partition
    ? ` WHERE s.entry_id >= ${Math.trunc(partition.lo)} AND s.entry_id < ${Math.trunc(partition.hi)}`
    : '';

  // Fetch idCode (+ mw) for one candidate by primary key — an indexed lookup
  // paid only for candidates actually tested, not for every scanned row.
  const fetchStmt = db.prepare(
    `SELECT e.${idCodeColumn} AS id_code${mwSelectCol} FROM ${entriesTable} e WHERE e.${pkColumn} = ?`,
  );

  const start = Date.now();
  const results: SearchResult[] = [];
  let screened = 0;
  let partial = false;
  const deadline = Date.now() + timeoutMs;

  // Empty fragment matches every molecule — skip the fingerprint prefilter and
  // OCL check; just collect entries up to maxResults.
  if (mol.getAllAtoms() === 0) {
    const scanStmt = db.prepare(
      `SELECT s.entry_id FROM ocl_ss_index s${rangeWhere}`,
    );
    scanStmt.setReadBigInts?.(true);
    for (const row of streamRows(scanStmt, [])) {
      screened++;
      const entryId = Number(row.entry_id);
      const entry = fetchStmt.get(entryId) as Record<string, unknown>;
      const result: SearchResult = {
        entryId,
        idCode: entry.id_code as string,
      };
      if (entry.mw != null) result.mw = entry.mw as number;
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
  if (mwColumn) {
    const mwMol = mol.getCompactCopy();
    mwMol.setFragment(false);
    queryMw = mwMol.getMolecularFormula().relativeWeight;
  }

  const queryIndex = mol.getIndex();
  const prefilter = buildSSPrefilter(queryIndex);
  const scanStmt = db.prepare(
    `SELECT s.entry_id, ${ssIndexCols} FROM ocl_ss_index s WHERE ${prefilter.sql}${rangeCond}`,
  );
  scanStmt.setReadBigInts?.(true);

  const searcher = new SSSearcherWithIndex();
  searcher.setFragment(mol, queryIndex);

  for (const row of streamRows(scanStmt, prefilter.params)) {
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
      if (entry.mw != null) result.mw = entry.mw as number;
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

  const sorted = mwColumn ? sortByMassDiff(results, queryMw) : results;
  return {
    results: sorted.slice(from, from + limit),
    total: sorted.length,
    screened,
    matched: results.length,
    elapsedMs: Date.now() - start,
    partial,
  };
}
