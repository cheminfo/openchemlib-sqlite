import type { SQLiteDatabase } from '../types.ts';

import { countAbove, hasSlotsAbove, readFoldState } from './foldState.ts';
import { planeCoverage } from './planeCoverage.ts';
import { unfoldedLimit } from './planeRouter.ts';

/** What the plane index covers, and whether it is worth folding again. */
export interface PlaneStatus {
  /** Slots the plane index holds, removed and untrusted entries included. */
  folded: number;
  /** Folds whose chunks the plane index holds. */
  segments: number;
  /**
   * The planes hold every entry whose id is at most this, with its current
   * fingerprint; null before the first fold completes. A write at or below it
   * lowers it — see `foldPlanes()`.
   */
  watermark: number | null;
  /**
   * Entries above the watermark, which every search screens the slower way and
   * the next fold picks up. Before the first fold this is every entry.
   */
  pending: number;
  /**
   * Whether calling `foldPlanes()` now would make searches faster: a fold is
   * half done, a write below the watermark has left folded entries untrusted,
   * or so many entries wait that the plane path is no longer taken. Always
   * false for a database that never folded.
   */
  refoldAdvisable: boolean;
}

/**
 * What the plane index covers, and whether it is worth folding again.
 * @param db - The database to read.
 * @returns The status.
 */
export function planeStatusOf(db: SQLiteDatabase): PlaneStatus {
  const { segments, slots } = planeCoverage(db);
  const { watermark, cursor } = readFoldState(db);
  const pending = countAbove(db, watermark);
  const refoldAdvisable =
    slots > 0 &&
    pending > 0 &&
    (cursor !== null ||
      watermark === null ||
      hasSlotsAbove(db, watermark) ||
      pending > unfoldedLimit(slots));
  return { folded: slots, segments, watermark, pending, refoldAdvisable };
}
