import type { SQLiteDatabase, ScanPosition } from '../types.ts';

/**
 * The lowest and highest entry ids, each a seek on the entry index. Written as
 * two subqueries on purpose: SQLite answers a lone `MIN()` or `MAX()` from the
 * end of an index, but both in one SELECT by walking the whole of it.
 */
export const ENTRY_ID_BOUNDS_SQL = `SELECT
  (SELECT MIN(entry_id) FROM ocl_ss_index) AS low,
  (SELECT MAX(entry_id) FROM ocl_ss_index) AS high`;

/** Runs a sample is read in, spread over the scan. */
export const SAMPLE_RUNS = 32;

/**
 * Fewer runs than this in the scan's range, and it is read from its start; a
 * sample stopped by its budget before this many runs says nothing.
 */
export const MIN_RUNS = 8;

/** The part of the index a scan has still to read. */
export interface ScanRange {
  /** Resume after this position, exclusive. */
  after?: ScanPosition;
  /** The lightest weight read, inclusive. */
  lower?: number;
  /** The heaviest weight read, inclusive. */
  upper?: number;
}

/** How many rows of a sample each word let through. */
export type Passes = Map<number, number> & {
  /** The rows read. */
  rows: number;
  /** The runs read, of {@link SAMPLE_RUNS}. */
  runs: number;
};

/** A key of the clustered order, the first one a run of the sample reads. */
interface Key {
  mw: number;
  entryId: number;
}

/**
 * How many rows of a spread sample of the scan each word lets through.
 *
 * The runs are read in an order that keeps any prefix of them spread over the
 * index — first, middle, quarters, eighths — and none is started once
 * `budgetEnd` has passed. On a warm index the 32 runs take about a
 * millisecond; on a cold one each is a few random reads, and the budget stops
 * the sample rather than let it cost more than the scan it is meant to speed
 * up.
 * @param db - The database to read.
 * @param packed - The query's eight 64-bit words.
 * @param words - The words to count.
 * @param range - The part of the index the scan has still to read.
 * @param runLength - Rows read in each run.
 * @param budgetEnd - When to stop starting runs, in ms since the epoch.
 * @returns The passes by word, with how many rows and runs were read.
 */
export function countPasses(
  db: SQLiteDatabase,
  packed: bigint[],
  words: readonly number[],
  range: ScanRange,
  runLength: number,
  budgetEnd: number,
): Passes {
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
  const passes = new Map<number, number>() as Passes;
  passes.rows = 0;
  passes.runs = 0;
  for (const start of runStarts(db, range, budgetEnd)) {
    if (Date.now() > budgetEnd) break;
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
    passes.runs += start.runs;
  }
  return passes;
}

/**
 * Where the runs of a sample start: at entries spread by id over the index,
 * kept when they lie in what the scan has still to read, in spread order.
 * When too few do — a narrow range — the missing runs are read in one from
 * where the scan stands. Nothing is returned once the budget has passed.
 * @param db - The database to read.
 * @param range - The part of the index the scan has still to read.
 * @param budgetEnd - When to stop seeking, in ms since the epoch.
 * @returns The start keys, each with how many runs it stands for.
 */
function runStarts(
  db: SQLiteDatabase,
  range: ScanRange,
  budgetEnd: number,
): Array<Key & { runs: number }> {
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
  if (high < low) return [{ ...first, runs: SAMPLE_RUNS }];
  for (const run of spreadOrder(SAMPLE_RUNS)) {
    if (Date.now() > budgetEnd) return [];
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
  return keys;
}

/**
 * The numbers 0 to `count` − 1, a power of two, in bit-reversed order: every
 * prefix of it is spread evenly over the whole range.
 * @param count - How many.
 * @returns The order.
 */
function spreadOrder(count: number): number[] {
  const bits = Math.log2(count);
  const order: number[] = [];
  for (let index = 0; index < count; index++) {
    let reversed = 0;
    for (let bit = 0; bit < bits; bit++) {
      reversed |= ((index >> bit) & 1) << (bits - 1 - bit);
    }
    order.push(reversed);
  }
  return order;
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
