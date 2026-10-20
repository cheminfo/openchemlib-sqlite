/**
 * The fingerprint a similarity search scores: `'fragFp'`, OCL's 512 FragFp keys;
 * `'screen'`, the 512 query-fragment keys of the screen; `'both'`, all 1,024 bits.
 */
export type SimilarityFingerprint = 'fragFp' | 'screen' | 'both';

/** Every fingerprint, in the order the image keeps their zones. */
export const FINGERPRINTS: readonly SimilarityFingerprint[] = [
  'fragFp',
  'screen',
  'both',
];

/**
 * The words of a molecule's 32 (FragFp words 0-15, screen words 16-31) a fingerprint scores.
 * @param fingerprint - The fingerprint.
 * @returns The first word and one past the last.
 */
export function fingerprintWords(
  fingerprint: SimilarityFingerprint,
): [number, number] {
  if (fingerprint === 'fragFp') return [0, 16];
  if (fingerprint === 'screen') return [16, 32];
  return [0, 32];
}

/**
 * Checks a fingerprint a caller gave.
 * @param value - The value.
 * @returns It, when it names a fingerprint.
 * @throws {Error} When it does not.
 */
export function checkFingerprint(value: unknown): SimilarityFingerprint {
  if (FINGERPRINTS.includes(value as SimilarityFingerprint)) {
    return value as SimilarityFingerprint;
  }
  throw new Error(
    `the similarity fingerprint is 'fragFp', 'screen' or 'both', not ${JSON.stringify(value)}`,
  );
}
