import { popcount32 } from '../../chemistry/bits.ts';
import { PLANES, SLOTS } from '../../chemistry/tile.ts';
import type { Layout } from '../layout.ts';

/**
 * How often each plane's bit is set, over an even sample of words (rows counted by their non-empty
 * slots): what orders a query's planes rarest first.
 * @param layout - The image.
 * @param samples - The rows to sample, about.
 * @returns One frequency per plane, in [0, 1].
 */
export function planeFrequencies(
  layout: Layout,
  samples: number,
): Float64Array {
  const starts: Array<{ b: number; at: number }> = [];
  let total = 0;
  for (let b = 0; b < layout.blocks.length; b++) {
    starts.push({ b, at: total });
    total += (layout.blocks[b] as { capacity: number }).capacity / SLOTS;
  }
  const want = Math.min(total, Math.ceil(samples / SLOTS));
  const counts = new Float64Array(PLANES);
  let rows = 0;
  let range = 0;
  for (let j = 0; j < want; j++) {
    const target = Math.floor((j * total) / want);
    while (
      range + 1 < starts.length &&
      (starts[range + 1] as { at: number }).at <= target
    ) {
      range++;
    }
    const { b, at } = starts[range] as { b: number; at: number };
    const w = target - at;
    const views = layout.views(b);
    for (let i = 0; i < SLOTS; i++) if (views.seq[w * SLOTS + i] !== 0) rows++;
    for (let p = 0; p < PLANES; p++) {
      counts[p] =
        (counts[p] as number) +
        popcount32(views.planes[p * views.W + w] as number);
    }
  }
  for (let p = 0; p < PLANES; p++) {
    counts[p] = rows === 0 ? 0 : (counts[p] as number) / rows;
  }
  return counts;
}
