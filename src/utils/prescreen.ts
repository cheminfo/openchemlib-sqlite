import type * as OpenChemLib from 'openchemlib';

import type {
  SQLiteDatabase,
  SQLiteStatement,
  SearchCandidates,
} from '../types.ts';

import { buildSSPrefilter } from './buildSSPrefilter.ts';

type OCLLibrary = typeof OpenChemLib;
type OCLMolecule = InstanceType<OCLLibrary['Molecule']>;

/** One candidate that passed the fingerprint prefilter. */
export interface PrescreenedCandidate {
  entryId: number;
  idCode: string;
  mw: number;
}

export interface PrescreenParams {
  db: SQLiteDatabase;
  entriesTable: string;
  /** Primary-key column of the entries table. */
  pkColumn: string;
  /** idCode column of the entries table. */
  idCodeColumn: string;
  /** Fragment flag must already be set to true before passing. */
  mol: OCLMolecule;
  timeoutMs: number;
  maxCandidates: number;
  onProgress?: (processed: number, total: number) => void;
  /** Restrict the prescreen to the entries returned by this subquery. */
  candidates?: SearchCandidates;
}

/** Mutable counters the prescreen reports back to its caller. */
export interface PrescreenState {
  /** Candidates yielded so far. */
  screened: number;
  /** True when the prescreen stopped on the timeout or `maxCandidates`. */
  partial: boolean;
}

/**
 * Build the prescreen query and its bound parameters.
 *
 * Exported so a test can assert the plan SQLite picks for it: the whole design
 * rests on `ocl_ss_index` being the driving table, which is what makes the scan
 * follow the index's physical (mw, entry_id) order and stream.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @returns The SQL and the parameters to bind, in order.
 */
export function buildPrescreenSql(
  params: Pick<
    PrescreenParams,
    'entriesTable' | 'pkColumn' | 'idCodeColumn' | 'mol' | 'candidates'
  >,
): { sql: string; params: unknown[] } {
  const { entriesTable, pkColumn, idCodeColumn, mol, candidates } = params;

  const select = `SELECT s.entry_id, s.mw, e.${idCodeColumn} AS id_code
     FROM ocl_ss_index s
     JOIN ${entriesTable} e ON e.${pkColumn} = s.entry_id`;

  // A candidates subquery is a plain membership test on the single prescreen.
  //
  // The unary `+` is what keeps this streamable. Without it SQLite drives the
  // scan off the subquery — it is the smaller side and has no statistics — which
  // abandons the index's physical (mw, entry_id) order, forcing a temp b-tree to
  // sort it back and materialising every candidate before yielding the first row.
  // `+` marks the term unusable by an index, so ocl_ss_index stays the driving
  // table: it is scanned in mw order, the subquery is materialised once into a
  // list (plus a bloom filter) and merely probed, and the rows come out
  // lightest-first as a true stream that stops the moment we have enough.
  //
  // The ORDER BY is a safety net, not a sort: the clustered scan already
  // satisfies it, so SQLite optimises it away. Should it ever pick a different
  // plan, the ORDER BY keeps the result correct (just slower) rather than
  // silently returning candidates in the wrong order.
  const restrict = candidates ? ` AND +s.entry_id IN (${candidates.sql})` : '';
  const order = candidates ? ' ORDER BY s.mw' : '';
  const candidateParams = candidates?.params ? [candidates.params] : [];

  // An empty fragment is contained in every molecule: skip the prefilter (and,
  // in the caller, the verification) and just stream the lightest entries.
  const isEmptyFragment = mol.getAllAtoms() === 0;
  const prefilter = isEmptyFragment
    ? { sql: '', params: [] as bigint[] }
    : buildSSPrefilter(mol.getIndex());
  const where = isEmptyFragment
    ? restrict
      ? ` WHERE ${restrict.slice(5)}`
      : ''
    : ` WHERE ${prefilter.sql}${restrict}`;

  return {
    sql: `${select}${where}${order}`,
    params: [...candidateParams, ...prefilter.params],
  };
}

/**
 * Stream rows lazily when the driver supports it, else fall back to all().
 * Lazy iteration lets the caller stop early (mid-table) once it has enough
 * matches, instead of materialising every candidate row up front.
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
 * Yield every entry whose stored fingerprint is a superset of the query's,
 * **lightest first**, as a lazy stream.
 *
 * This is step 1 of a substructure search — roughly 3% of its cost. It is a
 * single query on a single connection: `ocl_ss_index` is clustered by molecular
 * weight, so scanning it in primary-key order both applies the bitmask prefilter
 * and produces candidates in ascending mw with no sort. The caller can therefore
 * stop consuming as soon as it has enough confirmed matches and be sure it kept
 * the smallest superstructures — the ones closest to the query.
 *
 * The entries table is joined (rather than read per candidate) because every
 * yielded candidate needs its idCode: verification happens elsewhere and takes
 * only the idCode. The fingerprint columns are deliberately **not** selected —
 * SQLite applies the bitmask internally and nothing downstream needs it, which
 * keeps the row narrow.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param state - Mutable counters updated as the stream is consumed.
 * @yields {PrescreenedCandidate} Each prescreened candidate, in ascending molecular weight.
 */
export function* prescreen(
  params: PrescreenParams,
  state: PrescreenState,
): Generator<PrescreenedCandidate> {
  const { db, timeoutMs, maxCandidates, onProgress } = params;

  const query = buildPrescreenSql(params);
  const stmt = db.prepare(query.sql);

  const deadline = Date.now() + timeoutMs;
  for (const row of streamRows(stmt, query.params)) {
    if (state.screened >= maxCandidates) {
      state.partial = true;
      return;
    }
    state.screened++;
    yield {
      entryId: Number(row.entry_id),
      idCode: row.id_code as string,
      mw: Number(row.mw),
    };
    if (state.screened % 500 === 0) {
      onProgress?.(state.screened, state.screened);
      if (Date.now() > deadline) {
        state.partial = true;
        return;
      }
    }
  }
}
