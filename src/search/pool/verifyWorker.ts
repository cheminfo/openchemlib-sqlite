import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { parentPort } from 'node:worker_threads';

import { substructureSearch } from 'openchemlib-search-wasm';

import type { SearchWorkerData, VerifyPhase } from './messages.ts';
import { WATCH } from './messages.ts';

const port = parentPort as NonNullable<typeof parentPort>;
const now = () => performance.timeOrigin + performance.now();

/** Milliseconds this worker spends verifying one candidate (moving average), per phase. */
let msPerCandidate: number | null = null;
/** The same over a whole search: what a chunk's own kill limit is a multiple of. */
let killEma: number | null = null;
let emaSearch = -1;
let idCodes: StatementSync | null = null;
let watch: Float64Array | null = null;

/**
 * The verification phase. Positions [0, n) are a slice's candidates in (key, id) order; `state`
 * (shared) says which are still to verify in a chunk (0), are settled (1), or may only be verified
 * alone (2: a candidate of a chunk the watchdog killed). Work comes from the repair queue first
 * (entries the coordinator adds after a kill), then from the batches, pulled in order. Before each
 * wasm call the worker writes in its watch slot when the call may be killed and what it holds.
 * @param m - The phase.
 * @param db - The worker's read connection.
 * @param control - The pool's control word: the phase under way.
 * @param data - The worker's start data.
 */
export function runVerify(
  m: VerifyPhase,
  db: DatabaseSync,
  control: Int32Array,
  data: SearchWorkerData,
): void {
  if (idCodes === null) {
    idCodes = db.prepare(
      'SELECT id, idCode FROM ocl_molecule WHERE id IN (SELECT value FROM json_each(?))',
    );
    idCodes.setReturnArrays(true);
    watch = new Float64Array(data.watch);
  }
  const next = new Int32Array(m.counter);
  const ids = new Float64Array(m.ids);
  const state = new Uint8Array(m.state);
  const repair = new Int32Array(m.repair);
  if (m.searchId !== emaSearch) {
    emaSearch = m.searchId;
    killEma = null;
  }
  msPerCandidate = null;
  while (Atomics.load(control, 0) === m.gen) {
    const entry = takeRepair(repair);
    if (entry !== null) {
      if (entry.single) {
        verifyAlone(ids, state, entry.from, m, data.worker);
      } else {
        verifyRange(
          ids,
          state,
          entry.from,
          entry.to,
          -1,
          m,
          data.worker,
          control,
        );
      }
      continue;
    }
    const j = Atomics.add(next, 0, 1);
    if (j >= m.batches.length - 1) break;
    verifyRange(
      ids,
      state,
      m.batches[j] as number,
      m.batches[j + 1] as number,
      j,
      m,
      data.worker,
      control,
    );
  }
  port.postMessage({ type: 'idle', gen: m.gen, worker: data.worker });
}

/**
 * The next repair entry.
 * @param repair - The queue: [written, read, then (from, to, single) triples].
 * @returns The entry, or null when the queue is empty.
 */
function takeRepair(
  repair: Int32Array,
): { from: number; to: number; single: boolean } | null {
  for (;;) {
    const read = Atomics.load(repair, 1);
    if (read >= Atomics.load(repair, 0)) return null;
    if (Atomics.compareExchange(repair, 1, read, read + 1) === read) {
      const at = 2 + 3 * read;
      return {
        from: repair[at] as number,
        to: repair[at + 1] as number,
        single: repair[at + 2] === 1,
      };
    }
  }
}

function verifyRange(
  ids: Float64Array,
  state: Uint8Array,
  from: number,
  to: number,
  batch: number,
  m: VerifyPhase,
  worker: number,
  control: Int32Array,
): void {
  let at = from;
  while (at < to && Atomics.load(control, 0) === m.gen) {
    let count = to - at;
    // Near the deadline, chunks shrink to what this worker verifies in half the time left.
    if (msPerCandidate !== null) {
      const left = m.deadlineAt - now();
      count =
        left <= 0
          ? Math.min(count, 8)
          : Math.max(
              8,
              Math.min(count, Math.floor(left / (2 * msPerCandidate))),
            );
    }
    const positions: number[] = [];
    for (let i = at; i < at + count; i++) if (state[i] === 0) positions.push(i);
    const part = verify(ids, positions, m, worker, {
      at,
      count,
      rangeEnd: to,
      single: false,
    });
    port.postMessage({
      type: 'verified',
      gen: m.gen,
      batch,
      from: at,
      to: at + count,
      single: false,
      ...part,
    });
    at += count;
  }
}

function verifyAlone(
  ids: Float64Array,
  state: Uint8Array,
  position: number,
  m: VerifyPhase,
  worker: number,
): void {
  if (state[position] !== 2) return;
  const part = verify(ids, [position], m, worker, {
    at: position,
    count: 1,
    rangeEnd: position + 1,
    single: true,
  });
  port.postMessage({
    type: 'verified',
    gen: m.gen,
    batch: -1,
    from: position,
    to: position + 1,
    single: true,
    ...part,
  });
}

function verify(
  ids: Float64Array,
  positions: number[],
  m: VerifyPhase,
  worker: number,
  call: { at: number; count: number; rangeEnd: number; single: boolean },
): { hits: number[]; verified: number } {
  const list = positions.map((position) => ids[position] as number);
  const byId =
    list.length === 0
      ? new Map<number, string>()
      : new Map(
          (idCodes as StatementSync).all(
            JSON.stringify(list),
          ) as unknown as Array<[number, string]>,
        );
  const codes: string[] = [];
  const kept: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const idCode = byId.get(list[i] as number);
    // A molecule gone from the file is no match.
    if (idCode === undefined) continue;
    codes.push(idCode);
    kept.push(positions[i] as number);
  }
  const hits: number[] = [];
  if (codes.length > 0) {
    const w = watch as Float64Array;
    const started = performance.now();
    const limitMs = call.single
      ? m.singleMs
      : Math.max(
          m.chunkMinMs,
          killEma === null ? 0 : m.chunkFactor * codes.length * killEma,
        );
    const base = WATCH * worker;
    w[base + 1] = m.gen;
    w[base + 2] = call.at;
    w[base + 3] = call.count;
    w[base + 4] = call.rangeEnd;
    w[base + 5] = call.single ? 1 : 0;
    w[base] = Math.min(m.killAt, performance.timeOrigin + started + limitMs);
    const { indexes } = substructureSearch(m.queryIdCode, codes);
    w[base] = 0;
    const perCandidate = (performance.now() - started) / codes.length;
    msPerCandidate =
      msPerCandidate === null
        ? perCandidate
        : 0.7 * msPerCandidate + 0.3 * perCandidate;
    killEma =
      killEma === null ? perCandidate : 0.7 * killEma + 0.3 * perCandidate;
    for (const index of indexes) hits.push(kept[index] as number);
  }
  return { hits, verified: codes.length };
}
