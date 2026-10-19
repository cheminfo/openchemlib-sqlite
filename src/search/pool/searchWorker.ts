import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import { SEQ_SPAN } from '../../chemistry/key.ts';
import type { BlockViews } from '../blocks.ts';
import { blockViews } from '../blocks.ts';

import { newTally, tallyBlock } from './countSink.ts';
import type {
  CountPhase,
  IndexedBlock,
  PhaseMessage,
  ScreenPhase,
  SearchWorkerData,
} from './messages.ts';
import type { ExactRow } from './rowFilter.ts';
import { rowFilter } from './rowFilter.ts';
import type { Collected, ScreenContext } from './screenKernel.ts';
import { screenWords } from './screenKernel.ts';
import type { SetWords } from './setWords.ts';
import { setWords } from './setWords.ts';
import type { WorkerParts } from './similarityRun.ts';
import { offsets, runSimilarity } from './similarityRun.ts';
import { runVerify } from './verifyWorker.ts';

const data = workerData as SearchWorkerData;
const port = parentPort as NonNullable<typeof parentPort>;
const control = new Int32Array(data.control);
const table: IndexedBlock[] = [];
for (const block of data.blocks) table[block.index] = block;
const views = new Map<number, BlockViews>();
const db = new DatabaseSync(data.file, { readOnly: true });
db.exec('PRAGMA busy_timeout = 30000');
const exactStatement = db.prepare(data.columnsSql);
exactStatement.setReturnArrays(true);
const exact: ExactRow = (id) =>
  exactStatement.get({ from: id, to: id }) as unknown[] | undefined;

function viewsOf(b: number): BlockViews {
  let found = views.get(b);
  if (found === undefined) {
    found = blockViews(table[b] as IndexedBlock, data.layout);
    views.set(b, found);
  }
  return found;
}

const parts: WorkerParts = {
  port,
  control,
  worker: data.worker,
  layout: data.layout,
  block: (b) => table[b] as IndexedBlock,
  views: viewsOf,
  exact,
};

port.on(
  'message',
  (message: PhaseMessage | { type: 'blocks'; add: IndexedBlock[] }) => {
    if (message.type === 'screen') {
      runScreen(message);
    } else if (message.type === 'count') {
      runCount(message);
    } else if (message.type === 'verify') {
      runVerify(message, db, control, data);
    } else if (message.type === 'sim') {
      runSimilarity(message, parts);
    } else if (message.type === 'blocks') {
      for (const block of message.add) table[block.index] = block;
    }
  },
);
port.postMessage({ type: 'ready', worker: data.worker });

function runScreen(m: ScreenPhase): void {
  const sets = setWords(m.sets);
  const out: Collected = {
    n: 0,
    key: new Float64Array(1024),
    id: new Float64Array(1024),
  };
  const done = eachUnit(m, sets, (context, e0, e1) => {
    screenWords(context, m.entries, e0, e1, out, null, false);
  });
  port.postMessage(
    {
      type: 'screened',
      gen: m.gen,
      units: done,
      n: out.n,
      key: out.key,
      id: out.id,
    },
    [out.key.buffer as ArrayBuffer, out.id.buffer as ArrayBuffer],
  );
  port.postMessage({ type: 'idle', gen: m.gen, worker: data.worker });
}

function runCount(m: CountPhase): void {
  const sets = setWords(m.sets);
  const tally = newTally(m, exact);
  let tallied = -1;
  const done = eachUnit(m, sets, (context, e0, e1, b, u) => {
    if (b !== tallied) {
      tallied = b;
      tallyBlock(tally, viewsOf(b), data.layout, context.kBase);
    }
    screenWords(context, m.entries, e0, e1, null, tally, m.whole[u] === 1);
  });
  port.postMessage(
    { type: 'counted', gen: m.gen, units: done, tallies: tally.tallies },
    [tally.tallies.buffer as ArrayBuffer],
  );
  port.postMessage({ type: 'idle', gen: m.gen, worker: data.worker });
}

/**
 * Runs the units this worker takes, until none is left or the phase moved on: the entries of one
 * block one after the other go to the kernel in one call.
 * @param m - The phase.
 * @param sets - Its set expression.
 * @param run - Runs entries [e0, e1) of block b, of unit u.
 * @returns How many units it ran.
 */
function eachUnit(
  m: ScreenPhase | CountPhase,
  sets: SetWords,
  run: (
    context: ScreenContext,
    e0: number,
    e1: number,
    b: number,
    u: number,
  ) => void,
): number {
  const next = new Int32Array(m.counter);
  let done = 0;
  let b = -1;
  let context: ScreenContext | null = null;
  while (Atomics.load(control, 0) === m.gen) {
    const u = Atomics.add(next, 0, 1);
    if (u >= m.units.length / 2) break;
    const e1 = m.units[2 * u + 1] as number;
    for (let e = m.units[2 * u] as number; e < e1;) {
      if (m.entries[4 * e] !== b) {
        b = m.entries[4 * e] as number;
        context = screenContext(m, b, sets);
      }
      let to = e + 1;
      while (to < e1 && m.entries[4 * to] === b) to++;
      run(context as ScreenContext, e, to, b, u);
      e = to;
    }
    done++;
  }
  return done;
}

function screenContext(
  m: ScreenPhase | CountPhase,
  b: number,
  sets: SetWords,
): ScreenContext {
  const view = viewsOf(b);
  const block = table[b] as IndexedBlock;
  return {
    planes: view.planes,
    poff: offsets(m.planes, view.W),
    flip: m.flips,
    restrictionAt: m.restrictionAt,
    sets,
    single: sets.single,
    aoff: offsets(m.anyPlanes, view.W),
    anyCount: m.anyPlanes.length,
    base: block.start >>> 5,
    kBase: block.atoms * SEQ_SPAN,
    seq: view.seq,
    key: view.key,
    lo: m.lo,
    hi: m.hi,
    end: m.end,
    cursorKey: m.type === 'screen' ? m.cursorKey : -Infinity,
    cursorId: m.type === 'screen' ? m.cursorId : -1,
    keep: rowFilter(view, data.layout, m.bounds, exact),
  };
}
