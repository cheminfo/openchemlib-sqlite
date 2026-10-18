import type { KeyHistogram } from './histogram.ts';
import { HISTOGRAM_BINS, binOf, newHistogram } from './histogram.ts';
import type { Segment } from './layoutTypes.ts';

/**
 * A histogram rebuilt from the bands alone: each band's rows spread evenly over the bins its zone
 * spans. Bands are narrow, so it sizes slices as well as counting every key would, without
 * reading a row. A histogram made when the index started empty covers none of the keys the tail
 * added since, and puts every row in one edge bin: a slice sized by it holds the whole image.
 * @param segments - The version's segments.
 * @returns The histogram, counted.
 */
export function histogramOfBands(segments: readonly Segment[]): KeyHistogram {
  let low = Infinity;
  let high = -Infinity;
  for (const segment of segments) {
    for (const band of segment.bands) {
      if (band.rows === 0 || !(band.zmin <= band.zmax)) continue;
      if (band.zmin < low) low = band.zmin;
      if (band.zmax > high) high = band.zmax;
    }
  }
  const histogram = newHistogram(low, high);
  // A band adds its share to every bin of its zone: a difference array, summed once.
  const deltas = new Float64Array(HISTOGRAM_BINS + 1);
  for (const segment of segments) {
    for (const band of segment.bands) {
      if (band.rows === 0 || !(band.zmin <= band.zmax)) continue;
      const first = binOf(histogram, band.zmin);
      const last = binOf(histogram, band.zmax);
      const share = band.rows / (last - first + 1);
      deltas[first] = (deltas[first] as number) + share;
      deltas[last + 1] = (deltas[last + 1] as number) - share;
    }
  }
  const counts = new Uint32Array(histogram.counts);
  let running = 0;
  let carried = 0;
  for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
    running += deltas[bin] as number;
    // Whole rows per bin, the rest carried on, so the bins add up to the bands' rows.
    const exact = Math.max(0, running) + carried;
    const whole = Math.max(0, Math.round(exact));
    counts[bin] = whole;
    carried = exact - whole;
  }
  return histogram;
}

/**
 * Whether a histogram no longer sizes slices: its two edge bins, where a key outside its range
 * falls, hold more than a quarter of the rows.
 * @param counts - Its counts.
 * @param rows - The rows of the version.
 * @returns True when it should be rebuilt from the bands.
 */
export function isEdgeHeavy(counts: Uint32Array, rows: number): boolean {
  const edges = (counts[0] as number) + (counts[HISTOGRAM_BINS - 1] as number);
  return rows > 0 && edges * 4 > rows;
}
