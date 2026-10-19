import { SLOTS } from '../chemistry/tile.ts';

import type { Band, Segment } from './layoutTypes.ts';

/** Words of one screen entry at most (65,536 rows); also the words a unit of append areas holds. */
const ENTRY_WORDS = 2048;

/**
 * Work for the workers: entries are quadruples (block, first word, end word, lane mask of the last
 * word), units are pairs (first entry, end entry), both shared with the workers.
 */
export interface WorkUnits {
  entries: Float64Array;
  units: Int32Array;
}

/** The work of one slice, and what it read. */
export interface SliceWork extends WorkUnits {
  /** Bands whose zone meets the slice. */
  bands: number;
  /** Their rows. */
  rows: number;
}

/**
 * The words of every band whose zone meets [lo, hi) ∩ (−∞, end], in the segments from `first`.
 * The band index reads only the bands whose number can meet the slice: a zone lies within
 * [band − low, band + 1 + high], `low` and `high` the largest deviations of the atom count's
 * bands. A band's main runs merge with its neighbours'; its append area is one entry; the append
 * entries of an atom count are grouped by block.
 * @param segments - The version's segments.
 * @param first - The first segment to read (the atom floor).
 * @param lo - The slice's start.
 * @param hi - Its exclusive end.
 * @param end - The walk's inclusive end.
 * @param select - Which of those bands to read; every one when left out.
 * @returns The work.
 */
export function sliceWork(
  segments: readonly Segment[],
  first: number,
  lo: number,
  hi: number,
  end: number,
  select?: (band: Band) => boolean,
): SliceWork {
  const entries: number[] = [];
  const units: number[] = [];
  const areas: number[] = [];
  let bands = 0;
  let rows = 0;
  for (let s = first; s < segments.length; s++) {
    const list = (segments[s] as Segment).bands;
    const { low, high } = bandDeviation(list);
    const from = firstBand(list, lo - 1 - high);
    const to = firstBand(list, Math.floor(Math.min(hi, end) + low) + 1);
    let b0 = -1;
    let w0 = 0;
    let w1 = 0;
    areas.length = 0;
    for (let i = from; i < to; i++) {
      const band = list[i] as Band;
      if (
        band.rows === 0 ||
        band.zmax < lo ||
        !(band.zmin < hi) ||
        band.zmin > end ||
        (select !== undefined && !select(band))
      ) {
        continue;
      }
      bands++;
      rows += band.rows;
      for (const run of band.runs) {
        if (b0 === run[0] && w1 === run[1]) {
          w1 = run[2];
        } else {
          if (b0 >= 0) pushRange(entries, units, b0, w0, w1);
          [b0, w0, w1] = run;
        }
      }
      if (band.ab >= 0 && band.an > 0) areas.push(band.ab, band.aw, band.an);
    }
    if (b0 >= 0) pushRange(entries, units, b0, w0, w1);
    pushAreas(entries, units, areas);
  }
  return {
    entries: shared(Float64Array, entries),
    units: shared(Int32Array, units),
    bands,
    rows,
  };
}

const deviations = new WeakMap<Band[], { low: number; high: number }>();

function bandDeviation(list: Band[]): { low: number; high: number } {
  let found = deviations.get(list);
  if (found === undefined) {
    let low = 0;
    let high = 0;
    for (const band of list) {
      if (band.rows === 0 || !(band.zmin <= band.zmax)) continue;
      if (band.band - band.zmin > low) low = band.band - band.zmin;
      if (band.zmax - band.band - 1 > high) high = band.zmax - band.band - 1;
    }
    found = { low, high };
    deviations.set(list, found);
  }
  return found;
}

function firstBand(list: Band[], band: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((list[mid] as Band).band < band) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function shared<T extends Float64Array | Int32Array>(
  Type: {
    new (buffer: SharedArrayBuffer, offset: number, length: number): T;
    BYTES_PER_ELEMENT: number;
  },
  list: number[],
): T {
  const array = new Type(
    new SharedArrayBuffer(Math.max(1, list.length) * Type.BYTES_PER_ELEMENT),
    0,
    list.length,
  );
  for (let i = 0; i < list.length; i++) array[i] = list[i] as number;
  return array;
}

function pushRange(
  entries: number[],
  units: number[],
  b: number,
  w0: number,
  w1: number,
): void {
  for (let w = w0; w < w1; w += ENTRY_WORDS) {
    units.push(entries.length / 4, entries.length / 4 + 1);
    entries.push(b, w, Math.min(w + ENTRY_WORDS, w1), -1);
  }
}

function pushAreas(entries: number[], units: number[], areas: number[]): void {
  const grouped = byBlock(areas);
  let firstEntry = entries.length / 4;
  let words = 0;
  for (let i = 0; i < grouped.length; i += 3) {
    const n = grouped[i + 2] as number;
    const span = Math.ceil(n / SLOTS);
    if (words > 0 && words + span > ENTRY_WORDS) {
      units.push(firstEntry, entries.length / 4);
      firstEntry = entries.length / 4;
      words = 0;
    }
    const rest = n % SLOTS;
    const aw = grouped[i + 1] as number;
    entries.push(
      grouped[i] as number,
      aw,
      aw + span,
      rest === 0 ? -1 : (1 << rest) - 1,
    );
    words += span;
  }
  if (words > 0) units.push(firstEntry, entries.length / 4);
}

/**
 * Append areas (block, first word, rows) grouped by block, in their own order within a block, so a
 * worker makes one context per block however the moves scattered them.
 * @param areas - The triples, in band order.
 * @returns The same triples, grouped by block.
 */
export function byBlock(areas: number[]): number[] {
  const n = areas.length / 3;
  if (n < 2) return areas;
  const keys = new Float64Array(n);
  let sorted = true;
  for (let i = 0; i < n; i++) {
    keys[i] = (areas[3 * i] as number) * 4294967296 + i;
    if (i > 0 && (areas[3 * i] as number) < (areas[3 * i - 3] as number)) {
      sorted = false;
    }
  }
  if (sorted) return areas;
  keys.sort();
  const grouped = new Array<number>(areas.length);
  for (let i = 0; i < n; i++) {
    const j = (keys[i] as number) % 4294967296;
    grouped[3 * i] = areas[3 * j] as number;
    grouped[3 * i + 1] = areas[3 * j + 1] as number;
    grouped[3 * i + 2] = areas[3 * j + 2] as number;
  }
  return grouped;
}
