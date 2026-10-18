import { expect, test } from 'vitest';

import { histogramOfBands, isEdgeHeavy } from '../bandHistogram.ts';
import { HISTOGRAM_BINS, sliceEnd } from '../histogram.ts';
import type { Segment } from '../layoutTypes.ts';
import { bandRecord } from '../layoutTypes.ts';

/**
 * A segment of bands, each given as [band, least key, largest key, rows].
 * @param atoms - Its atom count.
 * @param bands - Its bands.
 * @returns The segment.
 */
function segmentOf(
  atoms: number,
  bands: Array<[number, number, number, number]>,
): Segment {
  return {
    atoms,
    bands: bands.map(([band, zmin, zmax, rows]) =>
      bandRecord(band, [], zmin, zmax, rows, -1, 0, 0),
    ),
    index: null,
    indexCount: 0,
    tail: null,
  };
}

test('the rows of every band are spread over the keys of its zone', () => {
  const histogram = histogramOfBands([
    segmentOf(12, [[78, 78.1, 78.2, 1000]]),
    segmentOf(30, [
      [200, 200, 201, 3000],
      [350, 350, 350, 0],
    ]),
  ]);
  const counts = new Uint32Array(histogram.counts);
  let total = 0;
  for (let bin = 0; bin < HISTOGRAM_BINS; bin++) total += counts[bin] as number;

  expect(total).toBe(4000);

  const first = sliceEnd(histogram, counts, -Infinity, 500);

  expect(first.end).toBeGreaterThan(78.1);
  expect(first.end).toBeLessThan(78.2);

  const second = sliceEnd(histogram, counts, first.end, 1500);

  expect(second.end).toBeGreaterThan(200);
  expect(second.end).toBeLessThan(201);
});

test('a histogram whose edge bins hold over a quarter of the rows is rebuilt', () => {
  const counts = new Uint32Array(HISTOGRAM_BINS);
  counts[HISTOGRAM_BINS - 1] = 251;

  expect(isEdgeHeavy(counts, 1000)).toBe(true);

  counts[HISTOGRAM_BINS - 1] = 250;

  expect(isEdgeHeavy(counts, 1000)).toBe(false);
  expect(isEdgeHeavy(new Uint32Array(HISTOGRAM_BINS), 0)).toBe(false);
});
