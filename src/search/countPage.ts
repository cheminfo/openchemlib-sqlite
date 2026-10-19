import type { CountChunk, CountContext } from './countChunk.ts';
import { countChunk } from './countChunk.ts';
import { countsOf, readCountOptions } from './countOptions.ts';
import type { SearchLane, SearchOptions } from './pages.ts';
import { readFilters } from './query.ts';
import { setExpression } from './setExpression.ts';

/** The longest budget a timer holds: 2^31 - 1 ms, about 24.8 days. */
const LONGEST_BUDGET_MS = 2 ** 31 - 1;

/** A histogram of one column over the rows a count answers. */
export interface CountHistogram {
  /** A filter column of the spec, by name, or 'key' for the order key. */
  of: string;
  /** Where the first bin starts. */
  min: number;
  /** The width of every bin, above 0. */
  width: number;
  /** How many bins, from 1 to 100. */
  bins: number;
}

/** What `count()` takes: a browse's restriction, and the tallies wanted beside the total. */
export interface CountOptions extends Omit<
  SearchOptions,
  'limit' | 'lane' | 'budgetMs'
> {
  /**
   * The queue each chunk of the count waits in.
   * @default 'bulk'
   */
  lane?: SearchLane;
  /**
   * The count stops after this many milliseconds from its first chunk's start, `complete` false.
   * @default the index's `budgetMs`
   */
  budgetMs?: number;
  /**
   * Sets whose rows among those answering are counted, each on its own. An unknown name counts 0.
   * @default []
   */
  bySets?: readonly string[];
  /**
   * Keys, as record bits, whose rows among those answering are counted, each on its own.
   * @default []
   */
  byKeys?: readonly number[];
  /**
   * Up to 32 sets: the rows answering are counted by how many of them each belongs to and, for 16
   * sets or fewer, by exactly which of them. An unknown name holds nothing.
   * @default []
   */
  membershipOf?: readonly string[];
  /**
   * A histogram of one column over the rows answering.
   * @default undefined — no histogram
   */
  histogram?: CountHistogram;
}

/** What `count()` answers. */
export interface Counts {
  /** The rows answering: exactly what a browse with the same options pages through. */
  total: number;
  /** For each set of `bySets`, in its order: the rows answering that belong to it. */
  bySet: number[];
  /** For each key of `byKeys`, in its order: the rows answering that hold it. */
  byKey: number[];
  /** Index k: the rows answering that belong to exactly k sets of `membershipOf`; empty without it. */
  membership: number[];
  /**
   * Index m: the rows answering that belong to exactly the sets of `membershipOf` whose bits m sets
   * (bit i for set i); empty without `membershipOf` or with more than 16 sets.
   */
  combinations: number[];
  /**
   * The histogram: index 0 counts the rows below `min`, then one entry per bin, then the rows at
   * or above the last bin's end, then the rows without a value; empty without `histogram`.
   */
  histogram: number[];
  /** Whether every row was read. False when the budget or the signal stopped the count. */
  complete: boolean;
}

/**
 * Counts the molecules a browse with these options answers, in the search workers, without
 * reading a row from SQL but the rare tied value of a filter. The key axis is cut into ranges of
 * about `chunkRows` rows from the histogram, half-open but the last; each range is one phase, a
 * turn of the lane of its own, counting the rows of the version current when it starts: a row
 * present for the whole count is counted exactly once. The budget counts from the first range's
 * start.
 * @param context - The index's state.
 * @param options - The restriction and the tallies; `lane` defaults to 'bulk'.
 * @returns The counts; `complete` is false when the budget or the signal stopped it.
 */
export async function countPage(
  context: CountContext,
  options: CountOptions,
): Promise<Counts> {
  const first = context.current();
  const request = readCountOptions(options, first.layout);
  const bounds = readFilters(first.layout, options.filters);
  const tallies = new Float64Array(request.tallies);
  const lane = options.lane ?? 'bulk';
  const budget = Math.min(
    LONGEST_BUDGET_MS,
    options.budgetMs ?? context.budgetMs,
  );
  const end = options.keyMax ?? Infinity;
  if (setExpression(first, options, context.defaultSets) === null) {
    return countsOf(request, tallies, true);
  }
  const chunk: CountChunk = {
    request,
    options,
    bounds,
    lo: options.keyMin ?? -Infinity,
    end,
    deadline: Infinity,
    tallies,
  };
  // One turn of the lane: the budget counts from the first one's start.
  const turn = async () => {
    if (chunk.deadline === Infinity) {
      chunk.deadline = performance.now() + budget;
    }
    if (options.signal?.aborted || performance.now() >= chunk.deadline) {
      return undefined;
    }
    return countChunk(context, chunk);
  };
  let complete = true;
  while (chunk.lo <= end) {
    // eslint-disable-next-line no-await-in-loop -- each range is a turn of the lane, in order
    const next = await context.pool.search(turn, lane, {
      signal: options.signal,
      settle: () => undefined,
    });
    if (next === undefined) {
      complete = false;
      break;
    }
    if (next === null) break;
    chunk.lo = next;
  }
  return countsOf(request, tallies, complete);
}
