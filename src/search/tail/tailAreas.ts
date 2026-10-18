import { PLANES, SLOTS } from '../../chemistry/tile.ts';
import type { Block, RowColumn } from '../blocks.ts';
import { alignRows, newBlock, rowColumns } from '../blocks.ts';
import { copyZones } from '../zones.ts';

import { lowerBound, ownTail } from './tailIndex.ts';
import type { TailBand, TailSegment } from './tailState.ts';
import type { TailStore } from './tailStore.ts';

/**
 * Gives a band an append area with room for one more row: a first one-word area, or, when its area
 * is full, a range twice its size the area moves to.
 * @param store - The tail store.
 * @param segment - The band's atom count.
 * @param band - The band.
 */
export function growArea(
  store: TailStore,
  segment: TailSegment,
  band: TailBand,
): void {
  const cap = band.ab < 0 ? 1 : 2 * band.cap;
  const [b, w0] = reserve(store, segment, cap);
  if (band.ab >= 0) {
    moveArea(store, segment, band, b, w0);
    store.moves++;
  }
  band.ab = b;
  band.aw = w0;
  band.cap = cap;
}

/**
 * Words of the segment's current append block, a new block (twice the last one's rows, up to a
 * block's) when they do not fit.
 * @param store - The tail store.
 * @param segment - The atom count.
 * @param words - The words wanted.
 * @returns The block and the first word.
 */
function reserve(
  store: TailStore,
  segment: TailSegment,
  words: number,
): [number, number] {
  const blocks = store.blocks;
  const blockRows = store.options.blockRows;
  const arena = segment.arena;
  if (
    arena < 0 ||
    segment.arenaUsed + words > (blocks[arena] as Block).capacity / SLOTS
  ) {
    const capacity = alignRows(
      Math.max(words * SLOTS, Math.min(blockRows, segment.arenaSize)),
    );
    store.bitmaps.ensure(store.rowSpace + capacity);
    blocks.push(
      newBlock(store.layout, segment.atoms, capacity, store.rowSpace, true),
    );
    store.rowSpace += capacity;
    segment.arena = blocks.length - 1;
    segment.arenaUsed = 0;
    segment.arenaSize = Math.min(blockRows, 2 * segment.arenaSize);
    store.pending.newBlocks.push(segment.arena);
  }
  const w0 = segment.arenaUsed;
  segment.arenaUsed += words;
  return [segment.arena, w0];
}

/**
 * Moves a full append area to [w0, w0 + its words) of block b: planes, zone map, columns, then
 * each row's bits and its seq index entry (rows this poll placed are indexed later, at their
 * final row). The old range stays as it was, for the versions still reading it.
 * @param store - The tail store.
 * @param segment - The band's atom count.
 * @param band - The band.
 * @param b - The new range's block.
 * @param w0 - Its first word.
 */
function moveArea(
  store: TailStore,
  segment: TailSegment,
  band: TailBand,
  b: number,
  w0: number,
): void {
  const from = store.viewsOf(band.ab);
  const to = store.viewsOf(b);
  const words = band.cap;
  for (let p = 0; p < PLANES; p++) {
    const at = p * from.W + band.aw;
    to.planes.set(from.planes.subarray(at, at + words), p * to.W + w0);
  }
  copyZones(from.zones, to.zones, band.aw, words, w0);
  const r0 = band.aw * SLOTS;
  const n = band.an;
  const sources = rowColumns(from);
  const targets = rowColumns(to);
  for (let j = 0; j < sources.length; j++) {
    (targets[j] as RowColumn).set(
      (sources[j] as RowColumn).subarray(r0, r0 + n),
      w0 * SLOTS,
    );
  }
  const g0 = (store.blocks[band.ab] as Block).start + r0;
  const h0 = (store.blocks[b] as Block).start + w0 * SLOTS;
  for (let i = 0; i < n; i++) store.bitmaps.copyRow(g0 + i, h0 + i);
  const count = segment.tail?.count ?? 0;
  for (let i = 0; i < n; i++) {
    const seq = from.seq[r0 + i] as number;
    const at = lowerBound(segment.tailSeqs, count, seq);
    if (at === count || segment.tailSeqs[at] !== seq) continue;
    ownTail(segment);
    new Int32Array((segment.tail as { buffer: SharedArrayBuffer }).buffer)[at] =
      h0 + i;
  }
}
