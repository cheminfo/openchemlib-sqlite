import type { SQLiteDatabase } from '../types.ts';

import type { FoldCursor } from './foldState.ts';
import { TAIL_TABLE } from './planeSchema.ts';

const COLUMNS =
  'mw, entry_id, ss_index0, ss_index1, ss_index2, ss_index3, ss_index4, ss_index5, ss_index6, ss_index7';

/** What a fold reads, and through which plan. */
export interface FoldSource {
  /** The watermark the fold starts from, exclusive; null on the first fold. */
  after: number | null;
  /** The fold's bound, inclusive. */
  through: number;
  /** Whether the entries above the watermark are read through the entry index. */
  indexed: boolean;
}

/**
 * The statement reading one page of a fold, and its parameters.
 *
 * Two sources, merged in `(mw, entry_id)` order so the segment stays sorted by
 * weight: the entries of `ocl_ss_index` above the watermark, and the tail rows
 * at or below it — the out-of-order and repeated inserts the range cannot see.
 * The two never share an entry id.
 *
 * The range is read through the entry index when it fits in one chunk, which is
 * one sort of at most a chunk's rows. A larger range is read by the clustered
 * scan, filtered: one pass over the index whatever the number of pages, where
 * sorting what is left for every page would grow with the square of the range.
 * The unary `+` keeps the entry index out of that plan.
 * @param source - The watermark, the bound and the plan.
 * @param cursor - The last row already folded.
 * @param limit - The most rows to return.
 * @returns The SQL and the parameters to bind, in order.
 */
export function buildFoldReadSql(
  source: FoldSource,
  cursor: FoldCursor,
  limit: number,
): { sql: string; params: unknown[] } {
  const { after, through, indexed } = source;
  let range: string;
  if (after === null) {
    range = 'FROM ocl_ss_index WHERE +entry_id <= ?';
  } else if (indexed) {
    range =
      'FROM ocl_ss_index INDEXED BY idx_ocl_ss_entry WHERE entry_id > ? AND entry_id <= ?';
  } else {
    range = 'FROM ocl_ss_index WHERE +entry_id > ? AND +entry_id <= ?';
  }
  const arms = [
    `SELECT ${COLUMNS}, 0 AS from_tail ${range} AND (mw, entry_id) > (?, ?)`,
  ];
  const params: unknown[] = [
    ...(after === null ? [through] : [after, through]),
    cursor.mw,
    cursor.entryId,
  ];
  if (after !== null) {
    arms.push(
      `SELECT ${COLUMNS}, 1 AS from_tail FROM ${TAIL_TABLE}
        WHERE entry_id <= ? AND (mw, entry_id) > (?, ?)`,
    );
    params.push(after, cursor.mw, cursor.entryId);
  }
  return {
    sql: `${arms.join(' UNION ALL ')} ORDER BY mw, entry_id LIMIT ?`,
    params: [...params, limit],
  };
}

/**
 * The tail copies a chunk has just made redundant.
 *
 * An entry inserted while the fold runs, with an id between the watermark and
 * the bound, is copied into the tail in case the fold has read past it. When the
 * fold reaches it after all, the copy holding exactly the values folded goes
 * with the chunk; one holding other values — the entry inserted again after it
 * was read — stays for the next fold.
 * @param db - The database being folded.
 * @param rows - The rows of the chunk, as the fold read them.
 * @param source - The watermark and the bound of the fold.
 * @returns The tail rows to delete with the chunk.
 */
export function foldedTailCopies(
  db: SQLiteDatabase,
  rows: ReadonlyArray<Record<string, unknown>>,
  source: FoldSource,
): Array<Record<string, unknown>> {
  const { after, through } = source;
  const read = db.prepare(
    `SELECT ${COLUMNS} FROM ${TAIL_TABLE}
      WHERE entry_id <= ?${after === null ? '' : ' AND entry_id > ?'}`,
  );
  read.setReadBigInts?.(true);
  const copies = read.all(
    ...(after === null ? [through] : [through, after]),
  ) as Array<Record<string, unknown>>;
  if (copies.length === 0) return [];

  const byEntry = new Map<number, Record<string, unknown>>();
  for (const copy of copies) byEntry.set(Number(copy.entry_id), copy);
  const redundant: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (Number(row.from_tail) === 1) continue;
    const copy = byEntry.get(Number(row.entry_id));
    if (copy !== undefined && sameFingerprint(copy, row)) redundant.push(copy);
  }
  return redundant;
}

/**
 * Whether two rows hold the same weight and fingerprint.
 * @param a - A row carrying mw and ss_index0..7.
 * @param b - Another.
 * @returns True when all nine values are equal.
 */
function sameFingerprint(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  if (Number(a.mw) !== Number(b.mw)) return false;
  for (let word = 0; word < 8; word++) {
    if (a[`ss_index${word}`] !== b[`ss_index${word}`]) return false;
  }
  return true;
}
