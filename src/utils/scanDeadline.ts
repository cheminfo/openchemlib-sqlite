import type { SQLiteDatabase } from '../types.ts';

/** The SQL function a scan calls to learn that its time is up. */
const DEADLINE_FUNCTION = 'ocl_ss_deadline';

/**
 * Which rows skip the clock, as a mask on the entry id: one row in 1024 calls
 * into JavaScript, so the guard costs a few nanoseconds a row rather than a
 * function call.
 */
const SKIP_MASK = 1023;

const MESSAGE = 'the scan ran past its deadline';

/**
 * Thrown from inside SQLite when a scan runs past its deadline. Raising it is
 * what aborts the statement: a step that reads millions of rows and yields
 * none never returns to the loop that would otherwise look at the clock.
 */
export class ScanDeadlineError extends Error {
  constructor() {
    super(MESSAGE);
    this.name = 'ScanDeadlineError';
  }
}

/** Where a scan stood when its guard stopped it: the row it was testing. */
export interface GuardPosition {
  /** The row's weight. */
  mw: number;
  /** The row's entry id. */
  entryId: number;
}

const installed = new WeakSet<SQLiteDatabase>();

/** The row each stopped scan was testing, by the key its statement binds. */
const stoppedAt = new Map<number, GuardPosition>();

let nextKey = 1;

/**
 * Register the deadline function on a connection, once.
 *
 * `node:sqlite` has no way to interrupt a running statement, and a scan whose
 * rows all fail the prefilter or the candidates test stays inside one step for
 * as long as the table is long. The function is the interruption: it reads the
 * clock from within that step and throws once the deadline has passed. Before
 * throwing it records the row it was called for, so a scan stopped on purpose
 * — at a checkpoint rather than at its deadline — can carry on from that row
 * without reading again what it had already read.
 * @param db - The connection the scans run on.
 * @returns Whether the driver could take it; without it scans are unguarded.
 */
export function installScanDeadline(db: SQLiteDatabase): boolean {
  if (installed.has(db)) return true;
  if (typeof db.function !== 'function') return false;
  db.function(
    DEADLINE_FUNCTION,
    { deterministic: false, varargs: true },
    (deadline, key, mw, entryId) => {
      if (Date.now() <= Number(deadline)) return 1;
      if (key !== undefined) {
        stoppedAt.set(Number(key), {
          mw: Number(mw),
          entryId: Number(entryId),
        });
      }
      throw new ScanDeadlineError();
    },
  );
  installed.add(db);
  return true;
}

/**
 * A key for one execution of a guarded statement, under which its guard
 * records where it stopped.
 * @returns The key.
 */
export function newGuardKey(): number {
  return nextKey++;
}

/**
 * Where the guard of a statement stopped it, forgotten once read.
 * @param key - The key the statement bound.
 * @returns The row it was testing, or undefined when it did not stop it.
 */
export function takeGuardPosition(key: number): GuardPosition | undefined {
  const position = stoppedAt.get(key);
  stoppedAt.delete(key);
  return position;
}

/**
 * The condition that aborts a scan at its deadline, which binds the deadline
 * (in ms since the epoch) as one anonymous parameter, and the key the guard
 * records its position under as a second one when the row's position is
 * given.
 *
 * It must come before every condition that rejects most rows on its own:
 * SQLite tests the terms in the order they are written, so a guard placed
 * after them is only reached by the rows they let through. A scan may place
 * it after a selective one on purpose, reading the clock on a larger share of
 * the fewer rows that reach it — see `measurePrefilterPlan()`.
 * @param entryIdColumn - The entry id of the row being read, e.g. `s.entry_id`.
 * @param mwColumn - The weight of the row being read, e.g. `s.mw`, when the
 *   guard should record where it stopped.
 * @param mask - The clock is read for the rows whose entry id has these bits
 *   all clear: 1023 reads it for one row in 1024, 0 for every row.
 * @returns The SQL condition.
 */
export function scanDeadlineGuard(
  entryIdColumn: string,
  mwColumn?: string,
  mask: number = SKIP_MASK,
): string {
  const call =
    mwColumn === undefined
      ? `${DEADLINE_FUNCTION}(?)`
      : `${DEADLINE_FUNCTION}(?, ?, ${mwColumn}, ${entryIdColumn})`;
  return mask === 0 ? call : `((${entryIdColumn} & ${mask}) <> 0 OR ${call})`;
}

/**
 * Whether an error is the deadline guard aborting a scan.
 *
 * The message is checked as well as the class, because a driver may hand back
 * a copy of the error the function threw rather than the error itself.
 * @param error - What the statement threw.
 * @returns True when the scan merely ran out of time.
 */
export function isScanDeadline(error: unknown): boolean {
  return (
    error instanceof ScanDeadlineError ||
    (error instanceof Error && error.message.includes(MESSAGE))
  );
}
