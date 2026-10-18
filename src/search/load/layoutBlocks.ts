import { SLOTS } from '../../chemistry/tile.ts';
import type { Block, ColumnLayout } from '../blocks.ts';
import { newBlock } from '../blocks.ts';
import type { Run } from '../layoutTypes.ts';

/** A cell of the file: an atom count, a band, its tiles. */
export interface Cell {
  atoms: number;
  band: number;
  firstTile: number;
  tiles: number;
}

/** Numbers per run: atoms, band, first tile, end tile, block, first word. */
export const RUN = 6;

/** Where the cells go in memory. */
export interface BlockLayout {
  blocks: Block[];
  /** Per run (a cell's tiles in one block): atoms, band, tile0, tile1, block, w0. */
  runs: Float64Array;
  /** The cell of each run. */
  cellOfRun: Int32Array;
  /** Per cell, its main words: [block, w0, w1] per block it lies in. */
  cellRuns: Run[][];
  /** Per cell, its first and end row in the row space. */
  cellRows: Float64Array;
  /** Per atom count, its cells' positions. */
  segmentCells: Map<number, number[]>;
  rowSpace: number;
}

/**
 * Blocks of one atom count each, filled with its cells in band order, one tile per plane word; a
 * block closes at `blockRows` rows, so a cell may straddle two (two runs). Blocks follow one
 * another in the row space.
 * @param cells - The cells, sorted by atom count then band.
 * @param blockRows - Rows per block at most.
 * @param layout - The column layout.
 * @returns The layout.
 */
export function layoutBlocks(
  cells: Cell[],
  blockRows: number,
  layout: ColumnLayout,
): BlockLayout {
  const blockWords = Math.max(1, Math.floor(blockRows / SLOTS));
  const blocks: Block[] = [];
  const runs: number[] = [];
  const cellOfRun: number[] = [];
  const cellRuns: Run[][] = cells.map(() => []);
  const cellRows = new Float64Array(2 * cells.length);
  const segmentCells = new Map<number, number[]>();
  let rowSpace = 0;
  for (let c0 = 0; c0 < cells.length;) {
    const atoms = (cells[c0] as Cell).atoms;
    let c1 = c0;
    let left = 0;
    while (c1 < cells.length && (cells[c1] as Cell).atoms === atoms) {
      left += (cells[c1++] as Cell).tiles;
    }
    segmentCells.set(
      atoms,
      Array.from({ length: c1 - c0 }, (_, i) => c0 + i),
    );
    let block = -1;
    let used = 0;
    for (let c = c0; c < c1; c++) {
      const cell = cells[c] as Cell;
      for (let tile = cell.firstTile; tile < cell.firstTile + cell.tiles;) {
        if (block < 0 || used === (blocks[block] as Block).capacity / SLOTS) {
          const capacity = Math.min(blockWords, left) * SLOTS;
          blocks.push(newBlock(layout, atoms, capacity, rowSpace));
          rowSpace += capacity;
          block = blocks.length - 1;
          used = 0;
        }
        if (tile === cell.firstTile) {
          cellRows[2 * c] = (blocks[block] as Block).start + used * SLOTS;
        }
        const take = Math.min(
          cell.firstTile + cell.tiles - tile,
          (blocks[block] as Block).capacity / SLOTS - used,
        );
        runs.push(atoms, cell.band, tile, tile + take, block, used);
        cellOfRun.push(c);
        (cellRuns[c] as Run[]).push([block, used, used + take]);
        tile += take;
        used += take;
        left -= take;
      }
      cellRows[2 * c + 1] = (cellRows[2 * c] as number) + cell.tiles * SLOTS;
    }
    c0 = c1;
  }
  return {
    blocks,
    runs: Float64Array.from(runs),
    cellOfRun: Int32Array.from(cellOfRun),
    cellRuns,
    cellRows,
    segmentCells,
    rowSpace,
  };
}

/**
 * The tiles phase's tasks: runs of one block taken in order until a chunk holds `chunkTiles`
 * tiles. The runs of a block are consecutive cells of one atom count at consecutive words, so a
 * chunk is one key range of `ocl_tile` and one range of words.
 * @param runs - The runs.
 * @param chunkTiles - Tiles per chunk at most (a longer run is a chunk alone).
 * @returns (first run, end run) per chunk.
 */
export function tileChunks(runs: Float64Array, chunkTiles: number): Int32Array {
  const n = runs.length / RUN;
  const chunks: number[] = [];
  let r0 = 0;
  let tiles = 0;
  for (let r = 0; r < n; r++) {
    const length =
      (runs[RUN * r + 3] as number) - (runs[RUN * r + 2] as number);
    if (
      r > r0 &&
      (runs[RUN * r + 4] !== runs[RUN * r0 + 4] || tiles + length > chunkTiles)
    ) {
      chunks.push(r0, r);
      r0 = r;
      tiles = 0;
    }
    tiles += length;
  }
  if (n > r0) chunks.push(r0, n);
  return Int32Array.from(chunks);
}
