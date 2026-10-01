import type { SQLiteDatabase, SQLiteStatement } from '../types.ts';

import { CHUNK_BYTES, countBits } from './planeLayout.ts';
import { PLANE_TABLE } from './planeSchema.ts';

/** A chunk's surviving slots, as the bitmap the intersection produced. */
export interface ChunkSurvivors {
  /** The chunk these slots belong to. */
  chunk: number;
  /** One bit per slot of the chunk, set when the slot survived. */
  bits: Uint8Array;
  /** Meaningful bytes of {@link ChunkSurvivors.bits}. */
  length: number;
  /** How many slots survived. */
  count: number;
}

/**
 * Intersect the planes of the query's bits, one chunk at a time.
 *
 * This is the whole speed-up. The superset test `row & query == query` cannot
 * be sought in a b-tree, so the column form has to read every row's key: ~12 GB
 * at 150 M entries, measured at 15.9 Mrow/s, or about 9 s. Transposed, the query
 * only reads the planes of the bits it actually sets — 3 to 21 of 512 for real
 * fragments — and an `AND` of `k` plane chunks answers for 2^20 molecules at a
 * time.
 *
 * The bits arrive rarest first, so the accumulator usually empties after two or
 * three of them and the rest of the chunk's planes are never read: that early
 * abandon is what took a 20-bit query at 150 M from 255 ms to 92 ms.
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
  const select = db.prepare(
    `SELECT bit, bits FROM ${PLANE_TABLE} WHERE chunk = ? AND bit IN (${bits
      .map(() => '?')
      .join(',')})`,
  );
  const accumulator = new Uint8Array(CHUNK_BYTES);

  for (const chunk of chunks) {
    const survivors = intersectChunk(select, chunk, bits, accumulator);
    if (survivors !== null) yield survivors;
  }
}

/**
 * Intersect one chunk's planes.
 * @param select - Statement fetching a chunk's planes by bit.
 * @param chunk - The chunk to intersect.
 * @param bits - The query's bit positions, rarest first.
 * @param accumulator - Scratch buffer, reused across chunks.
 * @returns The surviving slots, or null when none survived.
 */
function intersectChunk(
  select: SQLiteStatement,
  chunk: number,
  bits: readonly number[],
  accumulator: Uint8Array,
): ChunkSurvivors | null {
  const planes = new Map<number, Uint8Array>();
  for (const row of select.all(chunk, ...bits) as Array<
    Record<string, unknown>
  >) {
    planes.set(Number(row.bit), row.bits as Uint8Array);
  }
  // A bit with no row in this chunk is set by none of its molecules, so no
  // molecule here can be a superstructure: the whole chunk is out.
  if (planes.size !== bits.length) return null;

  let length = CHUNK_BYTES;
  for (const plane of planes.values()) {
    length = Math.min(length, plane.length);
  }

  const first = planes.get(bits[0] as number) as Uint8Array;
  accumulator.set(first.subarray(0, length));
  for (let index = 1; index < bits.length; index++) {
    const plane = planes.get(bits[index] as number) as Uint8Array;
    let any = 0;
    for (let byte = 0; byte < length; byte++) {
      const value = (accumulator[byte] as number) & (plane[byte] as number);
      accumulator[byte] = value;
      any |= value;
    }
    // Nothing left: the remaining planes of this chunk are never read.
    if (any === 0) return null;
  }

  const count = countBits(accumulator, length);
  if (count === 0) return null;
  return { chunk, bits: accumulator, length, count };
}
