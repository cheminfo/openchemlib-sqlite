import type { SQLiteDatabase } from '../types.ts';
import { unpackSSIndex } from '../utils/packSSIndex.ts';

import { ChunkBuilder } from './ChunkBuilder.ts';
import { SLOTS_PER_CHUNK, bitsOfIndex } from './planeLayout.ts';
import {
  BITSTAT_TABLE,
  PLANE_TABLE,
  SEGMENT_TABLE,
  SLOT_TABLE,
  TAIL_TABLE,
} from './planeSchema.ts';
import {
  countOf,
  decideStoredBits,
  nextSlotOf,
  storedBitsOf,
} from './planeState.ts';

/** How a fold decides what to store and how much to do in one call. */
export interface FoldOptions {
  /**
   * The share of entries above which a bit gets no plane.
   *
   * A bit set by most molecules screens almost nothing — intersecting its plane
   * removes few candidates while costing a full read — and the 512-bit exact
   * test on the survivors catches whatever it would have caught. Dropping those
   * planes is what keeps the index to a few bytes per molecule instead of 64.
   *
   * Decided once, on the first fold, and never revisited: a bit stored for some
   * chunks and not others could not be read back, because a missing row has to
   * keep meaning "no entry here sets this bit".
   * @default 0.5
   */
  maxPopulationRatio?: number;
  /**
   * Chunks to fold before returning, so a long fold can be driven in slices.
   * @default Number.MAX_SAFE_INTEGER
   */
  maxChunks?: number;
  /** Called after each chunk with how many entries have been folded so far. */
  onProgress?: (folded: number) => void;
}

/** What one fold did. */
export interface FoldResult {
  /** Entries given a slot by this call. */
  folded: number;
  /** Chunks written. */
  chunks: number;
  /** Bits the index keeps planes for. */
  storedBits: number;
  /** Whether entries are still waiting to be folded. */
  pending: boolean;
  elapsedMs: number;
}

/**
 * Fold waiting fingerprints into the plane index.
 *
 * This is the whole maintenance story. Setting one molecule's bits in place
 * would rewrite a chunk of each of the 74–348 planes it sets, so nothing is ever
 * written per insert: `insert()` only adds a row to the tail, and a fold later
 * appends a batch of them as whole new chunks. One chunk carries 2^20 molecules,
 * so the write comes to 64 bytes per molecule — the size of the fingerprint
 * itself, which is the least it could be.
 *
 * Each fold appends one segment, and reads its source in `(mw, entry_id)` order,
 * so **every segment is internally ascending by molecular weight**. A search
 * therefore merges the segments by mw and gets exactly the lightest-first order
 * the clustered `ocl_ss_index` scan produces, however many folds have run.
 *
 * The first fold seeds from `ocl_ss_index` itself, so an existing database needs
 * no re-insertion; later ones drain the tail the trigger fills.
 * @param db - The database to fold.
 * @param options - What to store, and how much to do in one call.
 * @returns What this call folded, and whether anything is still waiting.
 */
export function foldPlanes(
  db: SQLiteDatabase,
  options: FoldOptions = {},
): FoldResult {
  const {
    maxPopulationRatio = 0.5,
    maxChunks = Number.MAX_SAFE_INTEGER,
    onProgress,
  } = options;
  const start = Date.now();

  const segments = countOf(db, SEGMENT_TABLE);
  const source = segments === 0 ? 'ocl_ss_index' : TAIL_TABLE;
  const nextSlot = nextSlotOf(db);
  // A fold starts on a chunk boundary so it only ever writes whole chunks and
  // never reads one back to extend it.
  const firstSlot = Math.ceil(nextSlot / SLOTS_PER_CHUNK) * SLOTS_PER_CHUNK;

  const read = db.prepare(
    `SELECT mw, entry_id, ss_index0, ss_index1, ss_index2, ss_index3,
            ss_index4, ss_index5, ss_index6, ss_index7
       FROM ${source}
      WHERE (mw, entry_id) > (?, ?)
      ORDER BY mw, entry_id
      LIMIT ?`,
  );
  read.setReadBigInts?.(true);
  const writePlane = db.prepare(
    `INSERT OR REPLACE INTO ${PLANE_TABLE} (chunk, bit, bits) VALUES (?, ?, ?)`,
  );
  const writeSlot = db.prepare(
    `INSERT OR REPLACE INTO ${SLOT_TABLE} (slot, entry_id) VALUES (?, ?)`,
  );
  const bumpStat = db.prepare(
    `INSERT INTO ${BITSTAT_TABLE} (bit, population, stored) VALUES (?, ?, ?)
       ON CONFLICT(bit) DO UPDATE SET population = population + excluded.population`,
  );
  const dropTail = db.prepare(`DELETE FROM ${TAIL_TABLE} WHERE entry_id = ?`);

  let stored = storedBitsOf(db);
  const builder = new ChunkBuilder();
  let slot = firstSlot;
  let folded = 0;
  let chunks = 0;
  let cursor = { mw: -1e308, entryId: -1 };
  let pending = false;

  while (chunks < maxChunks) {
    const rows = read.all(cursor.mw, cursor.entryId, SLOTS_PER_CHUNK) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) break;

    builder.reset();
    const entryIds: number[] = [];
    for (const row of rows) {
      builder.add(bitsOfIndex(unpackSSIndex(row)));
      entryIds.push(Number(row.entry_id));
    }
    const populations = builder.populations();
    if (stored === null) {
      stored = decideStoredBits(
        db,
        populations,
        rows.length,
        maxPopulationRatio,
      );
    }

    const chunk = Math.floor(slot / SLOTS_PER_CHUNK);
    db.exec('BEGIN');
    try {
      for (const [bit, bits] of builder.entries(stored)) {
        writePlane.run(chunk, bit, bits);
      }
      for (const [offset, entryId] of entryIds.entries()) {
        writeSlot.run(slot + offset, entryId);
      }
      for (const [bit, population] of populations) {
        bumpStat.run(bit, population, stored.has(bit) ? 1 : 0);
      }
      if (source === TAIL_TABLE) {
        for (const entryId of entryIds) dropTail.run(entryId);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const last = rows.at(-1);
    cursor = {
      mw: Number(last?.mw ?? 0),
      entryId: Number(last?.entry_id ?? 0),
    };
    slot += rows.length;
    folded += rows.length;
    chunks++;
    onProgress?.(folded);
    if (rows.length < SLOTS_PER_CHUNK) break;
    pending = true;
  }

  if (folded > 0) {
    db.prepare(
      `INSERT INTO ${SEGMENT_TABLE} (first_slot, slot_count, mw_ordered)
       VALUES (?, ?, 1)`,
    ).run(firstSlot, folded);
    // The trigger has been filling the tail since the migration ran, so after a
    // seed from ocl_ss_index the tail holds rows that now have a slot.
    db.exec(
      `DELETE FROM ${TAIL_TABLE}
        WHERE EXISTS (SELECT 1 FROM ${SLOT_TABLE} s
                       WHERE s.entry_id = ${TAIL_TABLE}.entry_id)`,
    );
  }
  if (!pending) pending = countOf(db, TAIL_TABLE) > 0;

  return {
    folded,
    chunks,
    storedBits: stored?.size ?? 0,
    pending,
    elapsedMs: Date.now() - start,
  };
}
