import { popcount32 } from './bits.ts';
import type { TileViews } from './tile.ts';
import { MOLECULE_WORDS, PLANES, SLOTS } from './tile.ts';

/**
 * The words of every slot of a tile, read back from its planes in one pass.
 * @param tile - The tile.
 * @returns 32 words per slot, slot after slot: FragFp then the screen.
 */
export function tileWords(tile: TileViews): Int32Array {
  const words = new Int32Array(SLOTS * MOLECULE_WORDS);
  const { planes } = tile;
  for (let plane = 0; plane < PLANES; plane++) {
    let slots = planes[plane] as number;
    const word = plane >>> 5;
    const bit = 1 << (plane & 31);
    while (slots !== 0) {
      const lowest = slots & -slots;
      const at = (31 - Math.clz32(lowest)) * MOLECULE_WORDS + word;
      words[at] = (words[at] as number) | bit;
      slots ^= lowest;
    }
  }
  return words;
}

/**
 * Adds how many slots of a tile set each plane to per-key counts, or takes them away: FragFp to the
 * first 512, the screen to the next 512, in the key order of `countKeys()`. Plane p is bit `p & 31`
 * of word `p >> 5`, so it is key `p ^ 31`.
 * @param counts - At least 1,024 counts, changed in place.
 * @param tile - The tile.
 * @param sign - 1 adds the tile's molecules, -1 takes them away.
 */
export function countTileKeys(
  counts: Float64Array,
  tile: TileViews,
  sign = 1,
): void {
  const { planes } = tile;
  for (let plane = 0; plane < PLANES; plane++) {
    const slots = planes[plane] as number;
    if (slots === 0) continue;
    const key = plane ^ 31;
    counts[key] = (counts[key] as number) + sign * popcount32(slots);
  }
}
