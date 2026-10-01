/** How many 32-bit words the 512-bit FragFp occupies. */
const INDEX_WORDS = 16;

/**
 * Pack an OCL number[](16) fingerprint into 8 BigInt64 values for SQLite storage.
 * Uses a shared-buffer view so no per-element arithmetic is needed.
 * @param index - OCL fingerprint as returned by Molecule.getIndex().
 * @returns Array of 8 BigInt64 values ready to be stored as ss_index0..7 columns.
 */
export function packSSIndex(index: number[] | Uint32Array): bigint[] {
  return Array.from(new BigInt64Array(new Uint32Array(index).buffer));
}

/**
 * Reconstruct the OCL number[](16) fingerprint from the 8 BigInt ss_indexN
 * columns of a DB row returned with setReadBigInts(true).
 * Returns number[] for direct use with OCL SSSearcherWithIndex methods.
 * @param row - DB row containing ss_index0..7 BigInt columns.
 * @returns OCL fingerprint as a number[] compatible with SSSearcherWithIndex.
 */
export function unpackSSIndex(row: Record<string, unknown>): number[] {
  const values: bigint[] = [];
  for (let i = 0; i < 8; i++) {
    values.push((row[`ss_index${i}`] as bigint) ?? 0n);
  }
  return Array.from(new Uint32Array(new BigInt64Array(values).buffer));
}

/**
 * Pack a fingerprint a caller already holds, in whichever width it holds it.
 *
 * The 512-bit FragFp is sixteen 32-bit words or eight 64-bit ones, and callers
 * arrive with both: `getIndex()` from openchemlib-search-wasm returns an
 * `Int32Array`, `Molecule.getIndex()` a `number[]`, and a caller that stores the
 * eight columns itself already has them packed.
 * @param index - The fingerprint, 16 words of 32 bits or 8 of 64.
 * @returns The eight 64-bit words ready to bind.
 * @throws {RangeError} When it is neither width, which no fingerprint is.
 */
export function packGivenIndex(
  index: Int32Array | Uint32Array | number[] | BigInt64Array | bigint[],
): bigint[] {
  if (index instanceof BigInt64Array) return expectEight(Array.from(index));
  // byteOffset, not 0: `getIndexes()` returns its views over one shared buffer,
  // so a view for any molecule but the first starts partway into it. Reading
  // from 0 would silently store the first molecule's fingerprint instead — the
  // row is written, the index is built, and the screen then misses real hits.
  if (index instanceof Int32Array || index instanceof Uint32Array) {
    if (index.length !== INDEX_WORDS) {
      throw new RangeError(
        `a fingerprint is ${INDEX_WORDS} words of 32 bits, not ${index.length}`,
      );
    }
    return Array.from(new BigInt64Array(index.buffer, index.byteOffset, 8));
  }
  if (typeof index[0] === 'bigint') return expectEight(index as bigint[]);
  // Checked before packing: a BigInt64Array over a buffer whose length is not a
  // multiple of eight throws its own error, which says nothing about
  // fingerprints.
  if (index.length !== INDEX_WORDS) {
    throw new RangeError(
      `a fingerprint is ${INDEX_WORDS} words of 32 bits, not ${index.length}`,
    );
  }
  return expectEight(packSSIndex(index as number[]));
}

/**
 * Check a packed fingerprint is the eight words the index columns take.
 * @param packed - The words to check.
 * @returns Them, unchanged.
 * @throws {RangeError} When there are not eight.
 */
function expectEight(packed: bigint[]): bigint[] {
  if (packed.length !== 8) {
    throw new RangeError(
      `a fingerprint is 8 words of 64 bits, not ${packed.length}`,
    );
  }
  return packed;
}
