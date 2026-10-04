import { prescreenPlanes } from '../planes/planePrescreen.ts';
import type { PrescreenPlan } from '../planes/planeRouter.ts';
import { choosePrescreenPath } from '../planes/planeRouter.ts';
import { prescreenUnfolded } from '../planes/unfoldedPrescreen.ts';

import { continueAfterCheckpoint } from './planeSwitch.ts';
import { prescreenColumn } from './prescreenColumn.ts';
import type {
  PrescreenParams,
  PrescreenState,
  PrescreenedCandidate,
} from './prescreenTypes.ts';
import { weightFloor } from './queryMwBound.ts';

export { buildPrescreenSql } from './prescreenSql.ts';
export type {
  PrescreenParams,
  PrescreenState,
  PrescreenedCandidate,
} from './prescreenTypes.ts';

/**
 * Yield every entry whose stored fingerprint is a superset of the query's.
 *
 * Two prescreens answer this, and {@link choosePrescreenPath} picks between
 * them per query.
 *
 * The **column path** answers lightest-first and streaming, and is what a
 * common fragment with an early stop wants: it reads a few hundred rows and
 * abandons the cursor.
 *
 * The **plane index** reads only the planes of the bits the query sets, so it
 * does not grow with the library. An unbounded scan is answered from it in
 * slot order when few slots survive, and the caller sorts by weight. A bounded
 * scan starts on the column path and, if that is still running at its
 * checkpoint, may finish from the planes in the column path's own order — see
 * {@link continueAfterCheckpoint}.
 *
 * The planes answer only for the entries up to the watermark, so the plane
 * path also screens every entry above it, through `ocl_ss_index`'s entry index:
 * what was inserted since the last fold, and whatever a write below the
 * watermark has left untrusted. The router takes the plane path only while
 * those are few.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param state - Mutable counters updated as the stream is consumed.
 * @yields {PrescreenedCandidate} Each prescreened candidate.
 */
export function* prescreen(
  params: PrescreenParams,
  state: PrescreenState,
): Generator<PrescreenedCandidate> {
  const start = Date.now();
  // Both are milliseconds of work and every phase needs them.
  const scan: PrescreenParams = {
    ...params,
    queryIndex: params.queryIndex ?? params.mol.getIndex(),
    mwFloor: weightFloor(params),
  };
  const plan = planFor(scan);
  if (plan.kind === 'column') {
    yield* prescreenColumn(scan, state);
    return;
  }
  if (plan.kind === 'switch') {
    yield* prescreenColumn(scan, state, {
      checkpoint: start + (scan.planeCheckpointMs ?? plan.checkpointMs),
    });
    if (state.checkpoint === undefined) return;
    yield* continueAfterCheckpoint(scan, state, plan, start);
    return;
  }

  state.usedPlaneIndex = true;
  // The two never yield the same entry: the planes stop at the watermark and
  // this starts above it. One deadline covers both.
  const deadline = start + scan.timeoutMs;
  yield* prescreenUnfolded(scan, state, plan.watermark);
  if (state.partial) return;
  yield* prescreenPlanes(
    { ...scan, timeoutMs: Math.max(0, deadline - Date.now()) },
    state,
    plan.bits,
    plan.watermark,
    plan.slots,
  );
}

/**
 * Which prescreen to run, including the cases that never reach the router.
 *
 * A `candidates` subquery stays on the column path whatever the query looks
 * like: its plans are built around `ocl_ss_index` — scanned in weight order, or
 * read through its entry index — and the planes know nothing of the subquery.
 * A weight range or a resume position is a seek on the column path, so a scan
 * carrying one is never answered in slot order; it may still switch to the
 * planes, which apply both.
 * @param params - The prescreen parameters.
 * @returns The chosen path.
 */
function planFor(params: PrescreenParams): PrescreenPlan {
  if (params.planeIndex === false) {
    return { kind: 'column', reason: 'the plane index is switched off' };
  }
  if (params.candidates !== undefined) {
    return { kind: 'column', reason: 'the scan is restricted to a subquery' };
  }
  const sought =
    params.mwRange?.min !== undefined ||
    params.mwRange?.max !== undefined ||
    params.after !== undefined;
  return choosePrescreenPath(
    params.db,
    params.mol,
    params.maxResults ?? Number.MAX_SAFE_INTEGER,
    params.planeCandidateRatio,
    !sought,
    params.queryIndex,
  );
}
