import { popcount32 } from '../chemistry/bits.ts';
import { PLANES } from '../chemistry/tile.ts';

import type { ColumnLayout } from './blocks.ts';
import type { CountOptions, Counts } from './countPage.ts';
import type { KeyPlanes } from './keyBits.ts';
import { keyPlane, readKeyBits } from './keyBits.ts';
import type { HistogramTask } from './pool/messages.ts';

/** Sets `membershipOf` holds at most, and those it counts by combination at most. */
export const MAX_MEMBERSHIP = 32;
export const MAX_COMBINATIONS = 16;

/** Bins of a histogram at most. */
export const MAX_BINS = 100;

/** A count's options, checked: what the workers tally, and where each tally sits. */
export interface CountRequest {
  keys: KeyPlanes;
  bySets: readonly string[];
  /** The planes of `byKeys`, in its order. */
  byKeys: Int32Array;
  membershipOf: readonly string[];
  histogram: HistogramTask | null;
  /** The length of the tallies: total, bySets, byKeys, membership, histogram. */
  tallies: number;
}

/**
 * Checks a count's options and lays out its tallies.
 * @param options - The count's options.
 * @param layout - The index's column layout.
 * @returns What the workers tally.
 * @throws {RangeError} When a key bit, a list's length or the histogram is not valid.
 */
export function readCountOptions(
  options: CountOptions,
  layout: ColumnLayout,
): CountRequest {
  const keys = readKeyBits(options.bits);
  const bySets = options.bySets ?? [];
  const keyBits = options.byKeys ?? [];
  if (keyBits.length > PLANES) {
    throw new RangeError(`byKeys holds at most ${PLANES} key bits`);
  }
  const byKeys = new Int32Array(keyBits.length);
  for (let k = 0; k < keyBits.length; k++) byKeys[k] = keyPlane(keyBits[k]);
  const membershipOf = options.membershipOf ?? [];
  if (membershipOf.length > MAX_MEMBERSHIP) {
    throw new RangeError(`membershipOf holds at most ${MAX_MEMBERSHIP} sets`);
  }
  const histogram =
    options.histogram === undefined
      ? null
      : readHistogram(options.histogram, layout);
  return {
    keys,
    bySets,
    byKeys,
    membershipOf,
    histogram,
    tallies:
      1 +
      bySets.length +
      byKeys.length +
      membershipSize(membershipOf.length) +
      (histogram === null ? 0 : histogram.bins + 3),
  };
}

/**
 * The counts, from the tallies summed over the workers.
 * @param request - What was tallied.
 * @param tallies - The tallies.
 * @param complete - Whether every row was read.
 * @returns The counts.
 */
export function countsOf(
  request: CountRequest,
  tallies: Float64Array,
  complete: boolean,
): Counts {
  const nSets = request.bySets.length;
  const nKeys = request.byKeys.length;
  const n = request.membershipOf.length;
  const memberAt = 1 + nSets + nKeys;
  const memberEnd = memberAt + membershipSize(n);
  const part = (from: number, to: number) =>
    Array.from(tallies.subarray(from, to));
  let membership: number[] = [];
  let combinations: number[] = [];
  if (n > MAX_COMBINATIONS) {
    membership = part(memberAt, memberEnd);
  } else if (n > 0) {
    combinations = part(memberAt, memberEnd);
    membership = new Array<number>(n + 1).fill(0);
    for (let mask = 0; mask < combinations.length; mask++) {
      const k = popcount32(mask);
      membership[k] =
        (membership[k] as number) + (combinations[mask] as number);
    }
  }
  return {
    total: tallies[0] as number,
    bySet: part(1, 1 + nSets),
    byKey: part(1 + nSets, memberAt),
    membership,
    combinations,
    histogram:
      request.histogram === null ? [] : part(memberEnd, tallies.length),
    complete,
  };
}

function membershipSize(n: number): number {
  if (n === 0) return 0;
  return n > MAX_COMBINATIONS ? n + 1 : 2 ** n;
}

function readHistogram(
  histogram: NonNullable<CountOptions['histogram']>,
  layout: ColumnLayout,
): HistogramTask {
  const { of, min, width, bins } = histogram;
  const column = layout.filters.findIndex((filter) => filter.name === of);
  if (of !== 'key' && column === -1) {
    const names = layout.filters.map((filter) => filter.name);
    throw new RangeError(
      `histogram.of is 'key' or a filter column (${names.join(', ')}), not ${JSON.stringify(of)}`,
    );
  }
  if (!Number.isFinite(min)) {
    throw new RangeError(
      `histogram.min is a finite number, not ${String(min)}`,
    );
  }
  if (!(Number.isFinite(width) && width > 0)) {
    throw new RangeError(
      `histogram.width is a finite number above 0, not ${String(width)}`,
    );
  }
  if (!Number.isInteger(bins) || bins < 1 || bins > MAX_BINS) {
    throw new RangeError(
      `histogram.bins is a whole number from 1 to ${MAX_BINS}, not ${String(bins)}`,
    );
  }
  return { column: of === 'key' ? -1 : column, min, width, bins };
}
