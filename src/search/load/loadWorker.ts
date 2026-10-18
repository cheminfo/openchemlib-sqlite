import { parentPort, workerData } from 'node:worker_threads';

import type { Block } from '../blocks.ts';

import type { ColumnsTask, ZonesTask } from './columnsPhase.ts';
import { runColumns, runZones } from './columnsPhase.ts';
import type { IndexTask } from './indexPhase.ts';
import { runIndex } from './indexPhase.ts';
import { openReader } from './plan.ts';
import type { ReaderData } from './readerContext.ts';
import { ReaderContext } from './readerContext.ts';
import type { SetsTask } from './setsPhase.ts';
import { runSets } from './setsPhase.ts';
import type { TilesTask } from './tilesPhase.ts';
import { runCells, runTiles } from './tilesPhase.ts';

/** A phase of the load, as the coordinator posts it. */
export type LoadMessage =
  | { phase: 'cells'; atomCounts: Float64Array; counter: SharedArrayBuffer }
  | { phase: 'begin' }
  | ({ phase: 'tiles'; blocks: Block[] } & TilesTask)
  | ({ phase: 'index' } & IndexTask)
  | ({ phase: 'columns' } & ColumnsTask)
  | ({ phase: 'zones' } & ZonesTask)
  | ({ phase: 'sets' } & SetsTask)
  | { phase: 'close' };

const port = parentPort as NonNullable<typeof parentPort>;
const data = workerData as ReaderData;
const db = openReader(data.file);
const context = new ReaderContext(db, data);

port.on('message', (message: LoadMessage) => {
  try {
    port.postMessage({ phase: message.phase, ...run(message) });
  } catch (error) {
    port.postMessage({
      phase: message.phase,
      error: error instanceof Error ? error.stack : String(error),
    });
  }
});

function run(message: LoadMessage): Record<string, unknown> {
  switch (message.phase) {
    case 'cells':
      return { cells: runCells(context, message.atomCounts, message.counter) };
    case 'begin':
      // One read transaction for the rest of the load, opened once every reader has found its
      // cells: each snapshot then holds every tile the cells phase saw.
      db.exec('BEGIN');
      db.prepare('SELECT 1 FROM ocl_meta LIMIT 1').get();
      return {};
    case 'tiles':
      context.setBlocks(message.blocks);
      return runTiles(context, message);
    case 'index':
      return { rows: runIndex(context, message) };
    case 'columns':
      return runColumns(context, message);
    case 'zones':
      return { rows: runZones(context, message) };
    case 'sets':
      return runSets(context, message);
    case 'close':
      db.exec('COMMIT');
      db.close();
      return {};
    default:
      throw new Error('unknown phase');
  }
}
