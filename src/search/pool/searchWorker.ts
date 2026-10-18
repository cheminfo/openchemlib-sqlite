import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import { SEQ_SPAN } from '../../chemistry/key.ts';
import type { BlockViews } from '../blocks.ts';
import { blockViews } from '../blocks.ts';

import type {
  IndexedBlock,
  PhaseMessage,
  ScreenPhase,
  SearchWorkerData,
  SimilarityPhase,
} from './messages.ts';
import type { ExactRow } from './rowFilter.ts';
import { rowFilter } from './rowFilter.ts';
import type { Collected, ScreenContext } from './screenKernel.ts';
import { screenWords } from './screenKernel.ts';
import { similarityWords } from './similarityKernel.ts';
import type { SimilarityContext, SimilarityTally } from './similarityLane.ts';
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

port.on(
  'message',
  (message: PhaseMessage | { type: 'blocks'; add: IndexedBlock[] }) => {
    if (message.type === 'screen') {
      runScreen(message);
    } else if (message.type === 'verify') {
      runVerify(message, db, control, data);
    } else if (message.type === 'sim') {
      runSimilarity(message);
    } else if (message.type === 'blocks') {
      for (const block of message.add) table[block.index] = block;
    }
  },
);
port.postMessage({ type: 'ready', worker: data.worker });

function runScreen(m: ScreenPhase): void {
  const next = new Int32Array(m.counter);
  const restr = new Int32Array(m.restriction);
  const out: Collected = {
    n: 0,
    key: new Float64Array(1024),
    id: new Float64Array(1024),
  };
  let done = 0;
  let b = -1;
  let context: ScreenContext | null = null;
  while (Atomics.load(control, 0) === m.gen) {
    const u = Atomics.add(next, 0, 1);
    if (u >= m.units.length / 2) break;
    // Entries of one block one after the other go to the kernel in one call.
    const e1 = m.units[2 * u + 1] as number;
    for (let e = m.units[2 * u] as number; e < e1;) {
      if (m.entries[4 * e] !== b) {
        b = m.entries[4 * e] as number;
        context = screenContext(m, b, restr);
      }
      let to = e + 1;
      while (to < e1 && m.entries[4 * to] === b) to++;
      screenWords(context as ScreenContext, m.entries, e, to, out);
      e = to;
    }
    done++;
  }
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

function screenContext(
  m: ScreenPhase,
  b: number,
  restr: Int32Array,
): ScreenContext {
  const view = viewsOf(b);
  const block = table[b] as IndexedBlock;
  return {
    planes: view.planes,
    poff: Int32Array.from(m.planes, (plane) => plane * view.W),
    restrictionAt: m.restrictionAt,
    restr,
    base: block.start >>> 5,
    kBase: block.atoms * SEQ_SPAN,
    seq: view.seq,
    key: view.key,
    lo: m.lo,
    hi: m.hi,
    end: m.end,
    cursorKey: m.cursorKey,
    cursorId: m.cursorId,
    keep: rowFilter(view, data.layout, m.bounds, exact),
  };
}

function runSimilarity(m: SimilarityPhase): void {
  const next = new Int32Array(m.counter);
  const restr = new Int32Array(m.restriction);
  let b = -1;
  let context: SimilarityContext | null = null;
  while (Atomics.load(control, 0) === m.gen) {
    const u = Atomics.add(next, 0, 1);
    if (u >= m.units.length / 2) break;
    const tally: SimilarityTally = {
      scored: 0,
      matched: 0,
      afterCount: 0,
      kept: 0,
      hasAfter: m.afterScore !== null,
      afterScore: m.afterScore ?? 0,
      afterId: m.afterId,
      topId: new Float64Array(m.limit),
      topScore: new Float64Array(m.limit),
    };
    let stopped = false;
    const e1 = m.units[2 * u + 1] as number;
    for (let e = m.units[2 * u] as number; e < e1;) {
      if (Atomics.load(control, 0) !== m.gen) {
        stopped = true;
        break;
      }
      if (m.entries[4 * e] !== b) {
        b = m.entries[4 * e] as number;
        context = similarityContext(m, b, restr);
      }
      let to = e + 1;
      while (to < e1 && m.entries[4 * to] === b) to++;
      similarityWords(context as SimilarityContext, m.entries, e, to, tally);
      e = to;
    }
    const top = new Float64Array(2 * tally.kept);
    for (let i = 0; i < tally.kept; i++) {
      top[2 * i] = tally.topId[i] as number;
      top[2 * i + 1] = tally.topScore[i] as number;
    }
    port.postMessage({
      type: 'sim',
      gen: m.gen,
      scored: tally.scored,
      matched: tally.matched,
      afterCount: tally.afterCount,
      top,
      stopped,
    });
  }
  port.postMessage({ type: 'idle', gen: m.gen, worker: data.worker });
}

function similarityContext(
  m: SimilarityPhase,
  b: number,
  restr: Int32Array,
): SimilarityContext {
  const view = viewsOf(b);
  const block = table[b] as IndexedBlock;
  const filter = rowFilter(view, data.layout, m.bounds, exact);
  const keyMin = m.keyMin;
  const keyMax = m.keyMax;
  const key = view.key;
  return {
    planes: view.planes,
    poff: Int32Array.from(m.planes, (plane) => plane * view.W),
    restr,
    base: block.start >>> 5,
    kBase: block.atoms * SEQ_SPAN,
    seq: view.seq,
    bits: m.fingerprint === 'screen' ? view.screenBits : view.fragFpBits,
    bits2: m.fingerprint === 'both' ? view.screenBits : null,
    zoneMin: view.zones[m.fingerprint].min,
    zoneMax: view.zones[m.fingerprint].max,
    low: m.low,
    high: m.high,
    threshold: m.threshold,
    qBits: m.qBits,
    mMin: m.mMin,
    D: m.D,
    // In similarity the key bounds are plain filters.
    keep:
      keyMin === -Infinity && keyMax === Infinity
        ? filter
        : (row, id) => {
            const k = key[row] as number;
            return (
              k >= keyMin && k <= keyMax && (filter === null || filter(row, id))
            );
          },
  };
}
