import { planeChunks } from '../planes/planeCoverage.ts';
import type { PrescreenPlan } from '../planes/planeRouter.ts';
import { RESOLVE_MS, UNFOLDED_MS } from '../planes/planeRouter.ts';
import type { Survivors } from '../planes/planeSurvivors.ts';
import { collectSurvivors } from '../planes/planeSurvivors.ts';
import { prescreenPlanesSorted } from '../planes/sortedPrescreen.ts';
import type { ScanPosition } from '../types.ts';

import { prescreenColumn } from './prescreenColumn.ts';
import type {
  PrescreenParams,
  PrescreenState,
  PrescreenedCandidate,
} from './prescreenTypes.ts';

type SwitchPlan = Extract<PrescreenPlan, { kind: 'switch' }>;

/**
 * Survivors resolved for each candidate a switched scan still needs: the
 * planes let through a superset, and the exact test, the weight bounds and the
 * position reject some.
 */
const SURVIVORS_PER_CANDIDATE = 4;

/**
 * Carry on a bounded scan that reached its checkpoint on the column path.
 *
 * The column path's own progress says how much is left of it: the time spent
 * so far, scaled by the candidates still needed over those found. While that
 * is less than an intersection costs, the scan simply carries on, and looks
 * again later. Otherwise the survivors are collected — stopping as soon as
 * there are more than the plane side accepts — and the scan moves to the
 * planes when finishing from them is the cheaper of the two. When it is not,
 * the column path gets as long again as the planes would take, and the scan
 * moves to them if it is still running then: the rule that bounds what a
 * folded index can add to a page while letting a page whose matches are rare
 * stop reading the whole index.
 * @param params - Prescreen parameters.
 * @param state - The counters, whose `checkpoint` says where the column stopped.
 * @param plan - The router's switch plan.
 * @param start - When the scan started, in ms since the epoch.
 * @yields {PrescreenedCandidate} The rest of the candidates, in `(mw, entry_id)` order.
 */
export function* continueAfterCheckpoint(
  params: PrescreenParams,
  state: PrescreenState,
  plan: SwitchPlan,
  start: number,
): Generator<PrescreenedCandidate> {
  const deadline = start + params.timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const maxResults = params.maxResults ?? Number.MAX_SAFE_INTEGER;
  const forced = params.planeCheckpointMs !== undefined;
  const columnLeft = () =>
    estimateColumnLeft(state, maxResults, Date.now() - start);
  let interval = plan.checkpointMs;
  let survivors: Survivors | undefined;

  for (;;) {
    const position = takeCheckpoint(state);
    const resumed = { ...params, after: position, timeoutMs: remaining() };
    if (survivors === undefined) {
      if (!forced && columnLeft() < 2 * plan.intersectMs) {
        interval *= 2;
        yield* prescreenColumn(resumed, state, {
          checkpoint: Date.now() + interval,
        });
        if (state.checkpoint === undefined) return;
        continue;
      }
      survivors = collectSurvivors(
        params.db,
        plan.bits,
        planeChunks(params.db),
        plan.limit,
      );
      if (survivors.exceeded) {
        yield* prescreenColumn({ ...resumed, timeoutMs: remaining() }, state);
        return;
      }
      const planeLeft = estimatePlaneLeft(
        survivors.count,
        maxResults - state.screened,
        plan.unfolded,
      );
      if (!forced && planeLeft > columnLeft()) {
        yield* prescreenColumn({ ...resumed, timeoutMs: remaining() }, state, {
          checkpoint: Date.now() + planeLeft,
        });
        if (state.checkpoint === undefined) return;
        continue;
      }
    }
    yield* prescreenPlanesSorted({ ...params, timeoutMs: remaining() }, state, {
      slots: survivors.slots,
      watermark: plan.watermark,
      position,
    });
    return;
  }
}

/**
 * How long finishing from the planes will take.
 *
 * The plane side streams in order and stops with the caller, so it resolves
 * the survivors up to its last candidate rather than all of them: a few for
 * each candidate still needed, every one only when the scan is unbounded. The
 * entries above the watermark are all screened, one seek each.
 * @param survivors - Slots the intersection left.
 * @param needed - Candidates the caller still needs.
 * @param unfolded - Entries above the watermark.
 * @returns The estimate, in ms.
 */
function estimatePlaneLeft(
  survivors: number,
  needed: number,
  unfolded: number,
): number {
  const resolved = Math.min(
    survivors,
    SURVIVORS_PER_CANDIDATE * Math.max(1, needed),
  );
  return resolved * RESOLVE_MS + unfolded * UNFOLDED_MS;
}

/**
 * How much longer a column scan will take, judged by its own progress.
 *
 * Progress is the matches the caller has verified, plus the candidates it is
 * still verifying counted at the rate the verified ones matched. A fragment
 * whose fingerprint lets through many molecules it does not match is thereby
 * not mistaken for one about to fill its page. A caller that reports nothing
 * is judged by its candidates alone.
 * @param state - The prescreen's counters.
 * @param maxResults - The most results the caller will keep.
 * @param elapsed - Time spent so far, in ms.
 * @returns The estimate, in ms; infinite when there is no progress to judge by.
 */
function estimateColumnLeft(
  state: PrescreenState,
  maxResults: number,
  elapsed: number,
): number {
  const { screened, verified, matched = 0 } = state;
  let progress = screened;
  if (verified !== undefined) {
    progress =
      verified === 0
        ? 0
        : matched + ((screened - verified) * matched) / verified;
  }
  if (progress <= 0 || maxResults >= Number.MAX_SAFE_INTEGER) {
    return Number.POSITIVE_INFINITY;
  }
  return (elapsed * Math.max(0, maxResults - progress)) / progress;
}

/**
 * Read and clear where a column scan stopped at its checkpoint.
 * @param state - The prescreen's counters.
 * @returns The position.
 */
function takeCheckpoint(state: PrescreenState): ScanPosition {
  const position = state.checkpoint as ScanPosition;
  delete state.checkpoint;
  return position;
}
