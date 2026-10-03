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

const installed = new WeakSet<SQLiteDatabase>();

/**
 * Register the deadline function on a connection, once.
 *
 * `node:sqlite` has no way to interrupt a running statement, and a scan whose
 * rows all fail the prefilter or the candidates test stays inside one step for
 * as long as the table is long. The function is the interruption: it reads the
 * clock from within that step and throws once the deadline has passed.
 * @param db - The connection the scans run on.
 * @returns Whether the driver could take it; without it scans are unguarded.
 */
export function installScanDeadline(db: SQLiteDatabase): boolean {
  if (installed.has(db)) return true;
  if (typeof db.function !== 'function') return false;
  db.function(DEADLINE_FUNCTION, { deterministic: false }, (deadline) => {
    if (Date.now() > Number(deadline)) throw new ScanDeadlineError();
    return 1;
  });
  installed.add(db);
  return true;
}

/**
 * The condition that aborts a scan at its deadline, which binds the deadline
 * (in ms since the epoch) as one anonymous parameter.
 *
 * It must be the **first** condition of the WHERE clause: SQLite tests the
 * terms in the order they are written, so a guard placed after the prefilter is
 * never reached by the rows the prefilter rejects — which, for a rare
 * fragment, is every row the scan reads.
 * @param entryIdColumn - The entry id of the row being read, e.g. `s.entry_id`.
 * @returns The SQL condition.
 */
export function scanDeadlineGuard(entryIdColumn: string): string {
  return `((${entryIdColumn} & ${SKIP_MASK}) <> 0 OR ${DEADLINE_FUNCTION}(?))`;
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
