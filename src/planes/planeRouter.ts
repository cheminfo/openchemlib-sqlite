import type * as OpenChemLib from 'openchemlib';

import type { SQLiteDatabase } from '../types.ts';

import {
  planeCoverage,
  planeQueryBits,
  planeSurvivorCount,
} from './planePrescreen.ts';

type OCLMolecule = InstanceType<(typeof OpenChemLib)['Molecule']>;

/**
 * The share of the index above which the plane path stops being worth taking.
 *
 * Verification costs ~8 µs a candidate against ~0.25 µs a row for the clustered
 * column scan, so the two break even once candidates reach about 1.4% of the
 * index: below that the prescreen *was* the query's cost and removing it is a
 * 4–8× win, above it verification swamps whatever the screen saves. Measured
 * end to end on 2 M entries, and the ratio is scale-invariant — both sides grow
 * linearly — so the same figure holds at 500 M.
 */
export const PLANE_MAX_CANDIDATE_RATIO = 0.01;

/** Which prescreen a query should run on, and why. */
export type PrescreenPlan =
  | { kind: 'column'; reason: string }
  | { kind: 'plane'; bits: number[]; survivors: number };

/**
 * Decide whether a query is better served by the plane index.
 *
 * Deciding is cheap enough to be worth doing properly: intersecting the planes
 * and counting what survives costs 1–9 ms at 2 M entries, so the router measures
 * the query instead of guessing at it, then throws the bitmap away if the answer
 * is no.
 *
 * The plane path is taken only when `survivors <= maxResults`. That is what
 * keeps it exactly equivalent: with no truncation the two paths return the same
 * set, and the caller sorts by molecular weight before answering, so the order
 * is the same too. The plane index yields slot order, which is only *mostly* mw
 * order across several folds, and this is how that stops being observable
 * rather than something to apologise for.
 * @param db - The database to read.
 * @param mol - The query fragment; its fragment flag must already be set.
 * @param maxResults - The most results the caller will keep.
 * @param maxCandidateRatio - The share of the index above which the column path
 *   wins; defaults to {@link PLANE_MAX_CANDIDATE_RATIO}.
 * @returns Which prescreen to run.
 */
export function choosePrescreenPath(
  db: SQLiteDatabase,
  mol: OCLMolecule,
  maxResults: number,
  maxCandidateRatio: number = PLANE_MAX_CANDIDATE_RATIO,
): PrescreenPlan {
  const { slots } = planeCoverage(db);
  if (slots === 0) {
    return { kind: 'column', reason: 'the plane index is empty' };
  }

  const bits = planeQueryBits(db, mol.getIndex());
  if (bits === null) {
    // Every bit the fragment sets is one the fold dropped as too common to
    // screen on. Benzene in a drug-like library is the canonical case: it is a
    // subgraph of most entries, so there is nothing to narrow.
    return {
      kind: 'column',
      reason: 'no bit of the query is selective enough',
    };
  }

  const survivors = planeSurvivorCount(db, bits);
  if (survivors > maxResults) {
    return {
      kind: 'column',
      reason: 'the result set would be truncated, so the order is observable',
    };
  }
  if (survivors > slots * maxCandidateRatio) {
    return {
      kind: 'column',
      reason: 'too many candidates for the screen to pay for itself',
    };
  }

  return { kind: 'plane', bits, survivors };
}
