/** 32-bit words of one fingerprint: FragFp, the screen and the function bits have 16 each. */
export const FINGERPRINT_WORDS = 16;

/** Where the function words start in a molecule's 48: after FragFp and the screen. */
export const FUNCTION_WORDS_AT = 2 * FINGERPRINT_WORDS;

/**
 * The set bits of a 32-bit word.
 * @param value - The word.
 * @returns How many bits are set, 0 to 32.
 */
export function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * The set bits of a range of words.
 * @param words - The words.
 * @param from - The first word.
 * @param to - One past the last word.
 * @returns How many bits are set.
 */
export function countBits(words: Int32Array, from: number, to: number): number {
  let bits = 0;
  for (let word = from; word < to; word++) {
    bits += popcount32(words[word] as number);
  }
  return bits;
}

/**
 * Adds one fingerprint's bits to per-key counts, or takes them away. The counts are in key order:
 * key k is bit `31 - (k & 31)` of word `k >> 5`, the order of `getFragFpKeys()`, `getScreenKeys()`
 * and `getFunctionKeyFragments()`.
 * @param counts - The counts, changed in place.
 * @param at - Where the fingerprint's 512 counts start in `counts`.
 * @param words - The words.
 * @param from - Where the fingerprint's 16 words start in `words`.
 * @param sign - 1 adds the molecule, -1 takes it away.
 */
export function countKeys(
  counts: Float64Array,
  at: number,
  words: Int32Array,
  from: number,
  sign: number,
): void {
  for (let word = 0; word < FINGERPRINT_WORDS; word++) {
    let value = words[from + word] as number;
    while (value !== 0) {
      const lowest = value & -value;
      const key = at + 32 * word + Math.clz32(lowest);
      counts[key] = (counts[key] as number) + sign;
      value ^= lowest;
    }
  }
}
