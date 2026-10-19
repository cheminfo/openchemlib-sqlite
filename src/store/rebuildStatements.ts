import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { prepareAddCount } from './bitCounts.ts';
import { prepareSetMeta } from './rebuildState.ts';

/** The statements of a rebuild, prepared once its tables exist. */
export type RebuildStatements = Record<
  | 'readTiles'
  | 'readIdCode'
  | 'changes'
  | 'source'
  | 'next'
  | 'insertTile'
  | 'upsertTile'
  | 'addCount'
  | 'deleteChanges'
  | 'pending'
  | 'setMeta',
  StatementSync
>;

/**
 * Prepares the statements of a rebuild of the tiles and counts.
 * @param db - Its connection, once `beginRebuild()` created the new tiles and counts.
 * @returns The statements.
 */
export function prepareStatements(db: DatabaseSync): RebuildStatements {
  const prepare = (sql: string) => db.prepare(sql);
  return {
    readTiles: prepare(
      'SELECT id, data FROM ocl_tile WHERE id > ? ORDER BY id LIMIT ?',
    ),
    readIdCode: prepare('SELECT idCode FROM ocl_molecule WHERE id = ?'),
    changes: prepare(
      'SELECT seq, id FROM ocl_rebuild_tiles ORDER BY seq LIMIT ?',
    ),
    source: prepare('SELECT data FROM ocl_tile WHERE id = ?'),
    next: prepare('SELECT data FROM ocl_tile_next WHERE id = ?'),
    insertTile: prepare('INSERT INTO ocl_tile_next (id, data) VALUES (?, ?)'),
    upsertTile: prepare(
      'INSERT OR REPLACE INTO ocl_tile_next (id, data) VALUES (?, ?)',
    ),
    addCount: prepareAddCount(db, 'ocl_bits_next'),
    deleteChanges: prepare('DELETE FROM ocl_rebuild_tiles WHERE seq <= ?'),
    pending: prepare(
      'SELECT max(seq) - min(seq) + 1 AS n FROM ocl_rebuild_tiles',
    ),
    setMeta: prepareSetMeta(db),
  };
}

/**
 * Runs reads in one read transaction, so they see one state of the file.
 * @param db - The connection.
 * @param work - The reads.
 * @returns What they return.
 */
export function read<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN');
  try {
    return work();
  } finally {
    db.exec('COMMIT');
  }
}

/**
 * How many changes the log holds at most.
 * @param statements - The statements.
 * @returns The span of its sequence numbers.
 */
export function pending(statements: RebuildStatements): number {
  const row = statements.pending.get() as { n: number | null } | undefined;
  return row?.n ?? 0;
}

/**
 * The idCode of a molecule a tile holds, read in the same read transaction as the tile: a removal
 * empties the slot and deletes the row together.
 * @param statements - The statements.
 * @param id - The molecule.
 * @returns Its idCode.
 */
export function idCodeOf(statements: RebuildStatements, id: number): string {
  const row = statements.readIdCode.get(id) as { idCode: string } | undefined;
  if (row === undefined) throw new Error(`no idCode for id ${id}`);
  return row.idCode;
}
