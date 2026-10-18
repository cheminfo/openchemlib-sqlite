import type { SimilarityFingerprint } from '../fingerprint.ts';
import type { Layout } from '../layout.ts';
import type { SearchPool } from '../pool/SearchPool.ts';
import type { SimilarityReply } from '../pool/messages.ts';
import type { ColumnBound } from '../pool/rowFilter.ts';

/** A position in a ranked answer: score descending, then id ascending, in one fingerprint. */
export interface ScoreCursor {
  score: number;
  id: number;
  /**
   * The fingerprint the scores are in; a search on another refuses the cursor.
   * @default 'fragFp'
   */
  fingerprint?: SimilarityFingerprint;
}

/** A similarity query as the scan runs it. */
export interface SimilarityPlan {
  /** The fingerprint scored. */
  fingerprint: SimilarityFingerprint;
  /** The query's bits in that fingerprint, as plane numbers, rarest first. */
  planes: Int32Array;
  qBits: number;
  /** The bit-count window a row must lie in to reach the threshold. */
  low: number;
  high: number;
  threshold: number;
  /** The least shared count some bit count of the window passes with, and qBits − mMin. */
  mMin: number;
  D: number;
  /** The query's atom count: units are read nearest atom count first. */
  atoms: number;
}

/** One ranked page. */
export interface SimilarityTask {
  layout: Layout;
  plan: SimilarityPlan;
  restriction: SharedArrayBuffer;
  bounds: ColumnBound[];
  keyMin: number;
  keyMax: number;
  limit: number;
  deadline: number;
  signal?: AbortSignal;
  cursor: ScoreCursor | null;
  unitWords: number;
}

/** What a ranked page found. */
export interface SimilarityResult {
  reason: 'exhausted' | 'incomplete' | 'deadline' | 'abort';
  /** The best rows after the cursor: [id, score] pairs, in order. */
  top: Array<[number, number]>;
  /** Rows reaching the threshold, all of them (exact when complete). */
  total: number;
  /** Of those, the rows after the cursor. */
  afterTotal: number;
  /** Rows whose Tanimoto was computed (inside the bit-count window and the filters). */
  scored: number;
  units: number;
  unitsDone: number;
}

/**
 * One ranked similarity page. Complete, it holds the exact best `limit` rows after the cursor and
 * the exact totals; partial (the deadline came first), the best of the units read whole, which run
 * nearest atom count first.
 * @param pool - The workers.
 * @param task - The page.
 * @returns The page.
 */
export async function similarityPage(
  pool: SearchPool,
  task: SimilarityTask,
): Promise<SimilarityResult> {
  const { layout, plan, limit, unitWords, restriction, bounds } = task;
  const { keyMin, keyMax, cursor, deadline, signal } = task;
  const { entries, units } = layout.similarityUnits(unitWords, plan.atoms);
  const nUnits = units.length / 2;
  const state = {
    top: [] as Array<[number, number]>,
    total: 0,
    afterTotal: 0,
    scored: 0,
    done: 0,
    reported: 0,
  };
  if (nUnits === 0 || plan.qBits === 0) {
    return {
      reason: 'exhausted',
      top: [],
      total: 0,
      afterTotal: 0,
      scored: 0,
      units: nUnits,
      unitsDone: 0,
    };
  }
  const result = await pool.phase(
    {
      type: 'sim',
      fingerprint: plan.fingerprint,
      entries,
      units,
      counter: new SharedArrayBuffer(4),
      planes: plan.planes,
      restriction,
      low: plan.low,
      high: plan.high,
      threshold: plan.threshold,
      qBits: plan.qBits,
      mMin: plan.mMin,
      D: plan.D,
      bounds,
      keyMin,
      keyMax,
      limit,
      afterScore: cursor?.score ?? null,
      afterId: cursor?.id ?? 0,
    },
    {
      deadline,
      signal,
      onMessage: (reply) => {
        const message = reply as SimilarityReply;
        state.reported++;
        if (!message.stopped) {
          state.done++;
          state.total += message.matched;
          state.afterTotal += message.afterCount;
          state.scored += message.scored;
          for (let i = 0; i < message.top.length; i += 2) {
            state.top.push([
              message.top[i] as number,
              message.top[i + 1] as number,
            ]);
          }
          if (state.top.length > 4 * limit) {
            state.top = rank(state.top).slice(0, limit);
          }
        }
        return state.reported === nUnits;
      },
    },
  );
  const reason =
    result.reason === 'done'
      ? state.done === nUnits
        ? 'exhausted'
        : 'incomplete'
      : result.reason;
  return {
    reason,
    top: rank(state.top).slice(0, limit),
    total: state.total,
    afterTotal: state.afterTotal,
    scored: state.scored,
    units: nUnits,
    unitsDone: state.done,
  };
}

function rank(pairs: Array<[number, number]>): Array<[number, number]> {
  return pairs.toSorted((a, b) => b[1] - a[1] || a[0] - b[0]);
}
