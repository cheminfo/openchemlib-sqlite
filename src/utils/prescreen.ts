import type * as OpenChemLib from 'openchemlib';

import { prescreenPlanes } from '../planes/planePrescreen.ts';
import type { PrescreenPlan } from '../planes/planeRouter.ts';
import { choosePrescreenPath } from '../planes/planeRouter.ts';
import { TAIL_TABLE } from '../planes/planeSchema.ts';
import type { SQLiteDatabase, SearchCandidates } from '../types.ts';

import { prescreenColumn } from './prescreenColumn.ts';

export { buildPrescreenSql } from './prescreenColumn.ts';

type OCLLibrary = typeof OpenChemLib;
type OCLMolecule = InstanceType<OCLLibrary['Molecule']>;

/** One candidate that passed the fingerprint prefilter. */
export interface PrescreenedCandidate {
  entryId: number;
  idCode: string;
  mw: number;
}

export interface PrescreenParams {
  db: SQLiteDatabase;
  entriesTable: string;
  /** Primary-key column of the entries table. */
  pkColumn: string;
  /** idCode column of the entries table. */
  idCodeColumn: string;
  /** Fragment flag must already be set to true before passing. */
  mol: OCLMolecule;
  timeoutMs: number;
  maxCandidates: number;
  onProgress?: (processed: number, total: number) => void;
  /** Restrict the prescreen to the entries returned by this subquery. */
  candidates?: SearchCandidates;
  /**
   * A proved floor on a match's molecular weight, from `queryMwBound()`.
   *
   * The index is clustered by weight, so this makes the scan start with a seek
   * instead of reading every lighter entry. Absent when no floor can be proved.
   */
  mwFloor?: number | null;
  /**
   * Whether `ocl_ss_index.mw` is known to hold the true molecular weight.
   *
   * It is when `insert()` derived it from the molecule. With a `mwColumn`
   * configured it holds whatever that column holds, which the library cannot
   * vouch for — a sort key, a rounded value, a different convention — so a
   * weight floor would silently drop real matches. False here simply means the
   * floor is not applied.
   * @default false
   */
  mwIsMolecularWeight?: boolean;
  /**
   * The most results the caller will keep, which the plane index needs to know.
   *
   * The plane path is only taken when it cannot truncate — see
   * {@link choosePrescreenPath}. Left out, it is unbounded, which is what an
   * ordinary search is.
   * @default Number.MAX_SAFE_INTEGER
   */
  maxResults?: number;
  /**
   * Whether the plane index may answer this prescreen at all.
   *
   * It is consulted only when it has been folded, when the query has a bit
   * selective enough to screen on, and when it cannot change the answer. This
   * turns it off regardless, which is what the column path is measured against.
   * @default true
   */
  planeIndex?: boolean;
  /**
   * The share of the index above which the column path wins.
   *
   * The crossover is where verification cost catches up with the scan the screen
   * saves, so it moves with how expensive one candidate is to verify — a larger
   * fragment has more atoms to match. 1% is measured for drug-like fragments.
   * @default 0.01
   */
  planeCandidateRatio?: number;
  /**
   * The table holding the fingerprints to screen.
   *
   * `ocl_ss_tail` has the same shape as `ocl_ss_index` and holds what has been
   * inserted since the last fold, so the plane path screens the folded entries
   * from its planes and the rest through this, with the same SQL.
   * @default 'ocl_ss_index'
   */
  screenTable?: string;
}

/** Mutable counters the prescreen reports back to its caller. */
export interface PrescreenState {
  /** Candidates yielded so far. */
  screened: number;
  /** True when the prescreen stopped on the timeout or `maxCandidates`. */
  partial: boolean;
  /**
   * True when the plane index answered, so candidates arrived in slot order
   * rather than ascending molecular weight and the caller must sort them.
   */
  usedPlaneIndex?: boolean;
}

/**
 * Yield every entry whose stored fingerprint is a superset of the query's.
 *
 * Two prescreens answer this, and {@link choosePrescreenPath} picks between
 * them per query, by measuring rather than guessing: intersecting the planes and
 * counting what survives costs milliseconds, and the count is what decides.
 *
 * The **plane index** reads only the planes of the bits the query sets, so it
 * does not grow with the library. It is taken when the query has a selective
 * bit, when candidates are few enough that verification will not swamp the
 * saving, and when the result set cannot be truncated — that last condition is
 * what makes it exactly equivalent, since it yields slot order and the caller
 * sorts by weight before answering.
 *
 * The **column path** below answers everything else, lightest-first and
 * streaming, and is what a common fragment with an early stop wants: it reads a
 * few hundred rows and abandons the cursor.
 *
 * A folded database still has whatever was inserted since, so the plane path
 * chains the column path over `ocl_ss_tail` behind its own stream. The tail is
 * small by design, and empty right after a fold.
 * @param params - Prescreen parameters; `params.mol.fragment` must already be true.
 * @param state - Mutable counters updated as the stream is consumed.
 * @yields {PrescreenedCandidate} Each prescreened candidate.
 */
export function* prescreen(
  params: PrescreenParams,
  state: PrescreenState,
): Generator<PrescreenedCandidate> {
  const plan = planFor(params);
  if (plan.kind === 'column') {
    yield* prescreenColumn(params, state);
    return;
  }

  state.usedPlaneIndex = true;
  yield* prescreenPlanes(params, state, plan.bits);
  if (state.partial) return;
  yield* prescreenColumn({ ...params, screenTable: TAIL_TABLE }, state);
}

/**
 * Which prescreen to run, including the cases that never reach the router.
 *
 * A `candidates` subquery stays on the column path whatever the query looks
 * like: its plan is tuned to keep `ocl_ss_index` the driving table so the scan
 * streams in weight order, and a membership-restricted scan is already small.
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
  return choosePrescreenPath(
    params.db,
    params.mol,
    params.maxResults ?? Number.MAX_SAFE_INTEGER,
    params.planeCandidateRatio,
  );
}
