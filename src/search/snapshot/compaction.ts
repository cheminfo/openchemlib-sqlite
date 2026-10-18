import { SLOTS } from '../../chemistry/tile.ts';
import type { Block } from '../blocks.ts';
import { alignRows } from '../blocks.ts';
import type { Layout } from '../layout.ts';
import type { Run, Segment } from '../layoutTypes.ts';
import { bandRecord } from '../layoutTypes.ts';

import type {
  CompactBlock,
  CompactSegment,
  Compaction,
  CompactionSizes,
  Fragment,
} from './compactionTypes.ts';

/** Words of the image one band holds: a main run, or its append area. */
interface Piece {
  /** The band's position in its segment. */
  band: number;
  from: number;
  fromWord: number;
  words: number;
  lastRows: number;
}

/**
 * Lays an image out as a load would: per atom count, its bands in order, each band's main words
 * then its append area's, in blocks of `blockRows` rows at most. Append areas moved by the tail
 * leave their old ranges behind: those are left out.
 * @param layout - The image, holding still.
 * @param sizes - Rows per block at most, and the bitmaps' headroom.
 * @returns Where every word goes.
 */
export function compact(layout: Layout, sizes: CompactionSizes): Compaction {
  const blockWords = Math.max(1, Math.floor(sizes.blockRows / SLOTS));
  const blocks: CompactBlock[] = [];
  const segments: CompactSegment[] = [];
  const masks: Array<[number, number]> = [];
  let rowSpace = 0;
  for (const segment of layout.segments) {
    const pieces = piecesOf(segment);
    let left = 0;
    for (const piece of pieces) left += piece.words;
    const runs: Run[][] = segment.bands.map(() => []);
    let block: CompactBlock | null = null;
    let used = 0;
    for (const piece of pieces) {
      for (let done = 0; done < piece.words;) {
        if (block === null || used === block.capacity / SLOTS) {
          const capacity = Math.min(blockWords, left) * SLOTS;
          block = {
            capacity,
            start: rowSpace,
            atoms: segment.atoms,
            fragments: [],
            same: -1,
          };
          blocks.push(block);
          rowSpace += capacity;
          used = 0;
        }
        const take = Math.min(
          piece.words - done,
          block.capacity / SLOTS - used,
        );
        const lastRows = done + take === piece.words ? piece.lastRows : SLOTS;
        addFragment(block.fragments, {
          from: piece.from,
          fromWord: piece.fromWord + done,
          toWord: used,
          words: take,
          lastRows,
        });
        if (lastRows < SLOTS) {
          masks.push([block.start / SLOTS + used + take - 1, lastRows]);
        }
        addRun(runs[piece.band] as Run[], blocks.length - 1, used, used + take);
        done += take;
        used += take;
        left -= take;
      }
    }
    segments.push({
      atoms: segment.atoms,
      bands: segment.bands.map((band, i) =>
        bandRecord(
          band.band,
          runs[i] as Run[],
          band.zmin,
          band.zmax,
          band.rows,
          -1,
          0,
          0,
        ),
      ),
      source: segment,
    });
  }
  if (rowSpace >= 2 ** 31) {
    throw new Error(`${rowSpace} rows: the image holds at most 2^31 - 1`);
  }
  markSame(layout, blocks);
  const identity = isIdentity(layout, blocks, segments);
  const headroom = Math.max(
    sizes.headroomRows,
    Math.ceil(rowSpace * sizes.headroomShare),
  );
  return {
    blocks,
    segments,
    wordMap: mapWords(layout, blocks),
    masks,
    rowSpace,
    rowSpaceCapacity: identity
      ? layout.rowSpaceCapacity
      : alignRows(Math.min(2 ** 31 - 1, rowSpace + headroom)),
    identity,
  };
}

/**
 * The rows a segment's index lists: the loaded rows, then the tail's.
 * @param segment - The segment.
 * @returns Their count.
 */
export function indexCountOf(segment: Segment): number {
  return segment.indexCount + (segment.tail?.count ?? 0);
}

function piecesOf(segment: Segment): Piece[] {
  const pieces: Piece[] = [];
  for (const [i, band] of segment.bands.entries()) {
    for (const [b, w0, w1] of band.runs) {
      pieces.push({
        band: i,
        from: b,
        fromWord: w0,
        words: w1 - w0,
        lastRows: SLOTS,
      });
    }
    if (band.ab >= 0 && band.an > 0) {
      pieces.push({
        band: i,
        from: band.ab,
        fromWord: band.aw,
        words: Math.ceil(band.an / SLOTS),
        lastRows: band.an % SLOTS || SLOTS,
      });
    }
  }
  return pieces;
}

/**
 * Appends a fragment, merged into the last one when it continues it in both blocks.
 * @param fragments - A block's fragments.
 * @param fragment - The next one.
 */
function addFragment(fragments: Fragment[], fragment: Fragment): void {
  const last = fragments.at(-1);
  if (
    last?.from === fragment.from &&
    last.lastRows === SLOTS &&
    last.fromWord + last.words === fragment.fromWord &&
    last.toWord + last.words === fragment.toWord
  ) {
    last.words += fragment.words;
    last.lastRows = fragment.lastRows;
    return;
  }
  fragments.push(fragment);
}

function addRun(runs: Run[], block: number, w0: number, w1: number): void {
  const last = runs.at(-1);
  if (last?.[0] === block && last[2] === w0) {
    last[2] = w1;
    return;
  }
  runs.push([block, w0, w1]);
}

/**
 * Marks the blocks that are a whole block of the image, unchanged: they are written as they are.
 * @param layout - The image.
 * @param blocks - The snapshot's blocks.
 */
function markSame(layout: Layout, blocks: CompactBlock[]): void {
  for (const block of blocks) {
    const only = block.fragments[0];
    if (block.fragments.length !== 1 || only === undefined) continue;
    const source = layout.blocks[only.from] as Block;
    if (
      only.fromWord === 0 &&
      only.toWord === 0 &&
      only.words * SLOTS === block.capacity &&
      only.lastRows === SLOTS &&
      source.capacity === block.capacity
    ) {
      block.same = only.from;
    }
  }
}

function isIdentity(
  layout: Layout,
  blocks: CompactBlock[],
  segments: CompactSegment[],
): boolean {
  if (blocks.length !== layout.blocks.length) return false;
  for (const [b, block] of blocks.entries()) {
    if (block.same !== b || (layout.blocks[b] as Block).start !== block.start) {
      return false;
    }
  }
  for (const segment of segments) {
    if ((segment.source.tail?.count ?? 0) > 0) return false;
  }
  return true;
}

function mapWords(layout: Layout, blocks: CompactBlock[]): Int32Array {
  const wordMap = new Int32Array(Math.ceil(layout.rowSpace / SLOTS)).fill(-1);
  for (const block of blocks) {
    for (const fragment of block.fragments) {
      const from =
        (layout.blocks[fragment.from] as Block).start / SLOTS +
        fragment.fromWord;
      const to = block.start / SLOTS + fragment.toWord;
      for (let k = 0; k < fragment.words; k++) wordMap[from + k] = to + k;
    }
  }
  return wordMap;
}
