import type { SQLiteDatabase, SQLiteStatement } from '../types.ts';

import { CHUNK_BYTES, SLOTS_PER_CHUNK } from './planeLayout.ts';
import { PLANE_TABLE } from './planeSchema.ts';
import {
  andDense,
  andSparse,
  asWords,
  countWords,
  listLiveWords,
  slotsOf,
} from './planeWords.ts';

/** The 32-bit words of a full chunk of one plane. */
const CHUNK_WORDS = Math.ceil(CHUNK_BYTES / 4);

/**
 * Below this many survivors a chunk is intersected word by word over the
 * words that still hold one, instead of over all 32 768 of them.
 */
const SPARSE_SURVIVORS = 4096;

/**
 * A plane is worth reading in a chunk only while it removes at least this
 * many survivors there.
 *
 * Reading one chunk of one plane walks a 128 KB overflow chain: ~230 µs on a
 * 10 M-entry index. A survivor it would have removed costs ~4 µs instead,
 * when the exact 512-bit test rejects it as the slot is resolved. So a plane
 * pays for itself only past ~60 survivors removed, and the rest of the query's
 * bits are left to that test.
 */
const PAYING_ELIMINATION = 64;

/** A chunk's surviving slots, after as many planes as were worth reading. */
export interface ChunkSurvivors {
  /** The chunk these slots belong to. */
  chunk: number;
  /** The surviving slots, absolute and ascending. */
  slots: Uint32Array;
}

/**
 * Intersect the planes of the query's bits, one chunk at a time.
 *
 * This is the whole speed-up. The superset test `row & query == query` cannot
 * be sought in a b-tree, so the column form has to read every row's key.
 * Transposed, the query only reads the planes of the bits it sets, and an
 * `AND` of them answers for 2^20 molecules at a time.
 *
 * The planes are read one at a time, rarest bit first, and a chunk stops being
 * read as soon as it can no longer pay: when nothing survives, when too few
 * survive for another plane to remove its cost, or when two planes in a row
 * removed less than they cost to read. The survivors are therefore a superset
 * of the true candidates, and the exact 512-bit test that resolving a slot
 * applies is what makes the answer exact — it always was, since the fold keeps
 * no plane for the bits most molecules set.
 * @param db - The database to read.
 * @param bits - The query's bit positions, rarest first.
 * @param chunks - The chunks to scan, ascending.
 * @yields {ChunkSurvivors} Each chunk that left at least one slot.
 */
export function* intersectPlanes(
  db: SQLiteDatabase,
  bits: readonly number[],
  chunks: readonly number[],
): Generator<ChunkSurvivors> {
  if (bits.length === 0) return;
  const intersect = chunkIntersector(db, bits);
  for (const chunk of chunks) {
    const slots = intersect(chunk);
    if (slots !== null) yield { chunk, slots };
  }
}

/**
 * A function intersecting one chunk at a time, with its statement prepared
 * and its buffers allocated once.
 * @param db - The database to read.
 * @param bits - The query's bit positions, rarest first.
 * @returns The function: a chunk in, its surviving slots or null out.
 */
export function chunkIntersector(
  db: SQLiteDatabase,
  bits: readonly number[],
): (chunk: number) => Uint32Array | null {
  const select = db.prepare(
    `SELECT bits FROM ${PLANE_TABLE} WHERE chunk = ? AND bit = ?`,
  );
  const scratch = {
    accumulator: new Uint32Array(CHUNK_WORDS),
    plane: new Uint32Array(CHUNK_WORDS),
    live: new Int32Array(CHUNK_WORDS),
  };
  return (chunk) => intersectChunk(select, chunk, bits, scratch);
}

/** Buffers reused from one chunk to the next. */
interface Scratch {
  /** The running intersection, one bit per slot. */
  accumulator: Uint32Array;
  /** An aligned copy of a plane SQLite handed back unaligned. */
  plane: Uint32Array;
  /** The words of the accumulator that still hold a survivor. */
  live: Int32Array;
}

/**
 * Intersect one chunk's planes, as far as reading them pays.
 * @param select - Statement fetching one plane of one chunk.
 * @param chunk - The chunk to intersect.
 * @param bits - The query's bit positions, rarest first.
 * @param scratch - Buffers reused across chunks.
 * @returns The surviving slots, or null when none survived.
 */
function intersectChunk(
  select: SQLiteStatement,
  chunk: number,
  bits: readonly number[],
  scratch: Scratch,
): Uint32Array | null {
  const { accumulator, live } = scratch;
  let words = 0;
  let count = 0;
  let liveCount = -1;
  let idle = 0;

  for (let index = 0; index < bits.length; index++) {
    const blob = fetchPlane(select, chunk, bits[index] as number);
    // A bit with no row in this chunk is set by none of its molecules, so no
    // molecule here can be a superstructure: the whole chunk is out.
    if (blob === undefined) return null;
    const plane = asWords(blob, scratch.plane);
    const previous = count;

    if (index === 0) {
      words = plane.length;
      accumulator.set(plane);
      count = countWords(accumulator, words);
    } else if (liveCount < 0) {
      words = Math.min(words, plane.length);
      count = andDense(accumulator, plane, words);
    } else {
      [liveCount, count] = andSparse(accumulator, plane, live, liveCount);
    }

    if (count === 0) return null;
    if (count <= PAYING_ELIMINATION) break;
    if (index > 0) {
      idle = previous - count < PAYING_ELIMINATION ? idle + 1 : 0;
      if (idle >= 2) break;
    }
    if (liveCount < 0 && count <= SPARSE_SURVIVORS) {
      liveCount = listLiveWords(accumulator, words, live);
    }
  }

  return slotsOf(
    accumulator,
    liveCount < 0 ? null : live.subarray(0, liveCount),
    words,
    chunk * SLOTS_PER_CHUNK,
    count,
  );
}

/**
 * Read one chunk of one plane.
 * @param select - Statement fetching one plane of one chunk.
 * @param chunk - The chunk.
 * @param bit - The bit.
 * @returns The plane, or undefined when no entry of the chunk sets the bit.
 */
function fetchPlane(
  select: SQLiteStatement,
  chunk: number,
  bit: number,
): Uint8Array | undefined {
  const row = select.get(chunk, bit) as { bits: Uint8Array } | undefined;
  return row?.bits;
}
