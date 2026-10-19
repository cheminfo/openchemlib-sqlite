import { XSadd } from 'ml-xsadd';

import type { SearchOptions } from '../search/pages.ts';

import type { TruthRow } from './truth.ts';
import { holdsKey } from './truth.ts';

/** The sets of the test specification. */
export const TEST_SETS = ['listed', 'source:1', 'source:2', 'source:3'];

/** The key bits of each fingerprint: FragFp, the screen, the function keys. */
const RANGES: ReadonlyArray<[number, number]> = [
  [0, 512],
  [512, 1024],
  [1024, 1536],
];

/**
 * How many rows hold each key bit.
 * @param rows - The truth, read with its keys.
 * @returns 1,536 counts.
 */
export function keyPopulations(rows: readonly TruthRow[]): Float64Array {
  const counts = new Float64Array(1536);
  for (const row of rows) {
    for (let bit = 0; bit < 1536; bit++) {
      if (holdsKey(row, bit)) counts[bit] = (counts[bit] as number) + 1;
    }
  }
  return counts;
}

/**
 * Seeded searches with key bits and set expressions: from each fingerprint 1 to 3 keys, half of
 * them held by 1 % to 50 % of the rows (a key a row must hold, one of the OR group, or a key to
 * lack), the others drawn from every key of the fingerprint (one of the OR group, or a key to
 * lack); and sets over `listed` and the test sources, some held by every answer, some by none.
 * @param rows - The truth, read with its keys.
 * @param seed - The seed.
 * @param count - How many searches.
 * @returns The searches' options.
 */
export function drawSearches(
  rows: readonly TruthRow[],
  seed: number,
  count: number,
): SearchOptions[] {
  const random = new XSadd(seed);
  const populations = keyPopulations(rows);
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(random.getFloat() * list.length)] as T;
  const draws: SearchOptions[] = [];
  for (let d = 0; d < count; d++) {
    const all: number[] = [];
    const any: number[] = [];
    const none: number[] = [];
    for (const [from, to] of RANGES) {
      const common: number[] = [];
      for (let bit = from; bit < to; bit++) {
        const share = (populations[bit] as number) / rows.length;
        if (share >= 0.01 && share <= 0.5) common.push(bit);
      }
      const keys = 1 + Math.floor(random.getFloat() * 3);
      for (let k = 0; k < keys; k++) {
        const draw = random.getFloat();
        if (k % 2 === 0 && common.length > 0) {
          (draw < 0.35 ? all : draw < 0.75 ? any : none).push(pick(common));
        } else {
          const bit = from + Math.floor(random.getFloat() * (to - from));
          (draw < 0.3 ? any : none).push(bit);
        }
      }
    }
    const options: SearchOptions = { bits: { all, any, none } };
    const shape = random.getFloat();
    if (shape < 0.25) options.sets = [pick(TEST_SETS), pick(TEST_SETS)];
    else if (shape < 0.5) options.sets = ['source:1', 'source:2', 'source:3'];
    if (random.getFloat() < 0.3) options.allSets = [pick(TEST_SETS)];
    if (random.getFloat() < 0.3) options.noneSets = [pick(TEST_SETS)];
    draws.push(options);
  }
  return draws;
}
