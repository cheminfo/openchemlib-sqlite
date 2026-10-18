import { SEQ_SPAN } from '../chemistry/key.ts';
import { SLOTS } from '../chemistry/tile.ts';

import { histogramOfBands, isEdgeHeavy } from './bandHistogram.ts';
import type { Block, BlockViews, ColumnLayout } from './blocks.ts';
import { blockViews } from './blocks.ts';
import type { KeyHistogram } from './histogram.ts';
import { sliceEnd } from './histogram.ts';
import type { LayoutState, Segment } from './layoutTypes.ts';
import { similarityWork } from './similarityUnits.ts';
import type { SliceWork, WorkUnits } from './units.ts';
import { sliceWork } from './units.ts';

/** One immutable version of the image; the tail publishes a new one for each change. */
export class Layout implements LayoutState {
  version: number;
  watermark: number;
  layout: ColumnLayout;
  blocks: Block[];
  segments: Segment[];
  rowSpace: number;
  rowSpaceCapacity: number;
  histogram: KeyHistogram;
  sets: Map<string, SharedArrayBuffer>;
  alive: SharedArrayBuffer;
  frequencies: Float64Array;
  /** Rows in the image, empty slots excluded. */
  readonly rowCount: number;
  readonly #viewCache: Map<number, BlockViews>;
  readonly #starts: Float64Array;
  readonly #segmentOf: Map<number, number>;
  readonly #counts: Uint32Array;
  /** The histogram rebuilt from the bands, once the version's own no longer sizes slices. */
  #rebuilt: { histogram: KeyHistogram; counts: Uint32Array } | undefined;

  /**
   * A version.
   * @param state - The version's contents.
   * @param viewCache - Block views by block, shared across versions.
   */
  constructor(state: LayoutState, viewCache = new Map<number, BlockViews>()) {
    this.version = state.version;
    this.watermark = state.watermark;
    this.layout = state.layout;
    this.blocks = state.blocks;
    this.segments = state.segments;
    this.rowSpace = state.rowSpace;
    this.rowSpaceCapacity = state.rowSpaceCapacity;
    this.histogram = state.histogram;
    this.sets = state.sets;
    this.alive = state.alive;
    this.frequencies = state.frequencies;
    this.#viewCache = viewCache;
    this.#starts = Float64Array.from(this.blocks, (block) => block.start);
    this.#segmentOf = new Map(
      this.segments.map((segment, i) => [segment.atoms, i]),
    );
    this.#counts = new Uint32Array(this.histogram.counts);
    let rows = 0;
    for (const segment of this.segments) {
      for (const band of segment.bands) rows += band.rows;
    }
    this.rowCount = rows;
  }

  /**
   * The block views cache, handed to the next version.
   * @returns The cache.
   */
  get viewCache(): Map<number, BlockViews> {
    return this.#viewCache;
  }

  /**
   * The typed views of a block.
   * @param b - The block.
   * @returns Its views.
   */
  views(b: number): BlockViews {
    let views = this.#viewCache.get(b);
    if (views === undefined) {
      views = blockViews(this.blocks[b] as Block, this.layout);
      this.#viewCache.set(b, views);
    }
    return views;
  }

  /**
   * The block holding a row of the row space.
   * @param g - The row.
   * @returns The block.
   */
  blockOfRow(g: number): number {
    const starts = this.#starts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((starts[mid] as number) <= g) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * The seq of a row, 0 for an empty slot.
   * @param g - The row.
   * @returns Its seq.
   */
  seqAt(g: number): number {
    const b = this.blockOfRow(g);
    return this.views(b).seq[g - (this.blocks[b] as Block).start] as number;
  }

  /**
   * The order key of a row, NaN when the columns SQL did not return it.
   * @param g - The row.
   * @returns Its key.
   */
  keyAt(g: number): number {
    const b = this.blockOfRow(g);
    return this.views(b).key[g - (this.blocks[b] as Block).start] as number;
  }

  /**
   * The row of an id: its atom count's seq index, loaded rows then the tail's.
   * @param id - The id.
   * @returns The row, or -1.
   */
  rowOfId(id: number): number {
    const atoms = Math.floor(id / SEQ_SPAN);
    const seq = id - atoms * SEQ_SPAN;
    const position = this.#segmentOf.get(atoms);
    if (position === undefined) return -1;
    const segment = this.segments[position] as Segment;
    const lists: Array<[SharedArrayBuffer | null, number]> = [
      [segment.index, segment.indexCount],
      [segment.tail?.buffer ?? null, segment.tail?.count ?? 0],
    ];
    for (const [buffer, count] of lists) {
      if (buffer === null || count === 0) continue;
      const index = new Int32Array(buffer, 0, count);
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.seqAt(index[mid] as number) < seq) lo = mid + 1;
        else hi = mid;
      }
      if (lo < count && this.seqAt(index[lo] as number) === seq) {
        return index[lo] as number;
      }
    }
    return -1;
  }

  /**
   * The upper end of the slice starting at `start`, sized to hold about `target` rows.
   * @param start - The slice's start.
   * @param target - The rows wanted.
   * @returns Its exclusive end and the rows the histogram counts in it.
   */
  sliceEnd(start: number, target: number): { end: number; rows: number } {
    if (
      this.#rebuilt === undefined &&
      isEdgeHeavy(this.#counts, this.rowCount)
    ) {
      const histogram = histogramOfBands(this.segments);
      this.#rebuilt = { histogram, counts: new Uint32Array(histogram.counts) };
    }
    const { histogram, counts } = this.#rebuilt ?? {
      histogram: this.histogram,
      counts: this.#counts,
    };
    return sliceEnd(histogram, counts, start, target);
  }

  /**
   * The words a slice of the key axis screens, in the atom counts from `floor` up.
   * @param lo - The slice's start.
   * @param hi - Its exclusive end.
   * @param end - The walk's inclusive end.
   * @param floor - The query's atom floor.
   * @returns The work.
   */
  sliceUnits(lo: number, hi: number, end: number, floor: number): SliceWork {
    return sliceWork(this.segments, this.segmentAtLeast(floor), lo, hi, end);
  }

  /**
   * Every row as similarity scores them, nearest atom count first.
   * @param unitWords - Words per unit.
   * @param atoms - The query's atom count.
   * @returns The work, shared with the workers.
   */
  similarityUnits(unitWords: number, atoms: number): WorkUnits {
    return similarityWork(this.segments, unitWords, atoms);
  }

  /**
   * The first segment whose atom count reaches k.
   * @param k - The atom count.
   * @returns Its position.
   */
  segmentAtLeast(k: number): number {
    let lo = 0;
    let hi = this.segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.segments[mid] as Segment).atoms < k) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Every visible row of the version, in no particular order (checks).
   * @yields {[number, number]} [block, row in the block] of every non-empty slot.
   */
  *rows(): Generator<[number, number]> {
    for (const segment of this.segments) {
      for (const band of segment.bands) {
        for (const [b, w0, w1] of band.runs) {
          const { seq } = this.views(b);
          for (let r = w0 * SLOTS; r < w1 * SLOTS; r++) {
            if (seq[r] !== 0) yield [b, r];
          }
        }
        if (band.ab >= 0) {
          for (let r = band.aw * SLOTS; r < band.aw * SLOTS + band.an; r++) {
            yield [band.ab, r];
          }
        }
      }
    }
  }
}
