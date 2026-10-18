import type { Worker } from 'node:worker_threads';

import { isReply } from '../../workerReplies.ts';
import type { Segment } from '../layoutTypes.ts';
import { bandRecord } from '../layoutTypes.ts';

import type { BlockLayout, Cell } from './layoutBlocks.ts';
import { RUN } from './layoutBlocks.ts';
import type { LoadProgressListener } from './loadProgress.ts';
import { runStep } from './loadProgress.ts';
import type { LoadMessage } from './loadWorker.ts';

/** Positions of a seq index per columns or sets task. */
const PIECE = 32_768;

/** The seq index of every atom count, as the index, columns and sets phases read it. */
export interface IndexPlan {
  atomCounts: number[];
  indexCounts: number[];
  indexes: SharedArrayBuffer[];
  seqArrays: SharedArrayBuffer[];
  /** Per atom count, its cells as (first row, end row) pairs. */
  segmentRows: Float64Array[];
  /** (segment, first position, end position) per piece of a seq index. */
  pieces: Float64Array;
}

/**
 * The seq indexes to fill, sized from the rows each run took.
 * @param placed - The block layout.
 * @param rowsOfRun - Per run, the rows the tiles phase took.
 * @returns The plan.
 */
export function indexPlan(
  placed: BlockLayout,
  rowsOfRun: SharedArrayBuffer,
): IndexPlan {
  const { runs, segmentCells, cellRows } = placed;
  const atomCounts = [...segmentCells.keys()];
  const rowsOf = new Map<number, number>();
  const taken = new Float64Array(rowsOfRun);
  for (let r = 0; r < runs.length / RUN; r++) {
    const atoms = runs[RUN * r] as number;
    rowsOf.set(atoms, (rowsOf.get(atoms) ?? 0) + (taken[r] as number));
  }
  const indexCounts = atomCounts.map((atoms) => rowsOf.get(atoms) ?? 0);
  const buffers = () =>
    indexCounts.map((count) => new SharedArrayBuffer(4 * Math.max(1, count)));
  const segmentRows = atomCounts.map((atoms) =>
    Float64Array.from(
      (segmentCells.get(atoms) as number[]).flatMap((c) => [
        cellRows[2 * c] as number,
        cellRows[2 * c + 1] as number,
      ]),
    ),
  );
  const pieces: number[] = [];
  for (const [s, count] of indexCounts.entries()) {
    for (let i = 0; i < count; i += PIECE) {
      pieces.push(s, i, Math.min(i + PIECE, count));
    }
  }
  return {
    atomCounts,
    indexCounts,
    indexes: buffers(),
    seqArrays: buffers(),
    segmentRows,
    pieces: Float64Array.from(pieces),
  };
}

/**
 * The sets phase's tasks: every set over every piece.
 * @param sets - How many sets.
 * @param pieces - The pieces, three numbers each.
 * @returns (set, segment, first position, end position) per task.
 */
export function setTasksOf(sets: number, pieces: Float64Array): Float64Array {
  const tasks = new Float64Array((4 * sets * pieces.length) / 3);
  let at = 0;
  for (let position = 0; position < sets; position++) {
    for (let p = 0; p < pieces.length; p += 3) {
      tasks[at++] = position;
      tasks[at++] = pieces[p] as number;
      tasks[at++] = pieces[p + 1] as number;
      tasks[at++] = pieces[p + 2] as number;
    }
  }
  return tasks;
}

/**
 * The segments of the first version: each atom count's band records (its runs, its zone, its rows),
 * and where the tail starts reading each cell (the first tile with a slot it holds, or the last).
 * @param cells - The cells.
 * @param placed - The block layout.
 * @param index - The seq indexes.
 * @param zones - Per cell, its least key, largest key and rows.
 * @param tailFrom - Per cell, the first tile holding a masked slot.
 * @returns The segments and the tail's starts.
 */
export function segmentsOf(
  cells: Cell[],
  placed: BlockLayout,
  index: IndexPlan,
  zones: SharedArrayBuffer,
  tailFrom: SharedArrayBuffer,
): { segments: Segment[]; tailStarts: Int32Array[] } {
  const zoneView = new Float64Array(zones);
  const tailFromView = new Int32Array(tailFrom);
  const { segmentCells, cellRuns } = placed;
  const segments = index.atomCounts.map((atoms, s) => ({
    atoms,
    bands: (segmentCells.get(atoms) as number[]).map((c) =>
      bandRecord(
        (cells[c] as Cell).band,
        cellRuns[c] ?? [],
        zoneView[3 * c] as number,
        zoneView[3 * c + 1] as number,
        zoneView[3 * c + 2] as number,
        -1,
        0,
        0,
      ),
    ),
    index: index.indexes[s] as SharedArrayBuffer,
    indexCount: index.indexCounts[s] as number,
    tail: null,
  }));
  const tailStarts = index.atomCounts.map((atoms) =>
    Int32Array.from(segmentCells.get(atoms) as number[], (c) => {
      const cell = cells[c] as Cell;
      return Math.min(
        tailFromView[c] as number,
        cell.firstTile + cell.tiles - 1,
      );
    }),
  );
  return { segments, tailStarts };
}

/**
 * The cells the readers found, sorted by atom count then band.
 * @param parts - (atoms, band, first tile, tiles) quadruples, per reader.
 * @returns The cells.
 */
export function sortedCells(parts: Float64Array[]): Cell[] {
  const cells: Cell[] = [];
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 4) {
      cells.push({
        atoms: part[i] as number,
        band: part[i + 1] as number,
        firstTile: part[i + 2] as number,
        tiles: part[i + 3] as number,
      });
    }
  }
  return cells.toSorted((a, b) => a.atoms - b.atoms || a.band - b.band);
}

/**
 * The sum of one number over the readers' replies.
 * @param replies - The replies.
 * @param key - The number's name.
 * @returns The sum.
 */
export function sum(
  replies: Array<Record<string, unknown>>,
  key: string,
): number {
  return replies.reduce((total, reply) => total + Number(reply[key] ?? 0), 0);
}

/**
 * Runs one phase on every reader, which pull its tasks from a shared counter.
 * @param workers - The readers.
 * @param message - The phase.
 * @param progress - Who hears how many tasks the readers took, and how many the phase holds.
 * @param progress.listener - Hears the phase.
 * @param progress.total - The tasks of the phase.
 * @returns Every reader's reply.
 */
export async function phase(
  workers: Worker[],
  message: LoadMessage,
  progress?: { listener: LoadProgressListener; total: number },
): Promise<Array<Record<string, unknown>>> {
  if (progress === undefined || !('counter' in message)) {
    return runPhase(workers, message);
  }
  return runStep(
    progress.listener,
    message.phase,
    () => runPhase(workers, message),
    { total: progress.total, counter: message.counter },
  );
}

async function runPhase(
  workers: Worker[],
  message: LoadMessage,
): Promise<Array<Record<string, unknown>>> {
  const replies = await Promise.all(
    workers.map(
      (worker) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const onError = (error: Error) => {
            worker.off('message', onMessage);
            reject(error);
          };
          // Only the phase's reply: Node's watch mode posts messages of its own.
          const onMessage = (reply: unknown) => {
            if (!isReply(reply, 'phase') || reply.phase !== message.phase) {
              return;
            }
            worker.off('message', onMessage);
            worker.off('error', onError);
            resolve(reply);
          };
          worker.once('error', onError);
          worker.on('message', onMessage);
          worker.postMessage(message);
        }),
    ),
  );
  const failed = replies.find((reply) => reply.error !== undefined);
  if (failed !== undefined) {
    throw new Error(`load phase ${message.phase}: ${String(failed.error)}`);
  }
  return replies;
}
