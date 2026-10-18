import type { Block, ColumnLayout } from '../blocks.ts';
import type { KeyHistogram } from '../histogram.ts';
import type { Run } from '../layoutTypes.ts';
import type { LoadedImage } from '../load/loadImage.ts';
import type { SetEntry } from '../load/plan.ts';
import type { NormalizedSpec } from '../spec.ts';

/** A band as the tail holds it: its zone and rows, its main runs, and its append area. */
export interface TailBand {
  band: number;
  zmin: number;
  zmax: number;
  rows: number;
  runs: Run[];
  /** The append area: block (-1 without one), first word, capacity in words, rows written. */
  ab: number;
  aw: number;
  cap: number;
  an: number;
  /** The first tile of the cell the tail reads next. */
  tailFrom: number;
}

/** An atom count as the tail holds it. */
export interface TailSegment {
  atoms: number;
  bands: Map<number, TailBand>;
  index: SharedArrayBuffer | null;
  indexCount: number;
  /** The rows the tail added, sorted by seq, and their seqs. */
  tail: { buffer: SharedArrayBuffer; count: number } | null;
  tailSeqs: Uint32Array;
  tailCapacity: number;
  /** Whether `tail` is this poll's own copy (a published one is never changed in place). */
  tailOwned: boolean;
  /** Rows this poll placed: seq, band, position in the band's area. */
  placed: Array<{ seq: number; band: TailBand; at: number }>;
  /** The current append block, and its words used. */
  arena: number;
  arenaUsed: number;
  arenaSize: number;
}

/**
 * A new atom count, which the image does not hold.
 * @param atoms - The atom count.
 * @param arenaSize - Rows of its first append block.
 * @returns Its record.
 */
export function newTailSegment(atoms: number, arenaSize: number): TailSegment {
  return {
    atoms,
    bands: new Map(),
    index: null,
    indexCount: 0,
    tail: null,
    tailSeqs: new Uint32Array(0),
    tailCapacity: 0,
    tailOwned: false,
    placed: [],
    arena: -1,
    arenaUsed: 0,
    arenaSize,
  };
}

/**
 * A new band, which the image does not hold.
 * @param band - The band.
 * @returns Its record.
 */
export function newTailBand(band: number): TailBand {
  return {
    band,
    zmin: Infinity,
    zmax: -Infinity,
    rows: 0,
    runs: [],
    ab: -1,
    aw: 0,
    cap: 0,
    an: 0,
    tailFrom: 0,
  };
}

/** What the tail worker starts with. */
export interface TailWorkerData {
  file: string;
  spec: NormalizedSpec;
  layout: ColumnLayout;
  options: TailOptions;
  version: number;
  watermark: number;
  changeId: number | null;
  blocks: Block[];
  rowSpace: number;
  rowSpaceCapacity: number;
  histogram: KeyHistogram;
  sets: Array<{
    name: string;
    family: string;
    value: unknown;
    bitmap: SharedArrayBuffer;
  }>;
  alive: SharedArrayBuffer;
  segments: Array<{
    atoms: number;
    index: SharedArrayBuffer | null;
    indexCount: number;
    bands: Array<{
      band: number;
      zmin: number;
      zmax: number;
      rows: number;
      runs: Run[];
      tailFrom: number;
    }>;
  }>;
}

/** How the tail follows the file. */
export interface TailOptions {
  /** Milliseconds between polls. */
  pollMs: number;
  /** Rows of a segment's first append block. */
  appendBlockRows: number;
  /** Rows of a block at most. */
  blockRows: number;
  headroomRows: number;
  headroomShare: number;
  /** Seqs read per poll at most, 0 for no limit (tests: catch up in steps). */
  pollRows: number;
  /** The stamp the image was loaded under: a file rebuilt under another one is no longer followed. */
  stamp: string;
  /** Changes read per poll at most. */
  changeBatch: number;
}

/** A band record as a publish carries it. */
export interface PublishedBand {
  band: number;
  zmin: number;
  zmax: number;
  rows: number;
  ab: number;
  aw: number;
  an: number;
}

/** What one publish changes. */
export interface PublishMessage {
  type: 'publish';
  version: number;
  watermark: number;
  rowSpace: number;
  rowSpaceCapacity: number;
  newBlocks: Array<Block & { index: number }>;
  segments: Array<{
    atoms: number;
    bands: PublishedBand[];
    tail: { buffer: SharedArrayBuffer; count: number } | null;
  }>;
  sets: Array<[string, SharedArrayBuffer]>;
  alive: SharedArrayBuffer;
  counters: TailCounters;
}

/** What the tail took in so far. */
export interface TailCounters {
  /** Molecules placed. */
  rows: number;
  /** Molecules read again from the change log. */
  changes: number;
  /** Whether the file held more than its last poll read. */
  more: boolean;
}

/** Where the tail stands, paused: what a save of the image needs and no version carries. */
export interface TailCheckpoint {
  /** The version published last, which holds every row placed. */
  version: number;
  watermark: number;
  /** The last change applied, null once the change log is no longer followed. */
  changeId: number | null;
  /** Per atom count, per band: the first tile the tail reads next. */
  tailFrom: Array<[number, Array<[number, number]>]>;
  /** The sets the bitmaps hold. */
  sets: SetEntry[];
  /** Why the tail stopped, null while it follows the file. */
  fatal: string | null;
  counters: TailCounters;
}

/**
 * What the tail worker starts with, from an image freshly loaded or read back.
 * @param file - The database.
 * @param image - The image, and where its tail starts.
 * @param spec - The application's specification.
 * @param options - Polling and sizes.
 * @returns The worker's data.
 */
export function tailWorkerData(
  file: string,
  image: LoadedImage,
  spec: NormalizedSpec,
  options: TailOptions,
): TailWorkerData {
  const layout = image.layout;
  return {
    file,
    spec,
    layout: layout.layout,
    options,
    version: layout.version,
    watermark: layout.watermark,
    changeId: image.plan.changeId,
    blocks: layout.blocks,
    rowSpace: layout.rowSpace,
    rowSpaceCapacity: layout.rowSpaceCapacity,
    histogram: layout.histogram,
    sets: image.plan.sets.map((set) => ({
      ...set,
      bitmap: layout.sets.get(set.name) as SharedArrayBuffer,
    })),
    alive: layout.alive,
    segments: layout.segments.map((segment, s) => ({
      atoms: segment.atoms,
      index: segment.index,
      indexCount: segment.indexCount,
      bands: segment.bands.map((band, i) => ({
        band: band.band,
        zmin: band.zmin,
        zmax: band.zmax,
        rows: band.rows,
        runs: band.runs,
        tailFrom: image.tailFrom[s]?.[i] ?? 0,
      })),
    })),
  };
}
