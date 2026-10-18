import type { Band, Segment } from '../layoutTypes.ts';

/** The sizes a compaction lays the image out with, as a load does. */
export interface CompactionSizes {
  blockRows: number;
  headroomRows: number;
  headroomShare: number;
}

/** Words of a block of the image, copied to a block of the snapshot. */
export interface Fragment {
  /** The image's block, and the first word read there. */
  from: number;
  fromWord: number;
  /** The first word written in the snapshot's block. */
  toWord: number;
  words: number;
  /** The rows of its last word that hold a molecule: all 32 but at the end of an append area. */
  lastRows: number;
}

/** A block of the snapshot. */
export interface CompactBlock {
  capacity: number;
  start: number;
  atoms: number;
  fragments: Fragment[];
  /** The image's block it repeats word for word, or -1. */
  same: number;
}

/** A segment of the snapshot, and the image's segment it is made from. */
export interface CompactSegment {
  atoms: number;
  bands: Band[];
  source: Segment;
}

/**
 * The image in the shape a load gives it: per atom count, its bands in order, each band's main
 * words then its append area's in one run. The next open reads it as a fresh load.
 */
export interface Compaction {
  blocks: CompactBlock[];
  segments: CompactSegment[];
  /** Per word of the image's row space, its word in the snapshot's; -1 for a word left out. */
  wordMap: Int32Array;
  /** The snapshot's words holding molecules in their first rows only: [word, rows]. */
  masks: Array<[number, number]>;
  rowSpace: number;
  rowSpaceCapacity: number;
  /** Whether the snapshot is the image as it stands, no word moved. */
  identity: boolean;
}
