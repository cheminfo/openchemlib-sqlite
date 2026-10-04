import type { SQLiteDatabase, ScanPosition } from '../types.ts';

import { defaultOrder } from './buildSSPrefilter.ts';
import { packSSIndex } from './packSSIndex.ts';

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

/**
 * The lowest and highest entry ids, each a seek on the entry index. Written as
 * two subqueries on purpose: SQLite answers a lone `MIN()` or `MAX()` from the
 * end of an index, but both in one SELECT by walking the whole of it.
 */
export const ENTRY_ID_BOUNDS_SQL = `SELECT
  (SELECT MIN(entry_id) FROM ocl_ss_index) AS low,
  (SELECT MAX(entry_id) FROM ocl_ss_index) AS high`;

/** Runs a sample is read in, spread over the scan. */
const SAMPLE_RUNS = 32;

/** Fewer runs than this in the scan's range, and it is read from its start. */
const MIN_RUNS = 8;

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

/** The part of the index a scan has still to read. */
export interface ScanRange {
  /** Resume after this position, exclusive. */
  after?: ScanPosition;
  /** The lightest weight read, inclusive. */
  lower?: number;
  /** The heaviest weight read, inclusive. */
  upper?: number;
}

/** A key of the clustered order, the first one a run of the sample reads. */
interface Key {
  mw: number;
  entryId: number;
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
 * @param db - The database to read.
 * @param queryIndex - The fragment's fingerprint.
 * @param range - The part of the index the scan has still to read.
 * @returns The plan.
 */
export function measurePrefilterPlan(
  db: SQLiteDatabase,
  queryIndex: ArrayLike<number>,
  range: ScanRange,
): PrefilterPlan {
  const packed = packSSIndex(Array.from(queryIndex));
  const { words } = guessedPrefilterPlan(queryIndex);
  if (words.length === 0) return guessedPrefilterPlan(queryIndex);
  const passes = samplePasses(db, queryIndex, range);
  const order = words.toSorted(
    (a, b) => (passes.get(a) ?? 0) - (passes.get(b) ?? 0),
  );
  const best = order[0] as number;
  let rate = (passes.get(best) ?? 0) / Math.max(1, passes.rows);
  if ((passes.get(best) ?? 0) < MIN_PASSES) {
    const rare = countPasses(db, packed, [best], range, RARE_SAMPLE_RUN);
    if ((rare.get(best) ?? 0) < MIN_PASSES) {
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
 * @returns The passes by word, and how many rows were read.
 */
export function samplePasses(
  db: SQLiteDatabase,
  queryIndex: ArrayLike<number>,
  range: ScanRange,
): Map<number, number> & { rows: number } {
  const packed = packSSIndex(Array.from(queryIndex));
  const { words } = guessedPrefilterPlan(queryIndex);
  return countPasses(db, packed, words, range, SAMPLE_RUN);
}

/**
 * How many rows of a spread sample of the scan each word lets through.
 * @param db - The database to read.
 * @param packed - The query's eight 64-bit words.
 * @param words - The words to count.
 * @param range - The part of the index the scan has still to read.
 * @param runLength - Rows read in each run.
 * @returns The passes by word, and how many rows were read.
 */
function countPasses(
  db: SQLiteDatabase,
  packed: bigint[],
  words: readonly number[],
  range: ScanRange,
  runLength: number,
): Map<number, number> & { rows: number } {
  const sums = words.map(
    (word) => `sum((s.ss_index${word} & ?) = ?) AS w${word}`,
  );
  const upper = range.upper === undefined ? '' : ' AND s.mw <= ?';
  const run = db.prepare(
    `SELECT count(*) AS n, ${sums.join(', ')}
       FROM (SELECT ${words.map((word) => `s.ss_index${word}`).join(', ')}
               FROM ocl_ss_index s
              WHERE (s.mw, s.entry_id) >= (?, ?)${upper}
              ORDER BY s.mw, s.entry_id LIMIT ?) s`,
  );
  const sumParams = words.flatMap((word) => [packed[word], packed[word]]);
  const passes = new Map<number, number>() as Map<number, number> & {
    rows: number;
  };
  passes.rows = 0;
  const starts = runStarts(db, range);
  for (const start of starts.keys) {
    const row = run.get(
      ...sumParams,
      start.mw,
      start.entryId,
      ...(range.upper === undefined ? [] : [range.upper]),
      runLength * start.runs,
    ) as Record<string, unknown>;
    for (const word of words) {
      passes.set(word, (passes.get(word) ?? 0) + Number(row[`w${word}`] ?? 0));
    }
    passes.rows += Number(row.n ?? 0);
  }
  return passes;
}

/**
 * Where the runs of a sample start: at entries spread by id over the index,
 * kept when they lie in what the scan has still to read. When too few do — a
 * narrow range — the missing runs are read in one from where the scan stands.
 * @param db - The database to read.
 * @param range - The part of the index the scan has still to read.
 * @returns The start keys, each with how many runs it stands for.
 */
function runStarts(
  db: SQLiteDatabase,
  range: ScanRange,
): { keys: Array<Key & { runs: number }> } {
  const first = firstKey(range);
  const ids = db.prepare(ENTRY_ID_BOUNDS_SQL).get() as
    { low: number | null; high: number | null } | undefined;
  const keyOf = db.prepare(
    `SELECT mw, entry_id FROM ocl_ss_index INDEXED BY idx_ocl_ss_entry
      WHERE entry_id >= ? ORDER BY entry_id LIMIT 1`,
  );
  const keys: Array<Key & { runs: number }> = [];
  const low = ids?.low ?? 0;
  const high = ids?.high ?? -1;
  const runs = high >= low ? SAMPLE_RUNS : 0;
  for (let run = 0; run < runs; run++) {
    const id = low + Math.floor(((run + 0.5) * (high - low + 1)) / SAMPLE_RUNS);
    const row = keyOf.get(id) as Record<string, unknown> | undefined;
    if (row === undefined) continue;
    const key = { mw: Number(row.mw), entryId: Number(row.entry_id) };
    if (compareKeys(key, first) < 0) continue;
    if (range.upper !== undefined && key.mw > range.upper) continue;
    keys.push({ ...key, runs: 1 });
  }
  if (keys.length < MIN_RUNS) {
    keys.push({ ...first, runs: SAMPLE_RUNS - keys.length });
  }
  return { keys };
}

/**
 * The first key a scan reads: past its position, and not lighter than its
 * lower bound.
 * @param range - The part of the index the scan has still to read.
 * @returns The key, inclusive.
 */
function firstKey(range: ScanRange): Key {
  const lower: Key = {
    mw: range.lower ?? -Number.MAX_VALUE,
    entryId: Number.MIN_SAFE_INTEGER,
  };
  if (range.after === undefined) return lower;
  // Ids are integers: the first key after a position is the next id.
  const next = { mw: range.after.mw, entryId: range.after.entryId + 1 };
  return compareKeys(next, lower) > 0 ? next : lower;
}

/**
 * Order keys as the clustered index does.
 * @param a - One key.
 * @param b - The other.
 * @returns Negative when `a` comes first.
 */
function compareKeys(a: Key, b: Key): number {
  return a.mw - b.mw || a.entryId - b.entryId;
}
