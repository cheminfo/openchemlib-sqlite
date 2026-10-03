import type { SQLiteDatabase } from '../types.ts';

import { intersectPlanes } from './planeIntersect.ts';
import { SLOTS_PER_CHUNK, bitsOfIndex } from './planeLayout.ts';
import { BITSTAT_TABLE, SEGMENT_TABLE } from './planeSchema.ts';

/**
 * The query's bits, rarest first, or null when the planes cannot screen it.
 *
 * Only bits the index kept a plane for are usable, and they are ordered by how
 * many entries set them so the intersection sheds candidates as fast as
 * possible. A query whose every bit is one of the common ones the fold dropped
 * gets no screen at all and belongs on the column path.
 * @param db - The database to read the bit statistics from.
 * @param index - The query fingerprint, as `Molecule.getIndex()` returns it.
 * @returns The usable bit positions, rarest first, or null.
 */
export function planeQueryBits(
  db: SQLiteDatabase,
  index: number[] | Uint32Array,
): number[] | null {
  const wanted = bitsOfIndex(index);
  if (wanted.length === 0) return null;
  const rows = db
    .prepare(
      `SELECT bit, population FROM ${BITSTAT_TABLE}
        WHERE stored = 1 AND bit IN (${wanted.map(() => '?').join(',')})
        ORDER BY population ASC`,
    )
    .all(...wanted) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  return rows.map((row) => Number(row.bit));
}

/**
 * How many segments the plane index holds, and how many slots it covers.
 *
 * Every segment is internally ascending by molecular weight, so one segment
 * means slot order *is* mw order and the plane path can serve an ordered search
 * directly. With several, an ordered search needs them merged by mw — until
 * that exists, an ordered search over a multi-segment index stays on the column
 * path, while an unordered one is served whatever the segment count.
 * @param db - The database to read.
 * @returns The segment count and the number of slots in use.
 */
export function planeCoverage(db: SQLiteDatabase): {
  segments: number;
  slots: number;
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS segments, COALESCE(SUM(slot_count), 0) AS slots
         FROM ${SEGMENT_TABLE}`,
    )
    .get() as Record<string, unknown> | undefined;
  return {
    segments: Number(row?.segments ?? 0),
    slots: Number(row?.slots ?? 0),
  };
}

/**
 * The chunks a search may read, ascending.
 *
 * Derived from the segments rather than from the planes themselves, and that is
 * what makes a fold safe to interrupt: a chunk whose planes are written but
 * whose segment has not been extended is not listed here, so it cannot answer.
 * Taken from `ocl_ss_plane` instead, a half-written chunk would be read as
 * complete and quietly return false negatives — a missing plane row legitimately
 * means "no entry here sets this bit".
 * @param db - The database to read.
 * @returns Every chunk number a published segment covers.
 */
export function planeChunks(db: SQLiteDatabase): number[] {
  const rows = db
    .prepare(
      `SELECT first_slot, slot_count FROM ${SEGMENT_TABLE}
        WHERE slot_count > 0 ORDER BY first_slot`,
    )
    .all() as Array<Record<string, unknown>>;
  const chunks = new Set<number>();
  for (const row of rows) {
    const first = Number(row.first_slot);
    const last = first + Number(row.slot_count) - 1;
    for (
      let chunk = Math.floor(first / SLOTS_PER_CHUNK);
      chunk <= Math.floor(last / SLOTS_PER_CHUNK);
      chunk++
    ) {
      chunks.add(chunk);
    }
  }
  return [...chunks].toSorted((a, b) => a - b);
}

/**
 * How many slots the plane intersection leaves, without resolving any of them.
 *
 * This is the router's input, and it is cheap: the intersection is the fast half
 * of the plane path, while turning slots back into entries costs a batched join
 * per candidate. A query the screen barely narrows is therefore better served by
 * the clustered column scan, which streams in molecular-weight order and can
 * stop early — and this says so before any of that work is done.
 *
 * It is an upper bound: the planes of bits most molecules set are not kept, so
 * some survivors fail the exact 512-bit test afterwards, and a slot whose entry
 * was removed or left above the watermark is counted although it answers
 * nothing.
 * @param db - The database to read.
 * @param bits - The query's usable bits, rarest first, from {@link planeQueryBits}.
 * @returns How many slots survived the intersection.
 */
export function planeSurvivorCount(
  db: SQLiteDatabase,
  bits: readonly number[],
): number {
  let total = 0;
  for (const survivors of intersectPlanes(db, bits, planeChunks(db))) {
    total += survivors.count;
  }
  return total;
}
