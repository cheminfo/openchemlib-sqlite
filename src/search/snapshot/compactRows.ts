import { SLOTS } from '../../chemistry/tile.ts';
import type { Layout } from '../layout.ts';
import type { Segment } from '../layoutTypes.ts';

import { indexCountOf } from './compaction.ts';
import type { Compaction } from './compactionTypes.ts';

/**
 * The alive rows the snapshot holds.
 * @param layout - The image.
 * @param compaction - Where its words go.
 * @returns Their count.
 */
export function aliveRows(layout: Layout, compaction: Compaction): number {
  const alive = new Int32Array(layout.alive);
  const { wordMap } = compaction;
  let rows = 0;
  for (let w = 0; w < wordMap.length; w++) {
    if ((wordMap[w] as number) < 0) continue;
    let bits = (alive[w] as number) >>> 0;
    while (bits !== 0) {
      bits &= bits - 1;
      rows++;
    }
  }
  return rows;
}

/**
 * A segment's seq index: its loaded rows then its tail's, in the snapshot's row space.
 * @param segment - The image's segment.
 * @param compaction - Where its words go.
 * @returns Its index section.
 */
export function indexBytes(
  segment: Segment,
  compaction: Compaction,
): Uint8Array {
  const count = indexCountOf(segment);
  if (compaction.identity && segment.index !== null) {
    return new Uint8Array(segment.index, 0, 4 * Math.max(1, count));
  }
  const { wordMap } = compaction;
  const index = new Int32Array(Math.max(1, count));
  let at = 0;
  const lists: Array<[SharedArrayBuffer | null, number]> = [
    [segment.index, segment.indexCount],
    [segment.tail?.buffer ?? null, segment.tail?.count ?? 0],
  ];
  for (const [buffer, n] of lists) {
    if (buffer === null) continue;
    const rows = new Int32Array(buffer, 0, n);
    for (let i = 0; i < n; i++) {
      const g = rows[i] as number;
      const word = wordMap[g >>> 5] ?? -1;
      if (word < 0) throw new Error(`row ${g} has no place in the snapshot`);
      index[at++] = word * SLOTS + (g & 31);
    }
  }
  return new Uint8Array(index.buffer);
}

/**
 * A bitmap over the snapshot's row space.
 * @param bitmap - The image's bitmap.
 * @param compaction - Where its words go.
 * @returns Its section.
 */
export function bitmapBytes(
  bitmap: SharedArrayBuffer,
  compaction: Compaction,
): Uint8Array {
  const { identity, rowSpaceCapacity, wordMap, masks } = compaction;
  if (identity) return new Uint8Array(bitmap, 0, rowSpaceCapacity / 8);
  const source = new Int32Array(bitmap);
  const target = new Int32Array(rowSpaceCapacity / SLOTS);
  for (let w = 0; w < wordMap.length; w++) {
    const to = wordMap[w] as number;
    if (to >= 0) target[to] = source[w] as number;
  }
  for (const [word, rows] of masks) {
    target[word] = (target[word] as number) & lowBits(rows);
  }
  return new Uint8Array(target.buffer);
}

/**
 * The bits of a word's first rows.
 * @param rows - How many, 1 to 32.
 * @returns The mask.
 */
export function lowBits(rows: number): number {
  return rows >= SLOTS ? -1 : 2 ** rows - 1;
}
