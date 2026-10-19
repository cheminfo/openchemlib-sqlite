import {
  FRAGFP_PLANES,
  FUNCTION_PLANES_AT,
  PLANES,
  SLOTS,
} from '../../chemistry/tile.ts';
import type { Block, BlockViews, ColumnLayout } from '../blocks.ts';
import { blockViews, writeColumns } from '../blocks.ts';
import type { KeyHistogram } from '../histogram.ts';
import { binOf } from '../histogram.ts';
import { widenZones } from '../zones.ts';

import { growArea } from './tailAreas.ts';
import { TailBitmaps } from './tailBitmaps.ts';
import { bandOfRow, indexRows, locateRow, rowAt } from './tailIndex.ts';
import type {
  TailBand,
  TailOptions,
  TailSegment,
  TailWorkerData,
} from './tailState.ts';
import { newTailBand, newTailSegment } from './tailState.ts';

/**
 * The RAM side of the tail: the blocks, bitmaps and band directory it extends, and how one new
 * molecule goes in: its band's append area (a range of words of an append block of its atom
 * count, in the image's plane format), its columns, its key into the histogram and the band's
 * zone, its bits. A full area moves to a free range twice its size (the old range stays as it was
 * for the versions still reading it), so a band is one range however many molecules it receives.
 * Every write happens before the version exposing it is published.
 */
export class TailStore {
  readonly layout: ColumnLayout;
  readonly options: TailOptions;
  readonly blocks: Block[];
  readonly bitmaps: TailBitmaps;
  readonly segments = new Map<number, TailSegment>();
  readonly histogram: KeyHistogram;
  readonly counts: Uint32Array;
  rowSpace: number;
  /** Append areas moved to a range twice their size so far. */
  moves = 0;
  readonly #views = new Map<number, BlockViews>();
  readonly pending = {
    newBlocks: [] as number[],
    touched: new Map<string, { atoms: number; band: number }>(),
    any: false,
  };

  /**
   * The tail's side of a loaded image.
   * @param data - The loaded image, as the tail worker received it.
   */
  constructor(data: TailWorkerData) {
    this.layout = data.layout;
    this.options = data.options;
    this.blocks = data.blocks.slice();
    this.rowSpace = data.rowSpace;
    this.histogram = data.histogram;
    this.counts = new Uint32Array(data.histogram.counts);
    this.bitmaps = new TailBitmaps(
      data.alive,
      data.sets,
      data.rowSpaceCapacity,
      {
        rows: data.options.headroomRows,
        share: data.options.headroomShare,
      },
    );
    for (const segment of data.segments) {
      const entry = this.segmentOf(segment.atoms);
      entry.index = segment.index;
      entry.indexCount = segment.indexCount;
      for (const band of segment.bands) {
        entry.bands.set(band.band, { ...band, ab: -1, aw: 0, cap: 0, an: 0 });
      }
    }
  }

  /**
   * A block's views.
   * @param b - The block.
   * @returns Its views.
   */
  viewsOf(b: number): BlockViews {
    let views = this.#views.get(b);
    if (views === undefined) {
      views = blockViews(this.blocks[b] as Block, this.layout);
      this.#views.set(b, views);
    }
    return views;
  }

  /**
   * An atom count, created when the image has none.
   * @param atoms - The atom count.
   * @returns Its segment.
   */
  segmentOf(atoms: number): TailSegment {
    let segment = this.segments.get(atoms);
    if (segment === undefined) {
      segment = newTailSegment(atoms, this.options.appendBlockRows);
      this.segments.set(atoms, segment);
    }
    return segment;
  }

  /**
   * A band of a segment, created when the image has none.
   * @param segment - The segment.
   * @param band - The band.
   * @returns Its record.
   */
  bandOf(segment: TailSegment, band: number): TailBand {
    let entry = segment.bands.get(band);
    if (entry === undefined) {
      entry = newTailBand(band);
      segment.bands.set(band, entry);
    }
    return entry;
  }

  /**
   * One new molecule into its band's append area. Its row is indexed by `indexRows()` once the
   * poll has placed every row of the segment: an area may still move before.
   * @param segment - Its atom count.
   * @param band - Its band.
   * @param planes - Its tile's 1,536 plane words; `slot` its slot there.
   * @param slot - Its slot.
   * @param seq - Its seq.
   * @param fragFpBits - Its FragFp bit count.
   * @param values - Its columns SQL row, null when the SQL did not return it.
   * @returns Its row in the row space, as long as its area does not move.
   */
  appendRow(
    segment: TailSegment,
    band: TailBand,
    planes: Int32Array,
    slot: number,
    seq: number,
    fragFpBits: number,
    values: readonly unknown[] | null,
  ): number {
    if (band.ab < 0 || band.an === band.cap * SLOTS) {
      growArea(this, segment, band);
    }
    const view = this.viewsOf(band.ab);
    const r = band.aw * SLOTS + band.an;
    const w = r >>> 5;
    const lane = r & 31;
    let screen = 0;
    for (let p = 0; p < PLANES; p++) {
      if ((((planes[p] as number) >>> slot) & 1) !== 0) {
        Atomics.or(view.planes, p * view.W + w, 1 << lane);
        if (p >= FRAGFP_PLANES && p < FUNCTION_PLANES_AT) screen++;
      }
    }
    view.seq[r] = seq;
    view.fragFpBits[r] = fragFpBits;
    view.screenBits[r] = screen;
    widenZones(view.zones, w, fragFpBits, screen);
    writeColumns(view, this.layout, r, values);
    const g = (this.blocks[band.ab] as Block).start + r;
    const key = view.key[r] as number;
    if (!Number.isNaN(key)) {
      Atomics.or(this.bitmaps.alive.words, g >>> 5, 1 << (g & 31));
      this.widen(band, key);
    }
    segment.placed.push({ seq, band, at: band.an });
    band.an++;
    band.rows++;
    this.pending.any = true;
    return g;
  }

  /**
   * Rewrites a row's columns as the columns SQL returns them now (the change log named it): a row
   * the SQL no longer returns, or returns without a key, is dead and leaves every bitmap; an alive
   * one widens its band's zone when its key moved out of it.
   * @param g - The row.
   * @param values - Its columns SQL row, null when the SQL does not return it.
   */
  rewriteRow(g: number, values: readonly unknown[] | null): void {
    const { b, r } = rowAt(this, g);
    const view = this.viewsOf(b);
    const before = view.key[r] as number;
    writeColumns(view, this.layout, r, values);
    const key = view.key[r] as number;
    this.pending.any = true;
    if (Number.isNaN(key)) {
      this.bitmaps.clearRow(g);
      return;
    }
    Atomics.or(this.bitmaps.alive.words, g >>> 5, 1 << (g & 31));
    if (key === before) return;
    const atoms = (this.blocks[b] as Block).atoms;
    const band = bandOfRow(this, this.segmentOf(atoms), g);
    if (band === undefined) return;
    this.widen(band, key);
    this.touch(atoms, band.band);
  }

  /**
   * Widens a band's zone to a key, and counts the key in the histogram.
   * @param band - The band.
   * @param key - The key.
   */
  widen(band: TailBand, key: number): void {
    if (key < band.zmin) band.zmin = key;
    if (key > band.zmax) band.zmax = key;
    Atomics.add(this.counts, binOf(this.histogram, key), 1);
  }

  /**
   * The row an id holds, through its atom count's seq index (the loaded rows, then the tail's).
   * @param id - The id.
   * @returns The row, or -1.
   */
  locate(id: number): number {
    return locateRow(this, id);
  }

  /**
   * The rows this poll placed in a segment, at the end of its tail index, in seq order.
   * @param segment - The segment.
   */
  indexRows(segment: TailSegment): void {
    indexRows(this, segment);
  }

  /**
   * Notes a band as changed, for the next publish.
   * @param atoms - Its atom count.
   * @param band - Its band.
   */
  touch(atoms: number, band: number): void {
    this.pending.touched.set(`${atoms}:${band}`, { atoms, band });
    this.pending.any = true;
  }
}
