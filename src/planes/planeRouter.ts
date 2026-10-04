import type * as OpenChemLib from 'openchemlib';

import type { SQLiteDatabase } from '../types.ts';

import { countAbove, highestEntryId, readFoldState } from './foldState.ts';
import { planeChunks, planeCoverage, planeQueryBits } from './planeCoverage.ts';
import { collectSurvivors } from './planeSurvivors.ts';

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
 * plane path stops being worth taking, and a fold is advised.
 *
 * Those entries are screened one seek on the entry index at a time, ~2.1 µs
 * each against ~0.15 µs a row for the clustered scan. Measured on 10 M
 * entries, full counts of flavone, quercetin and dibenzoselenophene: the
 * prescreen took 1.0–1.7 s on the column path, 0.1–0.3 s on the planes with
 * nothing waiting, 0.3–0.5 s with 1% waiting, and 1.1–1.3 s with 5% — no gain
 * left at all.
 */
export const PLANE_MAX_UNFOLDED_RATIO = 0.01;

/**
 * The most index keys the router walks to count the entries above the
 * watermark: about 3 ms, so a query never pays more than that to be routed.
 */
const MAX_COUNTED = 65_536;

/**
 * How many entries above the watermark the plane path accepts whatever the
 * size of the index: a thousand seeks cost about a millisecond.
 */
const MIN_UNFOLDED_LIMIT = 1024;

/**
 * What resolving one surviving slot costs, in ms: a seek on the slots, one on
 * the entry index and one on the clustered index, then the exact 512-bit test.
 * The router weighs a switch to the planes with it.
 */
export const RESOLVE_MS = 0.005;

/** What screening one entry above the watermark costs, in ms. */
export const UNFOLDED_MS = 0.002;

/**
 * What reading one chunk of one plane costs, in ms: a 128 KB overflow chain.
 * Measured at 0.15–0.3 ms on a 10 M-entry index.
 */
const PLANE_READ_MS = 0.25;

/**
 * How many planes of a chunk an intersection usually reads before it stops
 * paying, to estimate what intersecting costs before doing it.
 */
const PLANES_READ_PER_CHUNK = 8;

/**
 * The least a bounded scan runs on the column path before the planes are
 * considered: most first pages are answered well within it, and they never
 * pay anything for the plane index existing.
 */
const MIN_CHECKPOINT_MS = 100;

/** Which prescreen a query should run on, and why. */
export type PrescreenPlan =
  | { kind: 'column'; reason: string }
  | {
      /** The planes answer outright, in slot order. */
      kind: 'plane';
      bits: number[];
      /** The surviving slots, ascending. */
      slots: Uint32Array;
      survivors: number;
      watermark: number;
    }
  | {
      /**
       * A bounded scan: it starts on the column path, and at the checkpoint
       * may finish from the planes, in the same order.
       */
      kind: 'switch';
      bits: number[];
      watermark: number;
      /** Entries above the watermark, which the plane side screens one by one. */
      unfolded: number;
      /** The most survivors the plane side accepts. */
      limit: number;
      /** How long the column path runs before the planes are considered, in ms. */
      checkpointMs: number;
      /** What intersecting the planes is estimated to cost, in ms. */
      intersectMs: number;
    };

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
 * An **unbounded** scan reads every candidate on either path, so the router
 * intersects the planes and takes them when few slots survive. Intersecting is
 * the plane path's first step, so a query it takes is never intersected twice,
 * and the count stops as soon as it passes the limit: a query it declines pays
 * for part of an intersection only.
 *
 * A **bounded** scan — a first page — usually stops after a few hundred rows of
 * the column scan, which no intersection beats; but when matches are rare it
 * reads far into the index. So it starts on the column path and is reconsidered
 * at a checkpoint: a page answered by then pays nothing for the planes, and one
 * still running can finish from them. They are read in the same `(mw,
 * entry_id)` order from where the column scan stopped, so the answer is the
 * same either way. A bounded scan that cannot be truncated — its `maxResults`
 * holds every candidate the planes may let through — is unbounded in effect.
 *
 * A scan bounded by weight or resuming after a position is never answered in
 * slot order, since on the column path each is a seek; it may still switch.
 * @param db - The database to read.
 * @param mol - The query fragment; its fragment flag must already be set.
 * @param maxResults - The most results the caller will keep.
 * @param maxCandidateRatio - The share of the index above which the column path
 *   wins; defaults to {@link PLANE_MAX_CANDIDATE_RATIO}.
 * @param inSlotOrder - Whether the planes may answer outright, in slot order.
 * @param queryIndex - The fragment's fingerprint, when already built.
 * @returns Which prescreen to run.
 */
export function choosePrescreenPath(
  db: SQLiteDatabase,
  mol: OCLMolecule,
  maxResults: number,
  maxCandidateRatio: number = PLANE_MAX_CANDIDATE_RATIO,
  inSlotOrder = true,
  queryIndex: number[] = mol.getIndex(),
): PrescreenPlan {
  const { slots } = planeCoverage(db);
  if (slots === 0) {
    return { kind: 'column', reason: 'the plane index is empty' };
  }
  const { watermark } = readFoldState(db);
  if (watermark === null) {
    return { kind: 'column', reason: 'no fold has completed yet' };
  }

  const bits = planeQueryBits(db, queryIndex);
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

  const limit = Math.floor(slots * maxCandidateRatio);
  if (!inSlotOrder || maxResults - unfolded < limit) {
    const intersectMs =
      planeChunks(db).length *
      Math.min(bits.length, PLANES_READ_PER_CHUNK) *
      PLANE_READ_MS;
    return {
      kind: 'switch',
      bits,
      watermark,
      unfolded,
      limit,
      checkpointMs: Math.max(MIN_CHECKPOINT_MS, 2 * intersectMs),
      intersectMs,
    };
  }

  const survivors = collectSurvivors(db, bits, planeChunks(db), limit);
  if (survivors.exceeded) {
    return {
      kind: 'column',
      reason: 'too many candidates for the screen to pay for itself',
    };
  }
  return {
    kind: 'plane',
    bits,
    slots: survivors.slots,
    survivors: survivors.count,
    watermark,
  };
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
