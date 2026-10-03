import type { SQLiteDatabase } from '../types.ts';

import {
  SEGMENT_TABLE,
  SLOT_TABLE,
  TAIL_TABLE,
  TAIL_TRIGGER,
} from './planeSchema.ts';
import {
  FOLD_TABLE,
  buildFoldTableSql,
  buildWatermarkTriggersSql,
} from './watermarkSchema.ts';

/**
 * Version 6: drop the tail, and trust the planes up to a watermark instead.
 *
 * Version 5 copied every inserted fingerprint into `ocl_ss_tail`, so a database
 * that never folded held each one twice, and a fold drained the copies. From
 * here nothing is copied: the planes are trusted for every entry up to the
 * watermark, the rest is read from `ocl_ss_index` itself, and triggers lower
 * the watermark when a write lands at or below it.
 *
 * The watermark starts where version 5's planes are complete, and no higher:
 * below the first entry the tail holds — inserted or inserted again since the
 * last fold — and below the first entry no published slot stands for. A
 * database that never folded starts with none, and reads everything from
 * `ocl_ss_index` until its first fold, exactly as it did.
 *
 * Slots whose entry has left the index are dropped too: version 5 never
 * removed them, and one left behind would make an id given to a new entry look
 * folded already.
 * @param db - The database to upgrade.
 */
export function upgradeToWatermark(db: SQLiteDatabase): void {
  const watermark = trustedWatermark(db);
  db.exec(`DROP TRIGGER IF EXISTS ${TAIL_TRIGGER}`);
  // Dropped rather than emptied: `DELETE FROM` walks every row, and a database
  // that never folded has one per entry. Its index goes with it.
  db.exec(`DROP TABLE IF EXISTS ${TAIL_TABLE}`);
  if (watermark !== null) {
    db.exec(
      `DELETE FROM ${SLOT_TABLE}
        WHERE NOT EXISTS (SELECT 1 FROM ocl_ss_index s
                           WHERE s.entry_id = ${SLOT_TABLE}.entry_id)`,
    );
  }
  db.exec(buildFoldTableSql());
  db.prepare(
    `UPDATE ${FOLD_TABLE} SET watermark = ?, bound = ? WHERE id = 1`,
  ).run(watermark, watermark);
  db.exec(buildWatermarkTriggersSql());
}

/**
 * The highest id below which version 5's planes hold every entry with its
 * current fingerprint.
 * @param db - The version 5 database.
 * @returns It, or null when nothing is folded.
 */
function trustedWatermark(db: SQLiteDatabase): number | null {
  const folded =
    db.prepare(`SELECT 1 FROM ${SEGMENT_TABLE} LIMIT 1`).get() !== undefined;
  if (!folded) return null;
  let watermark = firstValue(
    db,
    'SELECT MAX(entry_id) AS id FROM ocl_ss_index',
  );
  if (watermark === null) return null;

  const tailExists =
    db
      .prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`)
      .get(TAIL_TABLE) !== undefined;
  const firstWaiting = tailExists
    ? firstValue(db, `SELECT MIN(entry_id) AS id FROM ${TAIL_TABLE}`)
    : null;
  if (firstWaiting !== null) watermark = Math.min(watermark, firstWaiting - 1);

  // Walked in id order and stopped at the first gap, so only the range the
  // watermark could still cover is read.
  const firstUnfolded = firstValue(
    db,
    `SELECT s.entry_id AS id FROM ocl_ss_index s INDEXED BY idx_ocl_ss_entry
      WHERE s.entry_id <= ?
        AND NOT EXISTS (
          SELECT 1 FROM ${SLOT_TABLE} t JOIN ${SEGMENT_TABLE} g
              ON t.slot >= g.first_slot AND t.slot < g.first_slot + g.slot_count
           WHERE t.entry_id = s.entry_id)
      ORDER BY s.entry_id LIMIT 1`,
    watermark,
  );
  if (firstUnfolded !== null) watermark = firstUnfolded - 1;
  return watermark;
}

/**
 * The `id` column of a one-row query, as a number.
 * @param db - The database to read.
 * @param sql - A query returning at most one row with an `id` column.
 * @param params - Its parameters.
 * @returns The value, or null when absent or NULL.
 */
function firstValue(
  db: SQLiteDatabase,
  sql: string,
  ...params: number[]
): number | null {
  const row = db.prepare(sql).get(...params) as
    Record<string, unknown> | undefined;
  return row?.id == null ? null : Number(row.id);
}
