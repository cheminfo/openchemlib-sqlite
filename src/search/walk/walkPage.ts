import type { Layout } from '../layout.ts';
import type { SearchPool } from '../pool/SearchPool.ts';
import type { ScreenedReply } from '../pool/messages.ts';
import type { ColumnBound } from '../pool/rowFilter.ts';
import type { SetExpression } from '../setExpression.ts';

import { orderByKeyId } from './order.ts';
import type { HungMemory, WalkCounters } from './verifySlice.ts';
import { verifySlice } from './verifySlice.ts';

/** A position in the answer order. */
export interface KeyCursor {
  key: number;
  id: number;
}

/**
 * A substructure query as the walk runs it. A browse is never verified: it has no query planes,
 * only the key planes of its search.
 */
export interface SubstructurePlan {
  browse: boolean;
  /** The query, as the verifier takes it. */
  queryIdCode: string;
  /** Its bits and the search's key planes, as plane numbers, by survival ascending. */
  planes: Int32Array;
  /** Per plane: 0 for a plane a row must hold, -1 for one it must lack. */
  flips: Int32Array;
  /** The planes of the search's OR group of keys, empty for none. */
  anyPlanes: Int32Array;
  /** Its atom floor: no molecule with fewer atoms can match. */
  floor: number;
}

/** One page of a substructure search or a browse. */
export interface WalkTask {
  layout: Layout;
  plan: SubstructurePlan;
  sets: SetExpression;
  restrictionAt: number;
  bounds: ColumnBound[];
  keyMin: number;
  keyMax: number;
  limit: number;
  /** A performance.now() time. */
  deadline: number;
  signal?: AbortSignal;
  cursor: KeyCursor | null;
  firstSliceRows: number;
  hung: HungMemory;
  searchId: number;
  verifyChunkMinMs: number;
  verifyChunkFactor: number;
  verifySingleMs: number;
}

/** How a page ended, and what it answers. */
export interface WalkResult {
  reason: 'full' | 'exhausted' | 'deadline' | 'abort';
  hits: KeyCursor[];
  /** Where the next page starts; undefined when the walk is exhausted. */
  resume: KeyCursor | undefined;
  counters: WalkCounters;
}

/**
 * One page: the key axis is walked in slices sized by row count from the histogram (the first
 * `firstSliceRows`, then twice the last). Per slice the workers screen every band whose zone meets
 * it, in the atom counts at or above the floor, and keep the rows inside the slice and after the
 * cursor; the candidates are put in (key, id) order and verified in that order, the in-order prefix
 * answered. A partial answer is therefore an exact prefix of the full order, its cursor just before
 * the first row not settled. keyMin and keyMax bound the walk. A browse is the same walk with no
 * query planes and no verification: its key planes are exact.
 * @param pool - The workers.
 * @param task - The page.
 * @returns The page.
 */
export async function walkPage(
  pool: SearchPool,
  task: WalkTask,
): Promise<WalkResult> {
  const { layout, plan, limit, deadline, signal, sets, restrictionAt, bounds } =
    task;
  const { keyMin, keyMax: end, firstSliceRows, cursor: from } = task;
  let cursor: KeyCursor = { key: keyMin, id: -1 };
  if (from !== null && after(from, cursor)) cursor = from;
  const hits: KeyCursor[] = [];
  const counters: WalkCounters = {
    slices: 0,
    bands: 0,
    rows: 0,
    candidates: 0,
    verified: 0,
    unverified: 0,
    unverifiedNew: 0,
    kills: 0,
    pendingBatches: 0,
  };
  const answer = (
    reason: WalkResult['reason'],
    resume?: KeyCursor,
  ): WalkResult => ({
    reason,
    hits,
    resume,
    counters,
  });
  let settled = cursor;
  let lo = cursor.key;
  let target = firstSliceRows;
  for (;;) {
    if (lo > end) return answer('exhausted');
    const { end: hi } = layout.sliceEnd(lo, target);
    const last = hi > end || hi === Infinity;
    const work = layout.sliceUnits(lo, hi, end, plan.floor);
    counters.slices++;
    counters.bands += work.bands;
    counters.rows += work.rows;
    const nUnits = work.units.length / 2;
    if (nUnits > 0) {
      const parts: ScreenedReply[] = [];
      let unitsDone = 0;
      // eslint-disable-next-line no-await-in-loop -- slices are walked in order, each from where the last ended
      const screen = await pool.phase(
        {
          type: 'screen',
          entries: work.entries,
          units: work.units,
          counter: new SharedArrayBuffer(4),
          planes: plan.planes,
          flips: plan.flips,
          anyPlanes: plan.anyPlanes,
          sets,
          restrictionAt,
          lo,
          hi,
          end,
          cursorKey: cursor.key,
          cursorId: cursor.id,
          bounds,
        },
        {
          deadline,
          signal,
          onMessage: (reply) => {
            const part = reply as ScreenedReply;
            parts.push(part);
            unitsDone += part.units;
            return unitsDone === nUnits;
          },
        },
      );
      if (screen.reason !== 'done') return answer(screen.reason, settled);
      const { sortedKey, sortedId, n } = sortCandidates(parts);
      counters.candidates += n;
      if (plan.browse) {
        const take = Math.min(n, limit - hits.length);
        for (let i = 0; i < take; i++) {
          hits.push({ key: sortedKey[i] as number, id: sortedId[i] as number });
        }
        if (hits.length === limit) return answer('full', hits.at(-1));
      } else if (n > 0) {
        // eslint-disable-next-line no-await-in-loop -- a slice is verified before the next is screened
        const verified = await verifySlice(
          pool,
          task,
          sortedKey,
          sortedId,
          n,
          hits,
          counters,
        );
        counters.pendingBatches = verified.pendingBatches;
        if (hits.length === limit) return answer('full', hits.at(-1));
        if (verified.reason !== 'done') {
          const x = verified.settled;
          return answer(
            verified.reason,
            x < n
              ? { key: sortedKey[x] as number, id: (sortedId[x] as number) - 1 }
              : { key: hi, id: -1 },
          );
        }
      }
    }
    if (last) return answer('exhausted');
    settled = { key: hi, id: -1 };
    cursor = settled;
    lo = hi;
    target *= 2;
  }
}

/**
 * Whether a position comes after another in the answer order.
 * @param a - The position.
 * @param b - The other.
 * @returns True when a is strictly after b.
 */
export function after(a: KeyCursor, b: KeyCursor): boolean {
  return a.key > b.key || (a.key === b.key && a.id > b.id);
}

function sortCandidates(parts: ScreenedReply[]): {
  sortedKey: Float64Array;
  sortedId: Float64Array;
  n: number;
} {
  let n = 0;
  for (const part of parts) n += part.n;
  const key = new Float64Array(n);
  const id = new Float64Array(n);
  let offset = 0;
  for (const part of parts) {
    key.set(part.key.subarray(0, part.n), offset);
    id.set(part.id.subarray(0, part.n), offset);
    offset += part.n;
  }
  const order = orderByKeyId(key, id, n);
  const sortedKey = new Float64Array(n);
  const sortedId = new Float64Array(
    new SharedArrayBuffer(8 * Math.max(1, n)),
    0,
    n,
  );
  for (let i = 0; i < n; i++) {
    sortedKey[i] = key[order[i] as number] as number;
    sortedId[i] = id[order[i] as number] as number;
  }
  return { sortedKey, sortedId, n };
}
