import type { SQLiteDatabase, SQLiteStatement } from '../types.ts';

import type { ChunkBuilder } from './ChunkBuilder.ts';
import type { FoldCursor } from './foldState.ts';
import { finishFold, saveFoldProgress } from './foldState.ts';
import { BITSTAT_TABLE, SEGMENT_TABLE } from './planeSchema.ts';

/**
 * Slot rows written per transaction.
 *
 * A chunk carries 2^20 entries, and writing them under one lock held it for
 * seconds — long enough to stall the inserts of a live service sharing the file.
 * These are invisible to a search until the segment is extended, so they can be
 * committed in as many pieces as we like.
 */
const SLOT_BATCH = 10_000;

/** Plane blobs written per transaction: 32 full ones is about 4 MB. */
const PLANE_BATCH = 32;

/** Where a fold is writing, and how hard it is allowed to push. */
export interface ChunkWrite {
  db: SQLiteDatabase;
  /** The chunk being written. */
  chunk: number;
  /** The slot the chunk's first entry takes. */
  firstSlot: number;
  /** The entries of the chunk, in slot order. */
  entryIds: readonly number[];
  /** The planes built for the chunk. */
  builder: ChunkBuilder;
  /** The bits the index keeps planes for. */
  stored: ReadonlySet<number>;
  writePlane: SQLiteStatement;
  /**
   * Writes a slot, given the slot, the entry id, and the entry id again: the
   * statement {@link buildSlotWriteSql} builds.
   */
  writeSlot: SQLiteStatement;
  /**
   * Milliseconds to pause between transactions, leaving the write lock free.
   * @default 0
   */
  pauseMs?: number;
}

/**
 * Write a chunk's planes and slots, in transactions short enough to share the
 * database with a running service.
 *
 * Nothing written here is visible to a search: a search takes its chunk list
 * from the segments, and this chunk is not covered by one until
 * {@link publishChunk} extends it. So an interrupted fold leaves rows that no
 * query can reach and the next fold overwrites, rather than a half-built chunk
 * that silently answers with false negatives.
 * @param write - Where to write, and how hard to push.
 */
export function writeChunkData(write: ChunkWrite): void {
  const {
    db,
    chunk,
    firstSlot,
    entryIds,
    builder,
    stored,
    writePlane,
    writeSlot,
    pauseMs,
  } = write;

  const planes = [...builder.entries(stored)];
  for (let from = 0; from < planes.length; from += PLANE_BATCH) {
    const batch = planes.slice(from, from + PLANE_BATCH);
    inTransaction(db, () => {
      for (const [bit, bits] of batch) writePlane.run(chunk, bit, bits);
    });
    pause(pauseMs);
  }

  for (let from = 0; from < entryIds.length; from += SLOT_BATCH) {
    const until = Math.min(from + SLOT_BATCH, entryIds.length);
    inTransaction(db, () => {
      for (let index = from; index < until; index++) {
        const entryId = entryIds[index];
        writeSlot.run(firstSlot + index, entryId, entryId);
      }
    });
    pause(pauseMs);
  }
}

/**
 * SQL writing one slot, unless its entry has left `ocl_ss_index` since the fold
 * read it.
 *
 * Its transaction is not the one the fold read in, so an entry can be removed
 * between the two. Written anyway, the slot would stand for an entry that is
 * gone, and an id given to a new entry later would be taken for one the planes
 * already hold. Removed after the slot is written, the delete trigger takes the
 * slot with it.
 * @param slotTable - The slot table.
 * @returns SQL taking the slot, the entry id and the entry id again.
 */
export function buildSlotWriteSql(slotTable: string): string {
  return `INSERT OR REPLACE INTO ${slotTable} (slot, entry_id)
          SELECT ?, ? WHERE EXISTS
            (SELECT 1 FROM ocl_ss_index WHERE entry_id = ?)`;
}

/**
 * Make a written chunk visible, in one short transaction.
 *
 * This is the only write of a fold that a search can observe, so it carries
 * everything that must not be seen before the chunk is whole: the segment the
 * chunk belongs to, the bit populations the router reads, and the fold's
 * progress — or, for its last chunk, the watermark it moves.
 *
 * The populations are bumped here, not while the planes are written, so a chunk
 * that is interrupted and redone does not count its bits twice.
 * @param db - The database to write.
 * @param segment - The segment to extend, or null to start one.
 * @param info - The slots added, the populations seen, and where the fold is.
 * @param info.firstSlot - The slot the chunk's first entry took.
 * @param info.slots - How many slots the chunk added.
 * @param info.populations - How many of the chunk's entries set each bit.
 * @param info.stored - The bits the index keeps planes for.
 * @param info.cursor - The chunk's last row, or null when it ends the fold.
 * @returns The segment the chunk now belongs to.
 */
export function publishChunk(
  db: SQLiteDatabase,
  segment: number | null,
  info: {
    firstSlot: number;
    slots: number;
    populations: ReadonlyMap<number, number>;
    stored: ReadonlySet<number>;
    cursor: FoldCursor | null;
  },
): number {
  let id = segment;
  inTransaction(db, () => {
    if (id === null) {
      const inserted = db
        .prepare(
          `INSERT INTO ${SEGMENT_TABLE} (first_slot, slot_count, mw_ordered)
           VALUES (?, ?, 1)`,
        )
        .run(info.firstSlot, info.slots);
      id = Number(inserted.lastInsertRowid);
    } else {
      db.prepare(
        `UPDATE ${SEGMENT_TABLE} SET slot_count = slot_count + ?
          WHERE segment = ?`,
      ).run(info.slots, id);
    }

    const bump = db.prepare(
      `INSERT INTO ${BITSTAT_TABLE} (bit, population, stored) VALUES (?, ?, ?)
         ON CONFLICT(bit) DO UPDATE SET population = population + excluded.population`,
    );
    for (const [bit, population] of info.populations) {
      bump.run(bit, population, info.stored.has(bit) ? 1 : 0);
    }

    if (info.cursor === null) {
      finishFold(db);
    } else {
      saveFoldProgress(db, info.cursor, id);
    }
  });
  return id as number;
}

/**
 * Run a unit of work in a transaction, rolling back on anything thrown.
 * @param db - The database to write.
 * @param work - What to do inside it.
 */
export function inTransaction(db: SQLiteDatabase, work: () => void): void {
  db.exec('BEGIN');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Block this thread for a moment, so another writer can take the lock.
 *
 * `node:sqlite` is synchronous, so a fold cannot yield the way an async job
 * would; what it can do is stop asking for the lock. A fold sharing its database
 * with a live service sets this, and the service's inserts land in the gaps.
 * @param ms - How long to wait; nothing happens for 0 or less.
 */
function pause(ms = 0): void {
  if (ms <= 0) return;
  // Atomics.wait on a throwaway buffer is the only sleep available to a
  // synchronous thread, and it works in a worker as well as the main one.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
