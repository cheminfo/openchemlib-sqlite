import type { SQLiteDatabase } from '../types.ts';

import { chunkIntersector } from './planeIntersect.ts';

/** Every surviving slot of an intersection, or the news that there are too many. */
export interface Survivors {
  /** The surviving slots, ascending; empty when the limit stopped the count. */
  slots: Uint32Array;
  /** How many survived, or how many were found before the limit stopped it. */
  count: number;
  /** True when the count passed the limit and the intersection stopped. */
  exceeded: boolean;
}

/**
 * How far past the limit the survivors seen so far must project before the
 * collection gives up early. A projection errs both ways, so a query is only
 * declined on it when the total is well past what the plane path accepts.
 */
const PROJECTED_EXCESS = 1.5;

/**
 * Collect every surviving slot, unless there turn out to be more than a limit.
 *
 * Collecting is the plane path's first step and deciding is its byproduct: the
 * router stops as soon as the count passes what the plane path accepts, so a
 * query it declines costs part of an intersection, and a query it takes is
 * never intersected twice.
 *
 * Chunks are read in an order spread over the whole index — first, middle,
 * quarters, eighths — because a segment is sorted by weight and survivors
 * crowd into the chunks of the weights a fragment matches. A few chunks so
 * read are then a fair sample, and once their survivors project well past the
 * limit the query is declined without reading the rest.
 * @param db - The database to read.
 * @param bits - The query's bit positions, rarest first.
 * @param chunks - The chunks to scan, ascending.
 * @param limit - Stop once more than this many slots have survived.
 * @returns The slots, or how many were found when the limit stopped it.
 */
export function collectSurvivors(
  db: SQLiteDatabase,
  bits: readonly number[],
  chunks: readonly number[],
  limit: number = Number.MAX_SAFE_INTEGER,
): Survivors {
  if (bits.length === 0) {
    return { slots: new Uint32Array(0), count: 0, exceeded: false };
  }
  const intersect = chunkIntersector(db, bits);
  const order = spreadOrder(chunks.length);
  const sample = Math.max(2, Math.ceil(chunks.length / 16));
  const parts: Array<Uint32Array | null> = new Array(chunks.length).fill(null);
  let count = 0;
  for (let read = 0; read < order.length; read++) {
    const index = order[read] as number;
    const slots = intersect(chunks[index] as number);
    parts[index] = slots;
    count += slots?.length ?? 0;
    const projected =
      read + 1 >= sample ? (count * chunks.length) / (read + 1) : 0;
    if (count > limit || projected > PROJECTED_EXCESS * limit) {
      return { slots: new Uint32Array(0), count, exceeded: true };
    }
  }
  const slots = new Uint32Array(count);
  let offset = 0;
  for (const part of parts) {
    if (part === null) continue;
    slots.set(part, offset);
    offset += part.length;
  }
  return { slots, count, exceeded: false };
}

/**
 * Positions 0 … n-1 in an order spread over the range: 0, then the multiples
 * of each halving step not yet taken.
 * @param n - How many positions.
 * @returns The positions, each once.
 */
function spreadOrder(n: number): number[] {
  const order: number[] = [];
  const taken = new Uint8Array(n);
  let step = 1;
  while (step < n) step *= 2;
  for (; step >= 1; step /= 2) {
    for (let position = 0; position < n; position += step) {
      if (taken[position] === 1) continue;
      taken[position] = 1;
      order.push(position);
    }
  }
  return order;
}
