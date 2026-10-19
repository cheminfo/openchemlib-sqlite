import type { DatabaseSync } from 'node:sqlite';

/**
 * Adds the two distinct-hash counters to a file written before the library kept them: each is
 * counted once, walking its hash index, inside one write transaction so no commit lands between
 * the count and the row. Every commit and removal keeps them exact afterwards.
 * @param db - The connection, outside any transaction.
 * @returns True when they were added, false when the file had them.
 */
export function ensureDistinctCounts(db: DatabaseSync): boolean {
  const has = db.prepare(
    "SELECT 1 AS found FROM ocl_meta WHERE name = 'distinctNoStereo'",
  );
  if (has.get() !== undefined) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another connection may have added them while this one waited for the lock.
    if (has.get() !== undefined) {
      db.exec('COMMIT');
      return false;
    }
    // One statement per column: each walks its covering index, where counting both at once
    // would scan the table into two temporary B-trees.
    const distinct = (column: string) =>
      (
        db
          .prepare(`SELECT count(DISTINCT ${column}) AS n FROM ocl_molecule`)
          .get() as { n: number }
      ).n;
    const insert = db.prepare(
      'INSERT INTO ocl_meta (name, value) VALUES (?, ?)',
    );
    insert.run('distinctNoStereo', distinct('noStereoHash'));
    insert.run('distinctTautomer', distinct('tautomerHash'));
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
