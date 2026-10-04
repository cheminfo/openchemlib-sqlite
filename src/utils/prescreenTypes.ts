import type * as OpenChemLib from 'openchemlib';

import type {
  MwRange,
  SQLiteDatabase,
  ScanPosition,
  SearchCandidates,
} from '../types.ts';

import type { PrefilterPlan } from './prefilterPlan.ts';

type OCLMolecule = InstanceType<(typeof OpenChemLib)['Molecule']>;

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
  /**
   * The fragment's fingerprint, as `mol.getIndex()` returns it. Building it is
   * milliseconds of work, and a scan reads it in each of its phases, so the
   * prescreen builds it once and hands it on.
   * @default mol.getIndex()
   */
  queryIndex?: number[];
  timeoutMs: number;
  maxCandidates: number;
  onProgress?: (processed: number, total: number) => void;
  /** Restrict the prescreen to the entries returned by this subquery. */
  candidates?: SearchCandidates;
  /**
   * The caller's bounds on the indexed weight, sought on the clustered key.
   * @default {} — unbounded
   */
  mwRange?: MwRange;
  /**
   * Start after this candidate, sought on the clustered key.
   * @default undefined — from the first candidate
   */
  after?: ScanPosition;
  /**
   * When the scan must stop, in ms since the epoch, checked from inside SQLite
   * by the deadline guard. Null leaves the guard out, which a statement built
   * for a connection that lacks the guard's function must do.
   * @default null
   */
  deadline?: number | null;
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
   * An unbounded search may be answered from the planes outright; a bounded one
   * starts on the column scan and moves to the planes only if that turns out
   * slow — see `choosePrescreenPath()`.
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
   * When a bounded scan considers the plane index, in ms after it started,
   * replacing the router's estimate; it then moves to the planes at that point
   * whenever they accept the scan, without weighing the cost first. Meant for
   * tests and measurements, which need the switch to happen on demand.
   * @default undefined — the router's checkpoint, and the cost weighed
   */
  planeCheckpointMs?: number;
}

/** Mutable counters the prescreen reports back to its caller. */
export interface PrescreenState {
  /** Candidates yielded so far. */
  screened: number;
  /** True when the prescreen stopped on the timeout or `maxCandidates`. */
  partial: boolean;
  /** True when it was the timeout that stopped it. */
  timedOut?: boolean;
  /**
   * True when the plane index answered in slot order, so candidates arrived
   * out of ascending molecular weight and the caller must sort them.
   */
  usedPlaneIndex?: boolean;
  /**
   * Where a column scan stopped because it reached its checkpoint rather than
   * its end: every candidate up to this position, exclusive of nothing after
   * it, has been yielded. Set only by a scan given a checkpoint.
   */
  checkpoint?: ScanPosition;
  /**
   * True when a bounded scan started on the column path and finished from the
   * plane index, which it reads in the same `(mw, entry_id)` order.
   */
  switchedToPlanes?: boolean;
  /**
   * Candidates the caller has finished verifying, which it reports so a
   * bounded scan can judge how far it is from its page.
   */
  verified?: number;
  /** Matches among {@link PrescreenState.verified}, reported by the caller. */
  matched?: number;
  /**
   * The prefilter plan a column scan measured on its own rows, kept so that
   * the same scan resumed after a checkpoint does not measure it again.
   */
  prefilterPlan?: PrefilterPlan;
}
