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
