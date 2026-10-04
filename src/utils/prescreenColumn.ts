import type { SQLiteStatement, ScanPosition } from '../types.ts';

import { buildPrescreenSql } from './prescreenSql.ts';
import type {
  PrescreenParams,
  PrescreenState,
  PrescreenedCandidate,
} from './prescreenTypes.ts';
import { weightFloor } from './queryMwBound.ts';
import {
  installScanDeadline,
  isScanDeadline,
  newGuardKey,
  takeGuardPosition,
} from './scanDeadline.ts';
import { BEFORE_EVERY_ENTRY } from './searchHelpers.ts';

export { buildPrescreenSql } from './prescreenSql.ts';

/** Where a column scan stops to let its caller reconsider the plan. */
export interface ColumnScanOptions {
  /**
   * When to stop, in ms since the epoch, before the deadline: the scan then
   * records in `state.checkpoint` where it stood, and returns without marking
   * itself partial. Null scans to the deadline.
   * @default null
   */
  checkpoint?: number | null;
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
 *
 * Given a checkpoint, it stops there and says where: at the row the guard was
 * testing, or after the last candidate it yielded. The caller resumes from that
 * position, on this path or on the plane index, and reads nothing twice.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param state - Mutable counters updated as the stream is consumed.
 * @param options - Where to stop early.
 * @yields {PrescreenedCandidate} Each prescreened candidate, in ascending molecular weight.
 */
export function* prescreenColumn(
  params: PrescreenParams,
  state: PrescreenState,
  options: ColumnScanOptions = {},
): Generator<PrescreenedCandidate> {
  const { db, timeoutMs, maxCandidates, onProgress, after } = params;
  const { checkpoint = null } = options;
  const mwFloor = weightFloor(params);
  const deadline = Date.now() + timeoutMs;
  const stopAt =
    checkpoint === null ? deadline : Math.min(checkpoint, deadline);
  const guardKey = newGuardKey();
  const query = buildPrescreenSql({
    ...params,
    mwFloor,
    deadline: installScanDeadline(db) ? stopAt : null,
    guardKey,
  });
  const stmt = db.prepare(query.sql);

  let last: ScanPosition | undefined;
  try {
    for (const row of streamRows(stmt, query.params)) {
      if (state.screened >= maxCandidates) {
        state.partial = true;
        return;
      }
      state.screened++;
      const candidate = {
        entryId: Number(row.entry_id),
        idCode: row.id_code as string,
        mw: Number(row.mw),
      };
      last = { mw: candidate.mw, entryId: candidate.entryId };
      yield candidate;
      if (state.screened % 500 === 0) {
        onProgress?.(state.screened, state.screened);
      }
      if (Date.now() > stopAt) {
        stop(state, deadline, last);
        return;
      }
    }
  } catch (error: unknown) {
    // The guard stopped a step that was reading without yielding: what was
    // yielded stands, and the scan simply did not get to the rest.
    if (!isScanDeadline(error)) throw error;
    const at = takeGuardPosition(guardKey);
    // The row the guard was testing has not been tested yet, so the scan
    // resumes just before it: ids are integers, so nothing lies between.
    stop(
      state,
      deadline,
      at === undefined
        ? (last ?? after ?? BEFORE_EVERY_ENTRY)
        : { mw: at.mw, entryId: at.entryId - 1 },
    );
  }
}

/**
 * Record why a column scan stopped before its end.
 * @param state - The prescreen's counters.
 * @param deadline - When the scan had to stop, in ms since the epoch.
 * @param position - Everything up to here has been read.
 */
function stop(
  state: PrescreenState,
  deadline: number,
  position: ScanPosition,
): void {
  if (Date.now() > deadline) {
    state.partial = true;
    state.timedOut = true;
    return;
  }
  state.checkpoint = position;
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
