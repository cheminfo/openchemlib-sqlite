import type { SQLiteDatabase } from '../types.ts';

import { SLOTS_PER_CHUNK } from './planeLayout.ts';
import { FOLD_TABLE, TAIL_TABLE } from './planeSchema.ts';

/** A position in `(mw, entry_id)` order, the order a fold reads in. */
export interface FoldCursor {
  mw: number;
  entryId: number;
}

/** How far the folds have reached, as {@link FOLD_TABLE} records it. */
export interface FoldState {
  /** Every entry whose id is at most this is folded or in the tail; null before the first fold. */
  foldedThrough: number | null;
  /** The tail trigger copies a fingerprint whose entry id is at most this. */
  tailThrough: number | null;
  /** The last row the fold in progress published, or null when none is in progress. */
  cursor: FoldCursor | null;
  /** The segment the fold in progress extends, or null before its first chunk. */
  segment: number | null;
}

/** Where a fold starts reading: below every real weight. */
export const START_CURSOR: FoldCursor = { mw: -1e308, entryId: 0 };

/**
 * Read how far the folds have reached.
 * @param db - The database to read.
 * @returns The recorded state.
 */
export function readFoldState(db: SQLiteDatabase): FoldState {
  const row = db
    .prepare(
      `SELECT folded_through, tail_through, cursor_mw, cursor_entry_id, segment
         FROM ${FOLD_TABLE} WHERE id = 1`,
    )
    .get() as Record<string, unknown> | undefined;
  return {
    foldedThrough: numberOrNull(row?.folded_through),
    tailThrough: numberOrNull(row?.tail_through),
    cursor:
      row?.cursor_mw == null
        ? null
        : { mw: Number(row.cursor_mw), entryId: Number(row.cursor_entry_id) },
    segment: numberOrNull(row?.segment),
  };
}

/**
 * Start a fold, unless nothing waits for one.
 *
 * The fold covers every entry up to the highest id present now. That bound is
 * written as the tail's before the fold reads a row, in one statement, so an
 * entry inserted while it runs with an id at or below it is copied into the
 * tail — the fold may have read past it already — and one above it is left to
 * the next fold's range.
 * @param db - The database to fold.
 * @returns The state of the fold just started, or null when nothing waits.
 */
export function beginFold(db: SQLiteDatabase): FoldState | null {
  const state = readFoldState(db);
  const highest = numberOrNull(
    (
      db.prepare('SELECT MAX(entry_id) AS id FROM ocl_ss_index').get() as
        Record<string, unknown> | undefined
    )?.id,
  );
  // Never lowered: an entry deleted since may still have its copy in the tail.
  const through = maxOf(highest, state.tailThrough, state.foldedThrough);
  const above =
    through !== null &&
    (state.foldedThrough === null || through > state.foldedThrough);
  if (!above && !hasTailRows(db)) return null;

  db.prepare(
    `UPDATE ${FOLD_TABLE}
        SET tail_through = ?, cursor_mw = ?, cursor_entry_id = ?, segment = NULL
      WHERE id = 1`,
  ).run(through, START_CURSOR.mw, START_CURSOR.entryId);
  return {
    foldedThrough: state.foldedThrough,
    tailThrough: through,
    cursor: START_CURSOR,
    segment: null,
  };
}

/**
 * Record what the fold in progress has published. Called inside the
 * transaction publishing the chunk, so the two cannot disagree.
 * @param db - The database being folded.
 * @param cursor - The last row published.
 * @param segment - The segment the fold extends.
 */
export function saveFoldProgress(
  db: SQLiteDatabase,
  cursor: FoldCursor,
  segment: number,
): void {
  db.prepare(
    `UPDATE ${FOLD_TABLE}
        SET cursor_mw = ?, cursor_entry_id = ?, segment = ?
      WHERE id = 1`,
  ).run(cursor.mw, cursor.entryId, segment);
}

/**
 * Close the fold in progress: everything up to its bound is folded or in the
 * tail, so the watermark moves there.
 * @param db - The database being folded.
 */
export function finishFold(db: SQLiteDatabase): void {
  db.exec(
    `UPDATE ${FOLD_TABLE}
        SET folded_through = tail_through, cursor_mw = NULL,
            cursor_entry_id = NULL, segment = NULL
      WHERE id = 1`,
  );
}

/**
 * Whether the entries between two ids fit in one chunk.
 *
 * They are counted through the entry index and the count stops one past a
 * chunk, so asking never walks more than a chunk's worth of keys.
 * @param db - The database to read.
 * @param after - The lower bound, exclusive.
 * @param through - The upper bound, inclusive.
 * @returns True when at most one chunk of entries lies between them.
 */
export function fitsOneChunk(
  db: SQLiteDatabase,
  after: number,
  through: number,
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM ocl_ss_index INDEXED BY idx_ocl_ss_entry
          WHERE entry_id > ? AND entry_id <= ? LIMIT ?)`,
    )
    .get(after, through, SLOTS_PER_CHUNK + 1) as Record<string, unknown>;
  return Number(row.n) <= SLOTS_PER_CHUNK;
}

/**
 * How many entries of `ocl_ss_index` no fold has reached.
 *
 * Counted through the entry index from the watermark, so it walks only those
 * entries — before the first fold, that is all of them.
 * @param db - The database to read.
 * @param after - The watermark, or null before the first fold.
 * @returns The number of entries above it.
 */
export function countAbove(db: SQLiteDatabase, after: number | null): number {
  const row = (
    after === null
      ? db.prepare('SELECT COUNT(*) AS n FROM ocl_ss_index').get()
      : db
          .prepare(
            `SELECT COUNT(*) AS n FROM ocl_ss_index INDEXED BY idx_ocl_ss_entry
              WHERE entry_id > ?`,
          )
          .get(after)
  ) as Record<string, unknown>;
  return Number(row.n);
}

/**
 * Whether any entry of `ocl_ss_index` has an id above a bound.
 * @param db - The database to read.
 * @param through - The bound.
 * @returns True when one does; a seek on the entry index.
 */
export function hasEntriesAbove(db: SQLiteDatabase, through: number): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM ocl_ss_index INDEXED BY idx_ocl_ss_entry WHERE entry_id > ? LIMIT 1',
      )
      .get(through) !== undefined
  );
}

/**
 * Whether the tail holds anything.
 * @param db - The database to read.
 * @returns True when it holds at least one row.
 */
export function hasTailRows(db: SQLiteDatabase): boolean {
  return db.prepare(`SELECT 1 FROM ${TAIL_TABLE} LIMIT 1`).get() !== undefined;
}

/**
 * A column value as a number, or null.
 * @param value - The value SQLite returned.
 * @returns The number, or null for NULL and absent values.
 */
function numberOrNull(value: unknown): number | null {
  return value == null ? null : Number(value);
}

/**
 * The largest of several bounds, ignoring the absent ones.
 * @param values - The bounds.
 * @returns The largest, or null when all are null.
 */
function maxOf(...values: Array<number | null>): number | null {
  let largest: number | null = null;
  for (const value of values) {
    if (value !== null && (largest === null || value > largest)) {
      largest = value;
    }
  }
  return largest;
}
