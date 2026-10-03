import type { SQLiteDatabase } from '../types.ts';

import { SLOTS_PER_CHUNK } from './planeLayout.ts';
import { SLOT_TABLE } from './planeSchema.ts';
import { FOLD_TABLE } from './watermarkSchema.ts';

/** A position in `(mw, entry_id)` order, the order a fold reads in. */
export interface FoldCursor {
  mw: number;
  entryId: number;
}

/** How far the plane index can be trusted, as {@link FOLD_TABLE} records it. */
export interface FoldState {
  /** The planes hold every entry whose id is at most this; null for none. */
  watermark: number | null;
  /** Writes at or below this lower the watermark; null when nothing is folded. */
  bound: number | null;
  /** The last row the fold in progress published, or null when none is in progress. */
  cursor: FoldCursor | null;
  /** The segment the fold in progress extends, or null before its first chunk. */
  segment: number | null;
}

/** Where a fold starts reading: below every real weight. */
export const START_CURSOR: FoldCursor = { mw: -1e308, entryId: 0 };

/**
 * Read how far the plane index can be trusted.
 * @param db - The database to read.
 * @returns The recorded state.
 */
export function readFoldState(db: SQLiteDatabase): FoldState {
  const row = db
    .prepare(
      `SELECT watermark, bound, cursor_mw, cursor_entry_id, segment
         FROM ${FOLD_TABLE} WHERE id = 1`,
    )
    .get() as Record<string, unknown> | undefined;
  return {
    watermark: numberOrNull(row?.watermark),
    bound: numberOrNull(row?.bound),
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
 * The fold covers every entry above the watermark up to the highest id present
 * now. That id is written as the bound before the fold reads a row, so a write
 * at or below it while the fold runs — the fold may have read past that entry
 * already — keeps the watermark the fold sets below it, and an entry above it
 * is simply left to the next fold.
 * @param db - The database to fold.
 * @returns The state of the fold just started, or null when nothing waits.
 */
export function beginFold(db: SQLiteDatabase): FoldState | null {
  const { watermark } = readFoldState(db);
  const highest = highestEntryId(db);
  if (highest === null || (watermark !== null && highest <= watermark)) {
    return null;
  }
  db.prepare(
    `UPDATE ${FOLD_TABLE}
        SET bound = ?, cursor_mw = ?, cursor_entry_id = ?, segment = NULL
      WHERE id = 1`,
  ).run(highest, START_CURSOR.mw, START_CURSOR.entryId);
  return { watermark, bound: highest, cursor: START_CURSOR, segment: null };
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
 * Close the fold in progress: every entry up to its bound is now in the planes,
 * so the watermark moves there.
 *
 * The bound is read as it is now, not as the fold started: a write the triggers
 * caught while the fold ran has lowered it below that entry.
 * @param db - The database being folded.
 */
export function finishFold(db: SQLiteDatabase): void {
  db.exec(
    `UPDATE ${FOLD_TABLE}
        SET watermark = bound, cursor_mw = NULL, cursor_entry_id = NULL,
            segment = NULL
      WHERE id = 1`,
  );
}

/**
 * Forget everything the planes hold: nothing is trusted until a fold completes.
 * @param db - The database whose plane tables have just been emptied.
 */
export function resetFoldState(db: SQLiteDatabase): void {
  db.exec(
    `UPDATE ${FOLD_TABLE}
        SET watermark = NULL, bound = NULL, cursor_mw = NULL,
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
  return countAbove(db, after, SLOTS_PER_CHUNK + 1, through) <= SLOTS_PER_CHUNK;
}

/**
 * How many entries of `ocl_ss_index` lie above the watermark.
 *
 * Counted through the entry index from the watermark, so it walks only those
 * entries — before the first fold, that is all of them — and never more than
 * `cap` of them.
 * @param db - The database to read.
 * @param watermark - The watermark, or null to count every entry.
 * @param cap - The count stops here.
 * @param through - An upper bound on the ids counted, inclusive.
 * @returns The number of entries above the watermark, at most `cap`.
 */
export function countAbove(
  db: SQLiteDatabase,
  watermark: number | null,
  cap: number = Number.MAX_SAFE_INTEGER,
  through: number | null = null,
): number {
  const conditions: string[] = [];
  const values: number[] = [];
  if (watermark !== null) {
    conditions.push('entry_id > ?');
    values.push(watermark);
  }
  if (through !== null) {
    conditions.push('entry_id <= ?');
    values.push(through);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM ocl_ss_index INDEXED BY idx_ocl_ss_entry${
           conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
         } LIMIT ?)`,
    )
    .get(...values, cap) as Record<string, unknown>;
  return Number(row.n);
}

/**
 * Whether any entry of `ocl_ss_index` lies above the watermark.
 * @param db - The database to read.
 * @param watermark - The watermark, or null for any entry at all.
 * @returns True when one does; a seek on the entry index.
 */
export function hasEntriesAbove(
  db: SQLiteDatabase,
  watermark: number | null,
): boolean {
  const highest = highestEntryId(db);
  return highest !== null && (watermark === null || highest > watermark);
}

/**
 * Whether the planes hold entries above the watermark: entries folded once,
 * then left untrusted by a write at or below their id.
 * @param db - The database to read.
 * @param watermark - The watermark.
 * @returns True when a slot stands for an entry above it; a seek.
 */
export function hasSlotsAbove(
  db: SQLiteDatabase,
  watermark: number | null,
): boolean {
  const row = db
    .prepare(`SELECT MAX(entry_id) AS id FROM ${SLOT_TABLE}`)
    .get() as Record<string, unknown> | undefined;
  const highest = numberOrNull(row?.id);
  return highest !== null && (watermark === null || highest > watermark);
}

/**
 * The highest entry id of `ocl_ss_index`.
 * @param db - The database to read.
 * @returns It, or null when the index is empty; a seek on the entry index.
 */
export function highestEntryId(db: SQLiteDatabase): number | null {
  const row = db
    .prepare('SELECT MAX(entry_id) AS id FROM ocl_ss_index')
    .get() as Record<string, unknown> | undefined;
  return numberOrNull(row?.id);
}

/**
 * A column value as a number, or null.
 * @param value - The value SQLite returned.
 * @returns The number, or null for NULL and absent values.
 */
function numberOrNull(value: unknown): number | null {
  return value == null ? null : Number(value);
}
