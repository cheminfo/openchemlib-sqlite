import { PLANES, SLOTS } from '../chemistry/tile.ts';

import type { SimilarityFingerprint } from './fingerprint.ts';
import type { FilterType, NormalizedFilter } from './spec.ts';
import type { Zone } from './zones.ts';
import { ZONE_BYTES, emptyZones, zoneViews } from './zones.ts';

/** NULL in an int32 column. */
export const INT32_NULL = -(2 ** 31);
/** NULL in an int16 column. */
export const INT16_NULL = -32768;
/** The largest magnitude an int column holds exactly; beyond it a value is saturated. */
export const INT32_LIMIT = 2 ** 31 - 1;
export const INT16_LIMIT = 32767;

/** Where each column of a block sits: byte offsets per row of capacity. */
export interface ColumnLayout {
  /** Bytes per row of the columns buffer, the zone maps excluded. */
  rowBytes: number;
  /** The seq column (Uint32). */
  seqAt: number;
  /** The FragFp and the screen bit count columns (Uint16). */
  fragFpBitsAt: number;
  screenBitsAt: number;
  /** The filter columns, in the specification's order. */
  filters: Array<{ name: string; type: FilterType; at: number }>;
}

/**
 * One block of the image: the rows of one atom count (a straight copy of tiles, or the append areas
 * of new molecules), as bit planes and row columns in two SharedArrayBuffers.
 */
export interface Block {
  /** 1,024 Int32 planes of `capacity / 32` words each, plane-major. */
  planes: SharedArrayBuffer;
  /** The row columns (key, filters, seq, bit counts), then the zone maps. */
  columns: SharedArrayBuffer;
  /** Rows, a multiple of 32. */
  capacity: number;
  /** Its first row in the image's row space (the bit of its rows in the bitmaps). */
  start: number;
  /** The atom count of its rows. */
  atoms: number;
  /** Whether the tail fills it. */
  append: boolean;
}

/** Typed views over one block. */
export interface BlockViews {
  planes: Int32Array;
  /** Words per plane: capacity / 32. */
  W: number;
  key: Float64Array;
  seq: Uint32Array;
  /** Each row's FragFp and screen bit counts; `both` counts their sum. */
  fragFpBits: Uint16Array;
  screenBits: Uint16Array;
  filters: Array<Float64Array | Float32Array | Int32Array | Int16Array>;
  /** The zone map of each fingerprint, so the bit-count window prunes in every mode. */
  zones: Record<SimilarityFingerprint, Zone>;
}

const SIZE: Record<FilterType, number> = {
  float64: 8,
  float32: 4,
  int32: 4,
  int16: 2,
};

/**
 * The column layout of a specification's filters: the key and the 8-byte columns first, then the
 * 4-byte ones (seq among them), then the 2-byte ones (the two bit counts among them), so every
 * column is aligned whatever the capacity (a multiple of 32).
 * @param filters - The filter columns.
 * @returns The layout.
 */
export function columnLayout(
  filters: readonly NormalizedFilter[],
): ColumnLayout {
  let at = 8;
  const placed: ColumnLayout['filters'] = [];
  const place = (size: number) => {
    for (const filter of filters) {
      if (SIZE[filter.type] !== size) continue;
      placed.push({ name: filter.name, type: filter.type, at });
      at += size;
    }
  };
  place(8);
  const seqAt = at;
  at += 4;
  place(4);
  const fragFpBitsAt = at;
  const screenBitsAt = at + 2;
  at += 4;
  place(2);
  const order = new Map(filters.map((filter, index) => [filter.name, index]));
  placed.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  return {
    rowBytes: at,
    seqAt,
    fragFpBitsAt,
    screenBitsAt,
    filters: placed,
  };
}

/**
 * A new, empty block; its zone maps start empty.
 * @param layout - The column layout.
 * @param atoms - The atom count of its rows.
 * @param capacity - Rows, a multiple of 32.
 * @param start - Its first row in the row space.
 * @param append - Whether the tail fills it.
 * @returns The block.
 */
export function newBlock(
  layout: ColumnLayout,
  atoms: number,
  capacity: number,
  start: number,
  append = false,
): Block {
  const words = capacity / SLOTS;
  const block: Block = {
    planes: new SharedArrayBuffer(PLANES * words * 4),
    columns: new SharedArrayBuffer(
      capacity * layout.rowBytes + ZONE_BYTES * words,
    ),
    capacity,
    start,
    atoms,
    append,
  };
  emptyZones(blockViews(block, layout).zones);
  return block;
}

/**
 * Typed views over a block.
 * @param block - The block.
 * @param layout - The column layout.
 * @returns The views.
 */
export function blockViews(block: Block, layout: ColumnLayout): BlockViews {
  const { capacity: c, columns, planes } = block;
  const W = c / SLOTS;
  return {
    planes: new Int32Array(planes),
    W,
    key: new Float64Array(columns, 0, c),
    seq: new Uint32Array(columns, layout.seqAt * c, c),
    fragFpBits: new Uint16Array(columns, layout.fragFpBitsAt * c, c),
    screenBits: new Uint16Array(columns, layout.screenBitsAt * c, c),
    filters: layout.filters.map((filter) => {
      const offset = filter.at * c;
      if (filter.type === 'float64') {
        return new Float64Array(columns, offset, c);
      }
      if (filter.type === 'float32') {
        return new Float32Array(columns, offset, c);
      }
      if (filter.type === 'int32') return new Int32Array(columns, offset, c);
      return new Int16Array(columns, offset, c);
    }),
    zones: zoneViews(columns, layout.rowBytes * c, W),
  };
}

/** One column of a block's rows. */
export type RowColumn =
  | BlockViews['key']
  | BlockViews['seq']
  | BlockViews['fragFpBits']
  | BlockViews['filters'][number];

/**
 * Every row column of a block: the seq, the two bit counts, the key, then the filters.
 * @param views - The block's views.
 * @returns The columns, in that order.
 */
export function rowColumns(views: BlockViews): RowColumn[] {
  return [
    views.seq,
    views.fragFpBits,
    views.screenBits,
    views.key,
    ...views.filters,
  ];
}

/**
 * Writes one row's key and filter values, as the columns SQL returned them.
 * @param views - The block's views.
 * @param layout - The column layout.
 * @param row - The row in the block.
 * @param values - The SQL row: id, key, then the filter values.
 */
export function writeColumns(
  views: BlockViews,
  layout: ColumnLayout,
  row: number,
  values: readonly unknown[] | null,
): void {
  views.key[row] = values === null ? Number.NaN : toNumber(values[1]);
  for (let j = 0; j < layout.filters.length; j++) {
    const column = views.filters[j] as BlockViews['filters'][number];
    const type = (layout.filters[j] as ColumnLayout['filters'][number]).type;
    const value = values === null ? Number.NaN : toNumber(values[2 + j]);
    if (type === 'float64' || type === 'float32') {
      column[row] = value;
    } else if (type === 'int32') {
      column[row] = toInt(value, INT32_LIMIT, INT32_NULL);
    } else {
      column[row] = toInt(value, INT16_LIMIT, INT16_NULL);
    }
  }
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return Number.NaN;
  return Number(value);
}

function toInt(value: number, limit: number, empty: number): number {
  if (Number.isNaN(value)) return empty;
  if (value >= limit) return limit;
  if (value <= -limit) return -limit;
  return Math.round(value);
}

/**
 * A row count rounded up to whole plane words.
 * @param rows - The rows.
 * @returns The aligned count.
 */
export function alignRows(rows: number): number {
  return Math.ceil(rows / SLOTS) * SLOTS;
}
