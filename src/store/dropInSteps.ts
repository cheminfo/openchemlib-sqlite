import type { DatabaseSync } from 'node:sqlite';

import { hasTable } from './schema.ts';

/** Rows deleted per transaction: a few megabytes of tiles, a few milliseconds of lock. */
const ROWS_PER_STEP = 1000;

/**
 * Frees a large table a step at a time: a few thousand rows per short write transaction, the
 * event loop let go between steps, then the emptied table dropped. Dropping it whole would hold
 * the write lock for seconds (7 s for the tiles of 200 M molecules).
 * @param db - The connection, outside any transaction.
 * @param table - The table: `ocl_tile_old`, `ocl_tile_next`, or one 5.x left.
 * @param columns - What its rows are deleted by: `id`, `rowid`, or the columns of its primary key.
 * @returns Once the table is gone.
 */
export async function dropInSteps(
  db: DatabaseSync,
  table: string,
  columns: readonly string[] = ['id'],
): Promise<void> {
  const list = columns.join(', ');
  const key = columns.length === 1 ? list : `(${list})`;
  while (hasTable(db, table)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const { changes } = db
        .prepare(
          `DELETE FROM ${table} WHERE ${key} IN (SELECT ${list} FROM ${table} ORDER BY ${list} LIMIT ?)`,
        )
        .run(ROWS_PER_STEP);
      if (Number(changes) === 0) db.exec(`DROP TABLE ${table}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    // eslint-disable-next-line no-await-in-loop -- the application's writers take the lock between steps
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
