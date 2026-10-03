import type * as OpenChemLib from 'openchemlib';

import type { SQLiteDatabase } from '../types.ts';

import { countAbove, highestEntryId, readFoldState } from './foldState.ts';
import {
  planeCoverage,
  planeQueryBits,
  planeSurvivorCount,
} from './planeCoverage.ts';

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

/**
 * The share of the folded entries that may wait above the watermark before the
 * plane path stops being worth taking.
 *
 * Those entries are screened one seek on the entry index at a time, which costs
 * several times a row of the clustered scan; past this share they cost more
 * than the planes save.
 */
export const PLANE_MAX_UNFOLDED_RATIO = 0.05;

/**
 * The most index keys the router walks to count the entries above the
 * watermark: about 3 ms, so a query never pays more than that to be routed.
 */
const MAX_COUNTED = 65_536;

/** Which prescreen a query should run on, and why. */
export type PrescreenPlan =
  | { kind: 'column'; reason: string }
  | { kind: 'plane'; bits: number[]; survivors: number; watermark: number };

/**
 * How many entries above the watermark the plane path accepts whatever the
 * size of the index: a thousand seeks cost about a millisecond.
 */
const MIN_UNFOLDED_LIMIT = 1024;

/**
 * How many entries may wait above the watermark for a plane index of a size.
 * @param folded - The slots the plane index covers.
 * @returns The most entries above the watermark the plane path accepts.
 */
export function unfoldedLimit(folded: number): number {
  return Math.max(
    MIN_UNFOLDED_LIMIT,
    Math.floor(folded * PLANE_MAX_UNFOLDED_RATIO),
  );
}

/**
 * Decide whether a query is better served by the plane index.
 *
 * Deciding is cheap enough to be worth doing properly: intersecting the planes
 * and counting what survives costs 1–9 ms at 2 M entries, so the router measures
 * the query instead of guessing at it, then throws the bitmap away if the answer
 * is no.
 *
 * The plane path is taken only when every candidate it can yield — the
 * survivors, plus every entry above the watermark — fits in `maxResults`. That
 * is what keeps it exactly equivalent: with no truncation the two paths return
 * the same set, and the caller sorts by molecular weight before answering, so
 * the order is the same too. The plane index yields slot order, which is only
 * mostly mw order across several folds, and this is how that stops being
 * observable rather than something to apologise for.
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
  const { watermark } = readFoldState(db);
  if (watermark === null) {
    return { kind: 'column', reason: 'no fold has completed yet' };
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

  const unfolded = unfoldedBound(db, watermark, unfoldedLimit(slots));
  if (unfolded === Number.POSITIVE_INFINITY) {
    return {
      kind: 'column',
      reason: 'too many entries wait above the watermark',
    };
  }

  const survivors = planeSurvivorCount(db, bits);
  if (survivors + unfolded > maxResults) {
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

  return { kind: 'plane', bits, survivors, watermark };
}

/**
 * An upper bound on the entries above the watermark, or infinity when they are
 * more than the plane path accepts.
 *
 * Counted exactly while they are few, through the entry index. Past
 * {@link MAX_COUNTED} the count stops, and the span of ids above the watermark
 * bounds them instead: a database whose ids only grow has hardly any gaps, and
 * one whose watermark a write has dropped far down is declined without walking
 * millions of keys on every query.
 * @param db - The database to read.
 * @param watermark - The watermark.
 * @param limit - The most entries above it the plane path accepts.
 * @returns The bound, or `Number.POSITIVE_INFINITY`.
 */
function unfoldedBound(
  db: SQLiteDatabase,
  watermark: number,
  limit: number,
): number {
  const highest = highestEntryId(db);
  if (highest === null || highest <= watermark) return 0;
  const counted = Math.min(limit, MAX_COUNTED);
  const found = countAbove(db, watermark, counted + 1);
  if (found <= counted) return found;
  if (found > limit) return Number.POSITIVE_INFINITY;
  const span = highest - watermark;
  return span <= limit ? span : Number.POSITIVE_INFINITY;
}
