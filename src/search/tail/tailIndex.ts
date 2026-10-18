import { SEQ_SPAN } from '../../chemistry/key.ts';
import { SLOTS } from '../../chemistry/tile.ts';
import type { Block } from '../blocks.ts';

import type { TailBand, TailSegment } from './tailState.ts';
import type { TailStore } from './tailStore.ts';

/**
 * The band holding a row, through its runs and append areas.
 * @param store - The tail store.
 * @param segment - Its atom count.
 * @param g - The row.
 * @returns The band, or undefined.
 */
export function bandOfRow(
  store: TailStore,
  segment: TailSegment,
  g: number,
): TailBand | undefined {
  for (const band of segment.bands.values()) {
    for (const [b, w0, w1] of band.runs) {
      const start = (store.blocks[b] as Block).start;
      if (g >= start + w0 * SLOTS && g < start + w1 * SLOTS) return band;
    }
    if (band.ab >= 0) {
      const start = (store.blocks[band.ab] as Block).start + band.aw * SLOTS;
      if (g >= start && g < start + band.an) return band;
    }
  }
  return undefined;
}

/**
 * The rows a poll placed in a segment, in seq order (all above the rows already indexed), at the
 * end of its tail index.
 * @param store - The tail store.
 * @param segment - The segment.
 */
export function indexRows(store: TailStore, segment: TailSegment): void {
  const placed = segment.placed;
  if (placed.length === 0) return;
  placed.sort((a, b) => a.seq - b.seq);
  const count = segment.tail?.count ?? 0;
  if (segment.tail === null || count + placed.length > segment.tailCapacity) {
    const capacity = Math.max(
      1024,
      2 * segment.tailCapacity,
      count + placed.length,
    );
    const buffer = new SharedArrayBuffer(4 * capacity);
    if (segment.tail !== null) {
      new Int32Array(buffer).set(new Int32Array(segment.tail.buffer, 0, count));
    }
    const seqs = new Uint32Array(capacity);
    seqs.set(segment.tailSeqs.subarray(0, count));
    segment.tail = { buffer, count };
    segment.tailSeqs = seqs;
    segment.tailCapacity = capacity;
    segment.tailOwned = true;
  }
  // Rows past the published count are read by no version yet: written in place.
  const tail = segment.tail;
  const index = new Int32Array(tail.buffer);
  for (const { seq, band, at } of placed) {
    index[tail.count] =
      (store.blocks[band.ab] as Block).start + band.aw * SLOTS + at;
    segment.tailSeqs[tail.count++] = seq;
  }
  segment.placed = [];
}

/**
 * The row of an id through its atom count's seq index: the loaded rows, then the tail's.
 * @param store - The tail store.
 * @param id - The id.
 * @returns The row, or -1.
 */
export function locateRow(store: TailStore, id: number): number {
  const atoms = Math.floor(id / SEQ_SPAN);
  const seq = id - atoms * SEQ_SPAN;
  const segment = store.segments.get(atoms);
  if (segment === undefined) return -1;
  if (segment.index !== null && segment.indexCount > 0) {
    const index = new Int32Array(segment.index, 0, segment.indexCount);
    let lo = 0;
    let hi = segment.indexCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (seqAt(store, index[mid] as number) < seq) lo = mid + 1;
      else hi = mid;
    }
    if (lo < segment.indexCount && seqAt(store, index[lo] as number) === seq) {
      return index[lo] as number;
    }
  }
  const count = segment.tail?.count ?? 0;
  const at = lowerBound(segment.tailSeqs, count, seq);
  if (at < count && segment.tailSeqs[at] === seq) {
    return new Int32Array(
      (segment.tail as { buffer: SharedArrayBuffer }).buffer,
    )[at] as number;
  }
  return -1;
}

/**
 * The block and the row in it of a row of the row space.
 * @param store - The tail store.
 * @param g - The row.
 * @returns Its block and its row there.
 */
export function rowAt(store: TailStore, g: number): { b: number; r: number } {
  const { blocks } = store;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((blocks[mid] as Block).start <= g) lo = mid;
    else hi = mid - 1;
  }
  return { b: lo, r: g - (blocks[lo] as Block).start };
}

function seqAt(store: TailStore, g: number): number {
  const { b, r } = rowAt(store, g);
  return store.viewsOf(b).seq[r] as number;
}

/**
 * The segment's tail index, copied once per poll before it is changed in place.
 * @param segment - The segment.
 */
export function ownTail(segment: TailSegment): void {
  if (segment.tailOwned || segment.tail === null) return;
  const buffer = new SharedArrayBuffer(4 * segment.tailCapacity);
  new Int32Array(buffer).set(
    new Int32Array(segment.tail.buffer, 0, segment.tail.count),
  );
  segment.tail = { buffer, count: segment.tail.count };
  segment.tailOwned = true;
}

/**
 * The first position of a sorted list holding at least a value.
 * @param values - The list.
 * @param count - Its length.
 * @param value - The value.
 * @returns The position.
 */
export function lowerBound(
  values: Uint32Array,
  count: number,
  value: number,
): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((values[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
