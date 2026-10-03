import type { FoldCursor } from './foldState.ts';

const COLUMNS =
  'mw, entry_id, ss_index0, ss_index1, ss_index2, ss_index3, ss_index4, ss_index5, ss_index6, ss_index7';

/** What a fold reads, and through which plan. */
export interface FoldSource {
  /** The watermark the fold starts from, exclusive; null to read from the first entry. */
  after: number | null;
  /** The fold's bound, inclusive. */
  through: number;
  /** Whether the range is read through the entry index. */
  indexed: boolean;
}

/**
 * The statement reading one page of a fold, and its parameters.
 *
 * The entries of `ocl_ss_index` above the watermark and up to the bound, in
 * `(mw, entry_id)` order so the segment stays sorted by weight. There is no
 * other source: whatever a write left untrusted below the old watermark is
 * above the watermark now.
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
  return {
    sql: `SELECT ${COLUMNS} ${range} AND (mw, entry_id) > (?, ?)
           ORDER BY mw, entry_id LIMIT ?`,
    params: [
      ...(after === null ? [through] : [after, through]),
      cursor.mw,
      cursor.entryId,
      limit,
    ],
  };
}
