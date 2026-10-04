import type { SQLiteDatabase } from '../types.ts';

import { defaultOrder } from './buildSSPrefilter.ts';
import { packSSIndex } from './packSSIndex.ts';
import type { Passes, ScanRange } from './prefilterSample.ts';
import { MIN_RUNS, countPasses } from './prefilterSample.ts';

export type { ScanRange } from './prefilterSample.ts';
export { ENTRY_ID_BOUNDS_SQL } from './prefilterSample.ts';

/**
 * How the fingerprint prefilter of a column scan is written: which words it
 * tests in which order, and where the deadline guard sits among them.
 */
export interface PrefilterPlan {
  /** The query's non-zero fingerprint words, as columns 0–7, in test order. */
  words: number[];
  /** How many of {@link PrefilterPlan.words} are tested before the guard. */
  guardAfter: number;
  /**
   * The guard reads the clock for one row in `guardMask + 1` of those that
   * reach it, chosen by entry id: 1023 for one in 1024.
   */
  guardMask: number;
  /** Whether the order was measured on rows of the scan, or only guessed. */
  measured: boolean;
}

/** Rows per run when measuring which word is most selective: 2048 in all. */
const SAMPLE_RUN = 64;

/** Rows per run when the best word is too rare to judge on those: 65 536. */
const RARE_SAMPLE_RUN = 2048;

/**
 * Rows of a sample the best word must let through for the guard to sit after
 * it: enough that its share of the rows is known to within a factor of two.
 */
const MIN_PASSES = 4;

/** The clock is read about once per this many rows read, guard first or not. */
const ROWS_PER_CLOCK = 1024;

/**
 * The plan a scan starts with, before anything is known about its rows: the
 * words the query sets, those setting most bits first — the likeliest to be
 * selective — and the guard ahead of them all.
 *
 * Words the query leaves at zero are never tested: `(word & 0) = 0` holds for
 * every row and only costs a column read each.
 * @param queryIndex - The fragment's fingerprint, as `Molecule.getIndex()` returns it.
 * @returns The plan.
 */
export function guessedPrefilterPlan(
  queryIndex: ArrayLike<number>,
): PrefilterPlan {
  return {
    words: defaultOrder(packSSIndex(Array.from(queryIndex))),
    guardAfter: 0,
    guardMask: 1023,
    measured: false,
  };
}

/**
 * Plan the prefilter on the rows a scan has still to read.
 *
 * A sample of them says how many rows each word lets through, and the words
 * are tested rarest first: a row is rejected after one column read instead of
 * after several. The sample is 32 short runs spread over what is left of the
 * scan — each starting at an entry chosen by id, which says nothing of its
 * weight — because consecutive rows of a weight-ordered index are isomers of a
 * few formulas, alike in exactly the bits that decide this.
 *
 * Testing the most selective word first also decides where the guard goes.
 * Every condition costs a column read per row it sees (~20 ns), so the guard
 * sits right after that word, where it sees only what the word lets through,
 * and reads the clock on a correspondingly larger share of those rows: about
 * once per 1024 rows read, as before. When too few rows of the sample pass the
 * word to judge its rate, a larger one is read for that word alone; when even
 * that is too few, the guard stays first, where its timing does not depend on
 * the rows at all.
 *
 * The sample has a time budget. On a warm index it costs about a millisecond;
 * on a cold one every run is a few random reads, and a sample that cannot be
 * read within the budget is given up: the scan keeps the order it has, which
 * is never wrong, only slower per row.
 * @param db - The database to read.
 * @param queryIndex - The fragment's fingerprint.
 * @param range - The part of the index the scan has still to read.
 * @param budgetEnd - When to give the sample up, in ms since the epoch.
 * @returns The plan, or null when the budget ran out before the sample said
 *   anything.
 */
export function measurePrefilterPlan(
  db: SQLiteDatabase,
  queryIndex: ArrayLike<number>,
  range: ScanRange,
  budgetEnd = Number.POSITIVE_INFINITY,
): PrefilterPlan | null {
  const packed = packSSIndex(Array.from(queryIndex));
  const { words } = guessedPrefilterPlan(queryIndex);
  if (words.length === 0) return guessedPrefilterPlan(queryIndex);
  const passes = samplePasses(db, queryIndex, range, budgetEnd);
  if (passes.runs < MIN_RUNS) return null;
  const order = words.toSorted(
    (a, b) => (passes.get(a) ?? 0) - (passes.get(b) ?? 0),
  );
  const best = order[0] as number;
  let rate = (passes.get(best) ?? 0) / Math.max(1, passes.rows);
  if ((passes.get(best) ?? 0) < MIN_PASSES) {
    const rare = countPasses(
      db,
      packed,
      [best],
      range,
      RARE_SAMPLE_RUN,
      budgetEnd,
    );
    if (rare.runs < MIN_RUNS || (rare.get(best) ?? 0) < MIN_PASSES) {
      return { words: order, guardAfter: 0, guardMask: 1023, measured: true };
    }
    rate = (rare.get(best) ?? 0) / rare.rows;
  }
  let reaching = 1;
  while (reaching * 2 <= ROWS_PER_CLOCK * rate) reaching *= 2;
  return {
    words: order,
    guardAfter: 1,
    guardMask: reaching - 1,
    measured: true,
  };
}

/**
 * How many rows of the sample a plan is measured on each non-zero word of a
 * query lets through.
 * @param db - The database to read.
 * @param queryIndex - The fragment's fingerprint.
 * @param range - The part of the index the scan has still to read.
 * @param budgetEnd - When to stop starting runs, in ms since the epoch.
 * @returns The passes by word, with how many rows and runs were read.
 */
export function samplePasses(
  db: SQLiteDatabase,
  queryIndex: ArrayLike<number>,
  range: ScanRange,
  budgetEnd = Number.POSITIVE_INFINITY,
): Passes {
  const packed = packSSIndex(Array.from(queryIndex));
  const { words } = guessedPrefilterPlan(queryIndex);
  return countPasses(db, packed, words, range, SAMPLE_RUN, budgetEnd);
}
