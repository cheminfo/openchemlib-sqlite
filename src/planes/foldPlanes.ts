import type { SQLiteDatabase } from '../types.ts';
import { unpackSSIndex } from '../utils/packSSIndex.ts';

import { ChunkBuilder } from './ChunkBuilder.ts';
import type { FoldSource } from './foldRead.ts';
import { buildFoldReadSql } from './foldRead.ts';
import {
  beginFold,
  finishFold,
  fitsOneChunk,
  hasEntriesAbove,
  readFoldState,
} from './foldState.ts';
import { SLOTS_PER_CHUNK, bitsOfIndex } from './planeLayout.ts';
import { PLANE_TABLE, SLOT_TABLE } from './planeSchema.ts';
import { decideStoredBits, nextSlotOf, storedBitsOf } from './planeState.ts';
import { resetPlanes } from './resetPlanes.ts';
import {
  buildSlotWriteSql,
  publishChunk,
  writeChunkData,
} from './writeChunk.ts';

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
   * Decided on the first fold, and kept until a `rebuild`: a bit stored for some
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
  /**
   * Milliseconds to pause between the fold's transactions.
   *
   * A fold is a writer, so it competes for the write lock with whatever is
   * inserting. Its transactions are already short enough not to stall a service
   * sharing the file, and this leaves gaps between them as well — the knob for
   * folding in the background without the live side noticing. 50 ms roughly
   * halves a fold's share of the lock.
   * @default 0
   */
  pauseMs?: number;
  /**
   * Empty the plane index first, and fold every entry again.
   *
   * A chunk is never rewritten, so an entry folded again after a write below
   * the watermark leaves its old bits behind, answering nothing but still read.
   * Rebuilding reclaims them, and is the only way to change
   * `maxPopulationRatio`. Until it completes every search takes the column path.
   * @default false
   */
  rebuild?: boolean;
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
 * Fold the entries above the watermark into the plane index.
 *
 * This is the whole maintenance story. Setting one molecule's bits in place
 * would rewrite a chunk of each of the 74–348 planes it sets, so nothing is ever
 * written per insert, and a fold later appends a batch as whole new chunks. One
 * chunk carries 2^20 molecules, so the write comes to 64 bytes per molecule —
 * the size of the fingerprint itself, which is the least it could be.
 *
 * What waits is found without being copied anywhere: it is every entry above
 * the watermark, read through `ocl_ss_index` itself. When the fold completes,
 * the watermark moves to the highest id it covered, unless a write the triggers
 * caught while it ran keeps it below that entry.
 *
 * A fold reads in `(mw, entry_id)` order, so **every segment is internally
 * ascending by molecular weight**. It records its cursor with each chunk it
 * publishes, so a fold split over several calls by `maxChunks`, or interrupted,
 * resumes where it stopped and extends the same segment. One fold at a time:
 * two running at once on the same file would share that cursor.
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
    pauseMs = 0,
    rebuild = false,
  } = options;
  const start = Date.now();
  if (rebuild) resetPlanes(db);

  let state = readFoldState(db);
  if (state.cursor === null) state = beginFold(db) ?? state;
  if (state.cursor === null || state.bound === null) {
    return {
      folded: 0,
      chunks: 0,
      storedBits: storedBitsOf(db)?.size ?? 0,
      pending: false,
      elapsedMs: Date.now() - start,
    };
  }

  const after = state.watermark;
  const source: FoldSource = {
    after,
    through: state.bound,
    indexed: after !== null && fitsOneChunk(db, after, state.bound),
  };
  const writePlane = db.prepare(
    `INSERT OR REPLACE INTO ${PLANE_TABLE} (chunk, bit, bits) VALUES (?, ?, ?)`,
  );
  const writeSlot = db.prepare(buildSlotWriteSql(SLOT_TABLE));

  let stored = storedBitsOf(db);
  const builder = new ChunkBuilder();
  // A fold starts on a chunk boundary so it only ever writes whole chunks and
  // never reads one back to extend it. A resumed fold is on one already: every
  // chunk it published was full, or it would have finished.
  let slot = Math.ceil(nextSlotOf(db) / SLOTS_PER_CHUNK) * SLOTS_PER_CHUNK;
  let { cursor, segment } = state;
  let folded = 0;
  let chunks = 0;
  let finished = false;

  while (chunks < maxChunks) {
    // A write the triggers caught since the last page has lowered the bound:
    // what lies above it is left to the next fold rather than folded for
    // nothing.
    source.through = Math.min(
      source.through,
      readFoldState(db).bound ?? source.through,
    );
    const page = buildFoldReadSql(source, cursor, SLOTS_PER_CHUNK);
    const read = db.prepare(page.sql);
    read.setReadBigInts?.(true);
    const rows = read.all(...(page.params as never[])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) {
      finishFold(db);
      finished = true;
      break;
    }

    builder.reset();
    const entryIds: number[] = [];
    for (const row of rows) {
      builder.add(bitsOfIndex(unpackSSIndex(row)));
      entryIds.push(Number(row.entry_id));
    }
    const populations = builder.populations();
    stored ??= decideStoredBits(
      db,
      populations,
      rows.length,
      maxPopulationRatio,
    );

    const last = rows.at(-1);
    cursor = {
      mw: Number(last?.mw ?? 0),
      entryId: Number(last?.entry_id ?? 0),
    };
    finished = rows.length < SLOTS_PER_CHUNK;

    // Written first and published second: until the segment covers it, no
    // search can see this chunk, so an interruption costs the chunk rather than
    // the correctness of every query that touches it.
    writeChunkData({
      db,
      chunk: Math.floor(slot / SLOTS_PER_CHUNK),
      firstSlot: slot,
      entryIds,
      builder,
      stored,
      writePlane,
      writeSlot,
      pauseMs,
    });
    segment = publishChunk(db, segment, {
      firstSlot: slot,
      slots: rows.length,
      populations,
      stored,
      cursor: finished ? null : cursor,
    });

    slot += rows.length;
    folded += rows.length;
    chunks++;
    onProgress?.(folded);
    if (finished) break;
  }

  return {
    folded,
    chunks,
    storedBits: stored?.size ?? 0,
    pending: !finished || hasEntriesAbove(db, readFoldState(db).watermark),
    elapsedMs: Date.now() - start,
  };
}
