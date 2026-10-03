import type { SQLiteDatabase } from '../types.ts';

import { resetFoldState } from './foldState.ts';
import {
  BITSTAT_TABLE,
  PLANE_TABLE,
  SEGMENT_TABLE,
  SLOT_TABLE,
} from './planeSchema.ts';
import { inTransaction } from './writeChunk.ts';

const PLANE_TABLES = [PLANE_TABLE, SLOT_TABLE, BITSTAT_TABLE, SEGMENT_TABLE];

/**
 * Empty the plane index, so the next fold starts from nothing.
 *
 * The tables are dropped and created again from the statements that created
 * them, read back from `sqlite_schema`: `DELETE FROM` would walk every row, and
 * the slot table has one per entry folded. Recreating them from their own
 * statements keeps whatever they were created with — the foreign key to the
 * entries table, or its absence when the index lives in a database of its own.
 *
 * One transaction, so a search sees either the old planes or none, and nothing
 * is trusted until a fold completes.
 * @param db - The database whose plane index to empty.
 */
export function resetPlanes(db: SQLiteDatabase): void {
  const placeholders = PLANE_TABLES.map(() => '?').join(', ');
  const statements = db
    .prepare(
      `SELECT sql FROM sqlite_schema
        WHERE tbl_name IN (${placeholders}) AND sql IS NOT NULL
        ORDER BY type = 'index', name`,
    )
    .all(...PLANE_TABLES) as Array<{ sql: string }>;
  inTransaction(db, () => {
    for (const table of PLANE_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    for (const { sql } of statements) db.exec(sql);
    resetFoldState(db);
  });
}
