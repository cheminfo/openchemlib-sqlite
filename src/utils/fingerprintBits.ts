/**
 * How many bits a fingerprint sets, from its eight 64-bit words.
 *
 * Stored with each entry, it bounds the Tanimoto coefficient the entry can
 * reach with any query: `t·|q| ≤ |r| ≤ |q|/t`, since the bits two
 * fingerprints share are at most the smaller count and the bits either sets
 * at least the larger. It is the value of `ocl_ss_index.ss_bits`, for a
 * caller that writes rows of the index with its own SQL: a row written without
 * it is still found, its coefficient computed rather than bounded first.
 * @param words - The eight words, as SQLite stores them.
 * @returns The population count.
 */
export function fingerprintBits(words: readonly bigint[]): number {
  let count = 0;
  for (const word of words) {
    const value = BigInt.asUintN(64, word);
    count += bitCount(Number(value & 0xffffffffn));
    count += bitCount(Number(value >> 32n));
  }
  return count;
}

/**
 * How many bits a fingerprint sets, from its sixteen 32-bit words.
 * @param words - The words, as `Molecule.getIndex()` returns them.
 * @returns The population count.
 */
export function indexBits(words: readonly number[]): number {
  let count = 0;
  for (const word of words) count += bitCount(word >>> 0);
  return count;
}

/**
 * How many bits a 32-bit word sets.
 * @param value - The word.
 * @returns Its population count.
 */
export function bitCount(value: number): number {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
