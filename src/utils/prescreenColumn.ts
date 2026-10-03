import type { SQLiteStatement } from '../types.ts';

import { buildSSPrefilter } from './buildSSPrefilter.ts';
import type {
  PrescreenParams,
  PrescreenState,
  PrescreenedCandidate,
} from './prescreen.ts';
import { indexHasUnknownMw, queryMwBound } from './queryMwBound.ts';
import {
  installScanDeadline,
  isScanDeadline,
  scanDeadlineGuard,
} from './scanDeadline.ts';

/**
 * Build the prescreen query and its bound parameters.
 *
 * Exported so a test can assert the plan SQLite picks for it: the whole design
 * rests on `ocl_ss_index` being the driving table, which is what makes the scan
 * follow the index's physical (mw, entry_id) order and stream. The `drive`
 * strategy is the one exception, and it sorts what it reads instead.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @returns The SQL and the parameters to bind, in order.
 */
export function buildPrescreenSql(
  params: Pick<
    PrescreenParams,
    | 'entriesTable'
    | 'pkColumn'
    | 'idCodeColumn'
    | 'mol'
    | 'candidates'
    | 'mwFloor'
    | 'mwRange'
    | 'after'
    | 'deadline'
    | 'screenTable'
  >,
): { sql: string; params: unknown[] } {
  const {
    entriesTable,
    pkColumn,
    idCodeColumn,
    mol,
    candidates,
    mwFloor,
    mwRange,
    after,
    deadline,
    screenTable = 'ocl_ss_index',
  } = params;
  const strategy = candidates ? (candidates.strategy ?? 'membership') : null;

  // `drive` reads the candidates first and each one's fingerprint through the
  // entry_id index; DISTINCT because a subquery over a link table may name an
  // entry twice, which the other strategies — set tests — never notice.
  const from =
    candidates && strategy === 'drive'
      ? `FROM (SELECT DISTINCT entry_id FROM (${candidates.sql})) c
     CROSS JOIN ${screenTable} s ON s.entry_id = c.entry_id`
      : `FROM ${screenTable} s`;
  const select = `SELECT s.entry_id, s.mw, e.${idCodeColumn} AS id_code
     ${from}
     JOIN ${entriesTable} e ON e.${pkColumn} = s.entry_id`;

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (deadline != null) {
    // First, so that a row every later condition rejects still meets the clock.
    conditions.push(
      scanDeadlineGuard(strategy === 'drive' ? 'c.entry_id' : 's.entry_id'),
    );
    values.push(deadline);
  }
  // An empty fragment is contained in every molecule: skip the prefilter (and,
  // in the caller, the verification) and just stream the lightest entries.
  if (mol.getAllAtoms() > 0) {
    const prefilter = buildSSPrefilter(mol.getIndex());
    conditions.push(prefilter.sql);
    values.push(...prefilter.params);
  }
  // The index is clustered by weight, so these are the predicates SQLite seeks
  // rather than tests. A superstructure cannot be lighter than its fragment,
  // which starts the scan past every entry too light to match; the caller's
  // range narrows the same seek from both ends.
  const lower = Math.max(
    mwFloor != null && mwFloor > 0 ? mwFloor : Number.NEGATIVE_INFINITY,
    mwRange?.min ?? Number.NEGATIVE_INFINITY,
  );
  if (mwRange?.max !== undefined) {
    conditions.push('s.mw <= ?');
    values.push(mwRange.max);
  }
  if (lower > Number.NEGATIVE_INFINITY) {
    conditions.push('s.mw >= ?');
    values.push(lower);
  }
  if (after !== undefined) {
    // A row value is sought on the clustered key like a bound on its first
    // column, so a resumed scan reads nothing it already read.
    conditions.push('(s.mw, s.entry_id) > (?, ?)');
    values.push(after.mw, after.entryId);
  }
  if (candidates && strategy === 'membership') {
    // The unary `+` is what keeps this streamable. Without it SQLite drives the
    // scan off the subquery — it is the smaller side and has no statistics —
    // which abandons the index's physical (mw, entry_id) order, forcing a temp
    // b-tree to sort it back and materialising every candidate before yielding
    // the first row. `+` marks the term unusable by an index, so ocl_ss_index
    // stays the driving table: it is scanned in mw order, the subquery is
    // materialised once into a list (plus a bloom filter) and merely probed.
    conditions.push(`+s.entry_id IN (${candidates.sql})`);
  } else if (candidates && strategy === 'probe') {
    // Correlated, so nothing is materialised: SQLite flattens the subquery and
    // seeks it on the entry id, once per entry the prefilter let through.
    conditions.push(
      `EXISTS (SELECT 1 FROM (${candidates.sql}) c WHERE c.entry_id = s.entry_id)`,
    );
  }

  // The ORDER BY is a safety net for the streaming strategies, not a sort: the
  // clustered scan already satisfies it, so SQLite optimises it away. Should it
  // ever pick a different plan, the result stays correct (just slower) rather
  // than silently coming back in the wrong order. For `drive` it is the sort.
  let order = '';
  if (strategy === 'drive') order = ' ORDER BY s.mw, s.entry_id';
  else if (strategy !== null) order = ' ORDER BY s.mw';
  const where =
    conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

  return {
    sql: `${select}${where}${order}`,
    // The candidates subquery binds named parameters, so it does not compete
    // for the anonymous `?` slots and its object may come first whatever the
    // order the placeholders appear in.
    params: [...(candidates?.params ? [candidates.params] : []), ...values],
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
export function* prescreenColumn(
  params: PrescreenParams,
  state: PrescreenState,
): Generator<PrescreenedCandidate> {
  const { db, timeoutMs, maxCandidates, onProgress, mol, mwIsMolecularWeight } =
    params;

  // Refused when any entry's weight is unknown, because 0 doubles as the
  // sentinel for that and such an entry may still be a match.
  const mwFloor =
    mwIsMolecularWeight === true && !indexHasUnknownMw(db)
      ? queryMwBound(mol)
      : null;
  const deadline = Date.now() + timeoutMs;
  const query = buildPrescreenSql({
    ...params,
    mwFloor,
    deadline: installScanDeadline(db) ? deadline : null,
  });
  const stmt = db.prepare(query.sql);

  try {
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
          state.timedOut = true;
          return;
        }
      }
    }
  } catch (error: unknown) {
    // The guard stopped a step that was reading without yielding: what was
    // yielded stands, and the scan simply did not get to the rest.
    if (!isScanDeadline(error)) throw error;
    state.partial = true;
    state.timedOut = true;
  }
}
