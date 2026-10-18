import { popcount32 } from '../chemistry/bits.ts';

import type { Layout } from './layout.ts';

/**
 * How many alive rows the union of some sets holds: each word of their bitmaps OR-ed, AND-ed with
 * the alive rows and counted, without building the union or reading a row.
 * @param layout - The version counted.
 * @param sets - The set names, null for every alive row; an unknown name adds nothing.
 * @returns The count.
 */
export function countRows(
  layout: Layout,
  sets: readonly string[] | null,
): number {
  const words = Math.ceil(layout.rowSpace / 32);
  const alive = new Int32Array(layout.alive, 0, words);
  const maps: Int32Array[] = [];
  if (sets !== null) {
    for (const name of sets) {
      const map = layout.sets.get(name);
      if (map !== undefined) maps.push(new Int32Array(map, 0, words));
    }
  }
  let count = 0;
  for (let w = 0; w < words; w++) {
    let union = sets === null ? -1 : 0;
    for (const map of maps) union |= map[w] as number;
    count += popcount32(union & (alive[w] as number));
  }
  return count;
}
