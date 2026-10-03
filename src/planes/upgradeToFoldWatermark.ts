import type { SQLiteDatabase } from '../types.ts';

import {
  FOLD_TABLE,
  SEGMENT_TABLE,
  TAIL_TABLE,
  TAIL_TRIGGER,
  buildFoldTableSql,
  buildTailTableSql,
  buildTailTriggerSql,
} from './planeSchema.ts';

/**
 * Version 6: fold up to an entry-id watermark instead of copying every insert.
 *
 * Version 5's trigger copied every new fingerprint into the tail, so a database
 * that never folds held each one twice. From here the tail only takes an entry
 * whose id is at or below the watermark, and a fold finds the rest above it.
 *
 * Safe to replay over a database already past it, as a rewound version table
 * makes it: a recorded fold state is kept rather than rebuilt.
 * @param db - The database to upgrade.
 */
export function upgradeToFoldWatermark(db: SQLiteDatabase): void {
  db.exec(buildFoldTableSql());
  db.exec(`DROP TRIGGER IF EXISTS ${TAIL_TRIGGER}`);
  const folded =
    db.prepare(`SELECT 1 FROM ${SEGMENT_TABLE} LIMIT 1`).get() !== undefined;
  if (folded) {
    // Version 5 drained the tail fold by fold, so whatever no fold has reached
    // is in it: the watermark starts at the highest id present.
    db.exec(
      `INSERT OR IGNORE INTO ${FOLD_TABLE} (id, folded_through, tail_through)
       SELECT 1, MAX(entry_id), MAX(entry_id) FROM ocl_ss_index`,
    );
  } else {
    // Never folded: every tail row copies a row of ocl_ss_index, which the
    // first fold reads. Dropped rather than emptied: `DELETE FROM` walks every
    // row, and there is one per entry.
    db.exec(`DROP TABLE IF EXISTS ${TAIL_TABLE}`);
    db.exec(buildTailTableSql());
    db.exec(`INSERT OR IGNORE INTO ${FOLD_TABLE} (id) VALUES (1)`);
  }
  db.exec(buildTailTriggerSql());
}
