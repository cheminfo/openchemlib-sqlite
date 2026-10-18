/** Bins of the key histogram. */
export const HISTOGRAM_BINS = 2 ** 20;

/**
 * How many rows each range of the order key holds: what cuts the key axis into slices of a given
 * row count. Bins span [lo, lo + 2^20 / scale); a key outside falls in the first or the last bin.
 * Its counts are approximate by design: they size slices, never decide an answer.
 */
export interface KeyHistogram {
  /** One Uint32 count per bin. */
  counts: SharedArrayBuffer;
  /** The lower edge of the first bin. */
  lo: number;
  /** Bins per unit of key. */
  scale: number;
}

/**
 * A histogram covering keys from `low` to `high`.
 * @param low - The least key.
 * @param high - The largest key.
 * @returns An empty histogram.
 */
export function newHistogram(low: number, high: number): KeyHistogram {
  const lo = Number.isFinite(low) ? low : 0;
  const span = Number.isFinite(high) && high > lo ? high - lo : 1;
  return {
    counts: new SharedArrayBuffer(4 * HISTOGRAM_BINS),
    lo,
    // A little room above the largest key, for the molecules the tail adds.
    scale: HISTOGRAM_BINS / (span * 1.0625),
  };
}

/**
 * The bin of a key.
 * @param histogram - The histogram.
 * @param key - The key.
 * @returns The bin, 0 to 2^20 - 1.
 */
export function binOf(histogram: KeyHistogram, key: number): number {
  const bin = Math.floor((key - histogram.lo) * histogram.scale);
  if (!(bin >= 0)) return 0;
  return bin >= HISTOGRAM_BINS ? HISTOGRAM_BINS - 1 : bin;
}

/**
 * The lower edge of a bin, Infinity past the last one.
 * @param histogram - The histogram.
 * @param bin - The bin.
 * @returns Its lower edge.
 */
export function binEdge(histogram: KeyHistogram, bin: number): number {
  if (bin >= HISTOGRAM_BINS) return Infinity;
  return histogram.lo + bin / histogram.scale;
}

/**
 * The upper end of the slice starting at `start`: bins are added until they hold `target` rows.
 * The end is always above the start, so a walk of slices advances.
 * @param histogram - The histogram.
 * @param counts - Its counts.
 * @param start - Where the slice starts.
 * @param target - The rows it should hold.
 * @returns Its exclusive upper end, and the rows of the bins it spans.
 */
export function sliceEnd(
  histogram: KeyHistogram,
  counts: Uint32Array,
  start: number,
  target: number,
): { end: number; rows: number } {
  let bin = binOf(histogram, start);
  let rows = 0;
  while (bin < HISTOGRAM_BINS) {
    rows += counts[bin++] as number;
    if (rows >= target && binEdge(histogram, bin) > start) break;
  }
  return { end: binEdge(histogram, bin), rows };
}
