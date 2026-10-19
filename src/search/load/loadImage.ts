import { Worker } from 'node:worker_threads';

import { PLANES } from '../../chemistry/tile.ts';
import { alignRows, columnLayout } from '../blocks.ts';
import { newHistogram } from '../histogram.ts';
import { Layout } from '../layout.ts';
import type { NormalizedSpec } from '../spec.ts';

import { planeFrequencies } from './frequencies.ts';
import { RUN, layoutBlocks, tileChunks } from './layoutBlocks.ts';
import type { LoadProgressListener } from './loadProgress.ts';
import { runStep } from './loadProgress.ts';
import {
  indexPlan,
  phase,
  segmentsOf,
  setTasksOf,
  sortedCells,
  sum,
} from './loadSteps.ts';
import type { LoadPlan } from './plan.ts';
import { readPlan } from './plan.ts';

const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(
  FROM_SOURCE ? 'loadWorker.ts' : 'loadWorker.js',
  import.meta.url,
);

/** Tiles per tiles task at most. */
const CHUNK_TILES = 2048;

/** Options of a load. */
export interface LoadOptions {
  readers: number;
  blockRows: number;
  headroomRows: number;
  headroomShare: number;
  /** Hears how far the load got. */
  onProgress: LoadProgressListener;
}

/** A loaded image, and where the tail starts. */
export interface LoadedImage {
  layout: Layout;
  plan: LoadPlan;
  /** Per segment, per band: the first tile the tail reads. */
  tailFrom: Int32Array[];
  stats: { rows: number; dead: number; tiles: number; ms: number };
}

/**
 * Loads the image of a file with `readers` worker threads: the plan, the cells, the tiles (a
 * straight copy into bit planes), the seq index, the application's columns, the zones and the key
 * histogram, the sets, and the planes' frequencies.
 * @param file - The database.
 * @param spec - The application's specification.
 * @param options - Readers and sizes.
 * @returns The image.
 */
export async function loadImage(
  file: string,
  spec: NormalizedSpec,
  options: LoadOptions,
): Promise<LoadedImage> {
  const started = performance.now();
  const listener = options.onProgress;
  const plan = await runStep(listener, 'plan', () => readPlan(file, spec));
  const layout = columnLayout(spec.filters);
  const { watermark } = plan;
  const workerData = { file, layout, spec, watermark };
  const workers = Array.from(
    { length: Math.max(1, options.readers) },
    () => new Worker(WORKER_URL, { workerData }),
  );
  try {
    const found = await phase(
      workers,
      {
        phase: 'cells',
        atomCounts: Float64Array.from(plan.atomCounts),
        counter: new SharedArrayBuffer(4),
      },
      { listener, total: plan.atomCounts.length },
    );
    const cells = sortedCells(
      found.map((reply) => reply.cells as Float64Array),
    );
    await phase(workers, { phase: 'begin' });
    const placed = layoutBlocks(cells, options.blockRows, layout);
    const { blocks, runs, cellOfRun, cellRows, rowSpace } = placed;
    if (rowSpace >= 2 ** 31) {
      throw new Error(`${rowSpace} rows: the image holds at most 2^31 - 1`);
    }
    const headroom = Math.max(
      options.headroomRows,
      Math.ceil(rowSpace * options.headroomShare),
    );
    const rowSpaceCapacity = alignRows(
      Math.min(2 ** 31 - 1, rowSpace + headroom),
    );
    const tailFrom = new SharedArrayBuffer(4 * Math.max(1, cells.length));
    new Int32Array(tailFrom).fill(2 ** 31 - 1);
    const rowsOfRun = new SharedArrayBuffer(8 * Math.max(1, runs.length / RUN));
    const chunks = tileChunks(runs, CHUNK_TILES);
    const tiles = sum(
      await phase(
        workers,
        {
          phase: 'tiles',
          blocks,
          runs,
          chunks,
          cellOfRun,
          tailFrom,
          rowsOfRun,
          counter: new SharedArrayBuffer(4),
        },
        { listener, total: chunks.length / 2 },
      ),
      'tiles',
    );
    const index = indexPlan(placed, rowsOfRun);
    const { atomCounts, indexes, seqArrays, pieces, segmentRows } = index;
    await phase(
      workers,
      {
        phase: 'index',
        segments: segmentRows,
        indexes,
        seqArrays,
        counter: new SharedArrayBuffer(4),
      },
      { listener, total: segmentRows.length },
    );
    const alive = new SharedArrayBuffer(rowSpaceCapacity / 8);
    const columns = await phase(
      workers,
      {
        phase: 'columns',
        tasks: pieces,
        indexes,
        seqArrays,
        atomCounts,
        alive,
        counter: new SharedArrayBuffer(4),
      },
      { listener, total: pieces.length / 3 },
    );
    const histogram = newHistogram(
      Math.min(...columns.map((reply) => reply.low as number)),
      Math.max(...columns.map((reply) => reply.high as number)),
    );
    const zones = new SharedArrayBuffer(24 * Math.max(1, cells.length));
    await phase(
      workers,
      {
        phase: 'zones',
        cells: cellRows,
        zones,
        histogram,
        alive,
        counter: new SharedArrayBuffer(4),
      },
      { listener, total: cellRows.length / 2 },
    );
    const sets = new Map(
      plan.sets.map((set) => [
        set.name,
        new SharedArrayBuffer(rowSpaceCapacity / 8),
      ]),
    );
    const setTasks = setTasksOf(plan.sets.length, pieces);
    await phase(
      workers,
      {
        phase: 'sets',
        tasks: setTasks,
        sets: plan.sets,
        bitmaps: [...sets.values()],
        indexes,
        seqArrays,
        atomCounts,
        alive,
        counter: new SharedArrayBuffer(4),
      },
      { listener, total: setTasks.length / 4 },
    );
    await phase(workers, { phase: 'close' });
    const { segments, tailStarts } = segmentsOf(
      cells,
      placed,
      index,
      zones,
      tailFrom,
    );
    const image = new Layout({
      version: 0,
      watermark,
      layout,
      blocks,
      segments,
      rowSpace,
      rowSpaceCapacity,
      histogram,
      sets,
      alive,
      frequencies: new Float64Array(PLANES),
    });
    image.frequencies = await runStep(listener, 'frequencies', () =>
      planeFrequencies(image, 65_536),
    );
    return {
      layout: image,
      plan,
      tailFrom: tailStarts,
      stats: {
        rows: image.rowCount,
        dead: sum(columns, 'dead'),
        tiles,
        ms: performance.now() - started,
      },
    };
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
