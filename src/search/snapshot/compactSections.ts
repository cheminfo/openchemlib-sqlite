/* eslint-disable no-await-in-loop -- sections are written in order, one chunk at a time */
import { PLANES, SLOTS } from '../../chemistry/tile.ts';
import type { Block, RowColumn } from '../blocks.ts';
import { blockViews, rowColumns } from '../blocks.ts';
import type { Layout } from '../layout.ts';
import { copyZones } from '../zones.ts';

import { bitmapBytes, indexBytes, lowBits } from './compactRows.ts';
import { indexCountOf } from './compaction.ts';
import type { CompactBlock, Compaction } from './compactionTypes.ts';
import { CHUNK_BYTES, blockBytes } from './snapshotFile.ts';

/** Where the sections go, in order. */
export interface SectionSink {
  /** Writes the next section, from its parts in order. */
  section: (parts: Iterable<Uint8Array>) => Promise<void>;
}

const NO_PLANES = new SharedArrayBuffer(0);
/** Below this, words are copied one by one: a typed array view per copy would cost more. */
const SHORT_COPY = 16;

/**
 * The byte length of each section the compaction makes, in order: each block's planes then
 * columns, each segment's seq index, the key histogram, the alive bitmap, each set's bitmap, the
 * frequencies.
 * @param layout - The image.
 * @param compaction - Where its words go.
 * @param sets - How many sets.
 * @returns The lengths.
 */
export function sectionSizes(
  layout: Layout,
  compaction: Compaction,
  sets: number,
): number[] {
  const sizes: number[] = [];
  for (const block of compaction.blocks) {
    const { planes, columns } = blockBytes(block.capacity, layout.layout);
    sizes.push(planes, columns);
  }
  for (const segment of compaction.segments) {
    sizes.push(4 * Math.max(1, indexCountOf(segment.source)));
  }
  const bitmap = compaction.rowSpaceCapacity / 8;
  sizes.push(layout.histogram.counts.byteLength, bitmap);
  for (let i = 0; i < sets; i++) sizes.push(bitmap);
  sizes.push(layout.frequencies.byteLength);
  return sizes;
}

/**
 * Writes the sections `sectionSizes` names: a block the image holds unchanged as it is, any other
 * one built a few planes at a time, the indexes and bitmaps through the word map.
 * @param sink - Where they go.
 * @param layout - The image, holding still.
 * @param compaction - Where its words go.
 * @param sets - The sets' names, in the header's order.
 */
export async function writeSections(
  sink: SectionSink,
  layout: Layout,
  compaction: Compaction,
  sets: readonly string[],
): Promise<void> {
  for (const block of compaction.blocks) {
    if (block.same >= 0) {
      const source = layout.blocks[block.same] as Block;
      await sink.section([new Uint8Array(source.planes)]);
      await sink.section([new Uint8Array(source.columns)]);
    } else {
      await sink.section(planeChunks(layout, block));
      await sink.section([blockColumns(layout, block)]);
    }
  }
  for (const segment of compaction.segments) {
    await sink.section([indexBytes(segment.source, compaction)]);
  }
  await sink.section([new Uint8Array(layout.histogram.counts)]);
  await sink.section([bitmapBytes(layout.alive, compaction)]);
  for (const name of sets) {
    const bitmap = layout.sets.get(name);
    if (bitmap === undefined) throw new Error(`no bitmap for the set ${name}`);
    await sink.section([bitmapBytes(bitmap, compaction)]);
  }
  const { frequencies } = layout;
  await sink.section([
    new Uint8Array(
      frequencies.buffer,
      frequencies.byteOffset,
      frequencies.byteLength,
    ),
  ]);
}

/**
 * The planes of a block, as many at a time as fit a chunk.
 * @param layout - The image.
 * @param block - The snapshot's block.
 * @yields {Uint8Array} The next planes, in one buffer reused from chunk to chunk.
 */
function* planeChunks(
  layout: Layout,
  block: CompactBlock,
): Generator<Uint8Array> {
  const W = block.capacity / SLOTS;
  const perChunk = Math.max(
    1,
    Math.min(PLANES, Math.floor(CHUNK_BYTES / (4 * W))),
  );
  const chunk = new Int32Array(perChunk * W);
  for (let p0 = 0; p0 < PLANES; p0 += perChunk) {
    const p1 = Math.min(PLANES, p0 + perChunk);
    // The fragments cover every word of the block: nothing of the last chunk is left.
    for (const fragment of block.fragments) {
      const source = layout.views(fragment.from);
      const mask = lowBits(fragment.lastRows);
      for (let p = p0; p < p1; p++) {
        const to = (p - p0) * W + fragment.toWord;
        copyWords(
          chunk,
          to,
          source.planes,
          p * source.W + fragment.fromWord,
          fragment.words,
        );
        if (fragment.lastRows < SLOTS) {
          const last = to + fragment.words - 1;
          chunk[last] = (chunk[last] as number) & mask;
        }
      }
    }
    yield new Uint8Array(chunk.buffer, 0, (p1 - p0) * W * 4);
  }
}

/**
 * The row columns and zone maps of a block.
 * @param layout - The image.
 * @param block - The snapshot's block.
 * @returns Its columns section.
 */
function blockColumns(layout: Layout, block: CompactBlock): Uint8Array {
  const { capacity, start, atoms, fragments } = block;
  const columns = new SharedArrayBuffer(
    blockBytes(capacity, layout.layout).columns,
  );
  const target: Block = {
    planes: NO_PLANES,
    columns,
    capacity,
    start,
    atoms,
    append: false,
  };
  const to = blockViews(target, layout.layout);
  const targets = rowColumns(to);
  for (const fragment of fragments) {
    const from = layout.views(fragment.from);
    const sources = rowColumns(from);
    const r0 = fragment.fromWord * SLOTS;
    const t0 = fragment.toWord * SLOTS;
    const n = fragment.words * SLOTS;
    for (let j = 0; j < sources.length; j++) {
      (targets[j] as RowColumn).set(
        (sources[j] as RowColumn).subarray(r0, r0 + n),
        t0,
      );
    }
    copyZones(
      from.zones,
      to.zones,
      fragment.fromWord,
      fragment.words,
      fragment.toWord,
    );
    if (fragment.lastRows < SLOTS) {
      // The slots past an append area's rows hold no molecule.
      to.seq.fill(0, t0 + n - SLOTS + fragment.lastRows, t0 + n);
    }
  }
  return new Uint8Array(columns);
}

function copyWords(
  target: Int32Array,
  to: number,
  source: Int32Array,
  from: number,
  words: number,
): void {
  if (words > SHORT_COPY) {
    target.set(source.subarray(from, from + words), to);
    return;
  }
  for (let k = 0; k < words; k++) target[to + k] = source[from + k] as number;
}
