import { popcount32 } from '../chemistry/bits.ts';
import type { CountOptions, Counts } from '../search/countPage.ts';

import type { TruthRow } from './truth.ts';
import { holdsKey, inSet, passes } from './truth.ts';

/**
 * What `count()` must answer, from SQL and the wasm records alone.
 * @param rows - The truth, read with its keys when the count names any.
 * @param options - The count's options.
 * @returns The counts, complete.
 */
export function countTruth(rows: TruthRow[], options: CountOptions): Counts {
  const answered = rows.filter((row) => passes(row, options));
  const bySets = options.bySets ?? [];
  const byKeys = options.byKeys ?? [];
  const members = options.membershipOf ?? [];
  const n = members.length;
  const combinations =
    n === 0 || n > 16 ? [] : new Array<number>(2 ** n).fill(0);
  const membership = n === 0 ? [] : new Array<number>(n + 1).fill(0);
  const bySet = new Array<number>(bySets.length).fill(0);
  const byKey = new Array<number>(byKeys.length).fill(0);
  const { histogram: wanted } = options;
  const histogram =
    wanted === undefined ? [] : new Array<number>(wanted.bins + 3).fill(0);
  for (const row of answered) {
    for (const [s, name] of bySets.entries()) {
      if (inSet(row, name)) bySet[s] = (bySet[s] as number) + 1;
    }
    for (const [k, bit] of byKeys.entries()) {
      if (holdsKey(row, bit)) byKey[k] = (byKey[k] as number) + 1;
    }
    if (n > 0) {
      let mask = 0;
      for (const [s, name] of members.entries()) {
        if (inSet(row, name)) mask |= 1 << s;
      }
      const k = popcount32(mask);
      membership[k] = (membership[k] as number) + 1;
      if (n <= 16) combinations[mask] = (combinations[mask] as number) + 1;
    }
    if (wanted !== undefined) {
      const value =
        wanted.of === 'key'
          ? row.key
          : row[wanted.of as 'logP' | 'hba' | 'charge'];
      let slot = wanted.bins + 2;
      if (value !== null) {
        const bin = Math.floor((value - wanted.min) / wanted.width);
        slot = bin < 0 ? 0 : bin >= wanted.bins ? wanted.bins + 1 : bin + 1;
      }
      histogram[slot] = (histogram[slot] as number) + 1;
    }
  }
  return {
    total: answered.length,
    bySet,
    byKey,
    membership,
    combinations,
    histogram,
    complete: true,
  };
}
