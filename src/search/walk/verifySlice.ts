import type { SearchPool } from '../pool/SearchPool.ts';
import type { VerifiedReply } from '../pool/messages.ts';

import type { KeyCursor, WalkTask } from './walkPage.ts';

/** Candidates per verification batch at most. */
const BATCH = 256;

/**
 * What a query remembers across its pages: the candidates whose verification alone the watchdog
 * killed (left out, counted unverified, never verified again) and those of a killed chunk (verified
 * alone from then on). Both map an id to its key, which locates it in a slice.
 */
export interface HungMemory {
  unverified: Map<number, number>;
  suspects: Map<number, number>;
}

/** What a page did. */
export interface WalkCounters {
  slices: number;
  bands: number;
  rows: number;
  candidates: number;
  verified: number;
  /** Candidates left out because their verification was killed, this page. */
  unverified: number;
  /** Of those, the ones killed during this page. */
  unverifiedNew: number;
  kills: number;
  pendingBatches: number;
}

/**
 * Verifies one slice's candidates in (key, id) order: batches pulled by the workers, the prefix
 * answered as it settles. A watchdog kill settles nothing: a killed chunk's candidates are then
 * verified one by one and the rest of its range goes back to the queue; a candidate whose
 * verification alone is killed is left out, counted unverified, and the walk goes on past it.
 * @param pool - The workers.
 * @param task - The page.
 * @param sortedKey - The candidates' keys, in order.
 * @param sortedId - Their ids, in a shared buffer.
 * @param n - How many.
 * @param hits - Receives the matches, in order.
 * @param counters - Updated.
 * @returns How it ended; every candidate before `settled` is decided.
 */
export async function verifySlice(
  pool: SearchPool,
  task: WalkTask,
  sortedKey: Float64Array,
  sortedId: Float64Array,
  n: number,
  hits: KeyCursor[],
  counters: WalkCounters,
): Promise<{
  reason: 'done' | 'deadline' | 'abort';
  settled: number;
  pendingBatches: number;
}> {
  const { hung, limit, plan, searchId, deadline, signal } = task;
  const { verifyChunkMinMs, verifyChunkFactor, verifySingleMs } = task;
  const bounds = [0];
  let size = Math.min(BATCH, Math.max(16, 2 * (limit - hits.length)));
  while ((bounds.at(-1) as number) < n) {
    bounds.push(Math.min(n, (bounds.at(-1) as number) + size));
    size = Math.min(BATCH, 2 * size);
  }
  // state (shared): 0 to verify in a chunk, 1 settled, 2 to verify alone.
  // outcome: 0 open, 1 no match, 2 match, 3 unverified.
  const state = new Uint8Array(new SharedArrayBuffer(Math.max(1, n)));
  const outcome = new Uint8Array(n);
  const capacity = Math.min(n, 65_536) + 1024;
  const repair = new Int32Array(new SharedArrayBuffer(4 * (2 + 3 * capacity)));
  const enqueue = (from: number, to: number, single: boolean) => {
    const w = Atomics.load(repair, 0);
    if (w >= capacity) return;
    Atomics.store(repair, 2 + 3 * w, from);
    Atomics.store(repair, 3 + 3 * w, to);
    Atomics.store(repair, 4 + 3 * w, single ? 1 : 0);
    Atomics.store(repair, 0, w + 1);
  };
  const positionOf = (id: number, key: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((sortedKey[mid] as number) < key) lo = mid + 1;
      else hi = mid;
    }
    for (let p = lo; p < n && sortedKey[p] === key; p++) {
      if (sortedId[p] === id) return p;
    }
    return -1;
  };
  const first = sortedKey[0] as number;
  const lastKey = sortedKey[n - 1] as number;
  for (const [id, key] of hung.unverified) {
    if (key < first || key > lastKey) continue;
    const p = positionOf(id, key);
    if (p >= 0) {
      state[p] = 1;
      outcome[p] = 3;
    }
  }
  for (const [id, key] of hung.suspects) {
    if (key < first || key > lastKey) continue;
    const p = positionOf(id, key);
    if (p >= 0 && state[p] === 0) {
      state[p] = 2;
      enqueue(p, p + 1, true);
    }
  }
  let prefix = 0;
  const advance = () => {
    while (prefix < n && hits.length < limit) {
      const o = outcome[prefix];
      if (o === 0) break;
      if (o === 2) {
        hits.push({
          key: sortedKey[prefix] as number,
          id: sortedId[prefix] as number,
        });
      } else if (o === 3) {
        counters.unverified++;
      }
      prefix++;
    }
    return hits.length === limit || prefix === n;
  };
  const settle = (p: number, value: number) => {
    if (outcome[p] !== 0) return;
    outcome[p] = value;
    state[p] = 1;
  };
  const result = await pool.phase(
    {
      type: 'verify',
      ids: sortedId.buffer as SharedArrayBuffer,
      n,
      batches: Int32Array.from(bounds),
      counter: new SharedArrayBuffer(4),
      state: state.buffer,
      repair: repair.buffer,
      queryIdCode: plan.queryIdCode,
      searchId,
      chunkMinMs: verifyChunkMinMs,
      chunkFactor: verifyChunkFactor,
      singleMs: verifySingleMs,
    },
    {
      deadline,
      signal,
      onMessage: (reply) => {
        const message = reply as VerifiedReply;
        counters.verified += message.verified;
        for (const p of message.hits) settle(p, 2);
        if (message.single) {
          settle(message.from, 1);
          hung.suspects.delete(sortedId[message.from] as number);
        } else {
          for (let p = message.from; p < message.to; p++) {
            if (state[p] === 0) settle(p, 1);
          }
        }
        return advance();
      },
      onKill: (call, running) => {
        counters.kills++;
        if (call.single) {
          const p = call.at;
          if (outcome[p] === 0) {
            settle(p, 3);
            counters.unverifiedNew++;
          }
          hung.unverified.set(sortedId[p] as number, sortedKey[p] as number);
          hung.suspects.delete(sortedId[p] as number);
          return running === null ? false : advance();
        }
        // A chunk: its candidates are verified alone from now on (this page, or a later one).
        for (let p = call.at; p < call.at + call.count; p++) {
          if (state[p] !== 0) continue;
          hung.suspects.set(sortedId[p] as number, sortedKey[p] as number);
          if (running !== null) {
            state[p] = 2;
            enqueue(p, p + 1, true);
          }
        }
        if (running !== null) {
          if (call.at + call.count < call.rangeEnd) {
            enqueue(call.at + call.count, call.rangeEnd, false);
          }
          pool.wake(running.gen);
        }
        return false;
      },
    },
  );
  return {
    reason: result.reason,
    settled: prefix,
    pendingBatches: result.pendingBatches,
  };
}
