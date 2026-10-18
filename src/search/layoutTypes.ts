import type { Block, ColumnLayout } from './blocks.ts';
import type { KeyHistogram } from './histogram.ts';

/** A run of main words of a band: [block, first word, end word]. */
export type Run = [number, number, number];

/**
 * A band of an atom count, as every version holds it: its main words (a straight copy of its
 * tiles), its zone (the least and the largest key of its rows), its rows, and its append area (a
 * range of words of an append block the tail fills: block `ab`, first word `aw`, `an` rows
 * visible; `ab` is -1 without one). One literal shape, so the loops over bands stay monomorphic.
 */
export interface Band {
  band: number;
  runs: Run[];
  zmin: number;
  zmax: number;
  rows: number;
  ab: number;
  aw: number;
  an: number;
}

/** The rows of one atom count. */
export interface Segment {
  /** The atom count. */
  atoms: number;
  /** Its bands, ascending. */
  bands: Band[];
  /** The loaded rows sorted by seq (Int32 rows of the row space), and how many. */
  index: SharedArrayBuffer | null;
  indexCount: number;
  /** The rows the tail added, sorted by seq. */
  tail: { buffer: SharedArrayBuffer; count: number } | null;
}

/** What one version of the image holds. */
export interface LayoutState {
  version: number;
  /** Every molecule with a seq up to it is in the image. */
  watermark: number;
  layout: ColumnLayout;
  blocks: Block[];
  segments: Segment[];
  rowSpace: number;
  rowSpaceCapacity: number;
  histogram: KeyHistogram;
  /** The sets' bitmaps over the row space, by name. */
  sets: Map<string, SharedArrayBuffer>;
  /** The rows the columns SQL returned (alive), as a bitmap. */
  alive: SharedArrayBuffer;
  /** How often each plane's bit is set. */
  frequencies: Float64Array;
}

/**
 * A band record.
 * @param band - The band number.
 * @param runs - Its main words.
 * @param zmin - Its least key.
 * @param zmax - Its largest key.
 * @param rows - Its rows.
 * @param ab - Its append area's block, -1 without one.
 * @param aw - The area's first word.
 * @param an - The area's visible rows.
 * @returns The record.
 */
export function bandRecord(
  band: number,
  runs: Run[],
  zmin: number,
  zmax: number,
  rows: number,
  ab: number,
  aw: number,
  an: number,
): Band {
  return { band, runs, zmin, zmax, rows, ab, aw, an };
}
