import type { SQLiteStatement, ScanPosition } from '../types.ts';

import type { PrefilterPlan, ScanRange } from './prefilterPlan.ts';
import { guessedPrefilterPlan, measurePrefilterPlan } from './prefilterPlan.ts';
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
  takeGuardClockReads,
  takeGuardPosition,
} from './scanDeadline.ts';
import { BEFORE_EVERY_ENTRY } from './searchHelpers.ts';

export { buildPrescreenSql } from './prescreenSql.ts';

/**
 * How long a scan runs on its guessed prefilter before it measures its own
 * rows: past this it is long enough for the ~1 ms a measure costs to pay.
 */
const REPLAN_MS = 30;

/** The most a measure may take: cold, its random reads cost far more. */
const MEASURE_BUDGET_MS = 20;

/** Measures tried, each four times later than the last, before giving up. */
const MEASURE_ATTEMPTS = 3;

/**
 * Rows a scan must have read before it measures: one slow because its index
 * is cold or its verifiers busy has little to gain from a better order.
 */
const MEASURE_MIN_ROWS = 16_384;

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
  const { db, timeoutMs, mol, candidates, measureMinRows } = params;
  const { checkpoint = null } = options;
  const queryIndex = params.queryIndex ?? mol.getIndex();
  const scan = { ...params, queryIndex, mwFloor: weightFloor(params) };
  const deadline = Date.now() + timeoutMs;
  let plan = state.prefilterPlan ?? guessedPrefilterPlan(queryIndex);
  // A scan still running after a few milliseconds is worth measuring: the
  // order of the words and the place of the guard then come from its rows.
  // Not one listing a membership subquery, which a restart would list again,
  // nor a driven one, which reads its candidates rather than the index.
  const restartable =
    candidates === undefined || candidates.strategy === 'probe';
  let replanAt =
    plan.measured ||
    plan.words.length === 0 ||
    mol.getAllAtoms() === 0 ||
    !restartable
      ? null
      : Date.now() + REPLAN_MS;
  let attempts = 0;
  const guarded = installScanDeadline(db);
  const rows = { read: 0 };

  for (;;) {
    const stopAt = Math.min(
      deadline,
      checkpoint ?? Number.POSITIVE_INFINITY,
      replanAt ?? Number.POSITIVE_INFINITY,
    );
    const position = yield* scanUntil(scan, state, plan, stopAt, rows);
    if (position === undefined) return;
    if (Date.now() > deadline) {
      state.partial = true;
      state.timedOut = true;
      return;
    }
    if (checkpoint !== null && Date.now() >= checkpoint) {
      state.checkpoint = position;
      return;
    }
    if (guarded && rows.read < (measureMinRows ?? MEASURE_MIN_ROWS)) {
      replanAt = Date.now() + REPLAN_MS;
      scan.after = position;
      continue;
    }
    const measured = measurePrefilterPlan(
      db,
      queryIndex,
      scanRange(scan, position),
      Date.now() + MEASURE_BUDGET_MS,
    );
    attempts++;
    if (measured === null) {
      replanAt =
        attempts < MEASURE_ATTEMPTS
          ? Date.now() + REPLAN_MS * 4 ** attempts
          : null;
    } else {
      plan = measured;
      state.prefilterPlan = plan;
      replanAt = null;
    }
    scan.after = position;
  }
}

/**
 * Scan until the end, or until a moment, with one prefilter plan.
 * @param params - The scan; `queryIndex` and `mwFloor` already worked out.
 * @param state - Mutable counters updated as the stream is consumed.
 * @param plan - The prefilter plan.
 * @param stopAt - When to stop, in ms since the epoch.
 * @param rows - Counts the rows read, as the guard's clock reads tell them.
 * @param rows.read - The rows read so far.
 * @yields {PrescreenedCandidate} Each prescreened candidate, in ascending molecular weight.
 * @returns Where the scan stood when it stopped at that moment; undefined when
 *   it read every candidate or stopped on `maxCandidates`.
 */
function* scanUntil(
  params: PrescreenParams,
  state: PrescreenState,
  plan: PrefilterPlan,
  stopAt: number,
  rows: { read: number },
): Generator<PrescreenedCandidate, ScanPosition | undefined> {
  const { db, maxCandidates, onProgress, after } = params;
  const guardKey = newGuardKey();
  const query = buildPrescreenSql({
    ...params,
    deadline: installScanDeadline(db) ? stopAt : null,
    guardKey,
    plan,
  });
  const stmt = db.prepare(query.sql);

  let last: ScanPosition | undefined;
  try {
    for (const row of streamRows(stmt, query.params)) {
      if (state.screened >= maxCandidates) {
        state.partial = true;
        return undefined;
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
      if (Date.now() > stopAt) return last;
    }
  } catch (error: unknown) {
    // The guard stopped a step that was reading without yielding: what was
    // yielded stands, and the scan simply did not get to the rest.
    if (!isScanDeadline(error)) throw error;
    const at = takeGuardPosition(guardKey);
    // The row the guard was testing has not been tested yet, so the scan
    // resumes just before it: ids are integers, so nothing lies between.
    return at === undefined
      ? (last ?? after ?? BEFORE_EVERY_ENTRY)
      : { mw: at.mw, entryId: at.entryId - 1 };
  } finally {
    rows.read += takeGuardClockReads(guardKey) * (plan.guardMask + 1);
  }
  return undefined;
}

/**
 * What a scan has still to read, after a position.
 * @param params - The scan, its weight floor worked out.
 * @param after - Where it stands.
 * @returns The range.
 */
function scanRange(params: PrescreenParams, after: ScanPosition): ScanRange {
  const { mwFloor, mwRange } = params;
  const lower = Math.max(
    mwFloor ?? Number.NEGATIVE_INFINITY,
    mwRange?.min ?? Number.NEGATIVE_INFINITY,
  );
  return {
    after,
    ...(lower > Number.NEGATIVE_INFINITY ? { lower } : {}),
    ...(mwRange?.max === undefined ? {} : { upper: mwRange.max }),
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
