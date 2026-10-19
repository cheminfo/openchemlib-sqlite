import { expect, test } from 'vitest';

import { SPEC } from '../../__tests__/testDatabase.ts';
import { columnLayout } from '../blocks.ts';
import { countsOf, readCountOptions } from '../countOptions.ts';
import type { CountOptions } from '../countPage.ts';
import { normalizeSpec } from '../spec.ts';

const LAYOUT = columnLayout(normalizeSpec(SPEC).filters);
const ALL_KEYS = Array.from({ length: 1536 }, (_, bit) => bit);

test.each<[string, CountOptions, string]>([
  [
    'a bit past 1535',
    { bits: { all: [1536] } },
    'a key bit is a whole number from 0 to 1535, not 1536',
  ],
  [
    'a bit that is not whole',
    { byKeys: [0.5] },
    'a key bit is a whole number from 0 to 1535, not 0.5',
  ],
  [
    'a negative bit',
    { bits: { any: [3, -1] } },
    'a key bit is a whole number from 0 to 1535, not -1',
  ],
  [
    '257 bits in a list',
    { bits: { none: Array.from({ length: 257 }, (_, i) => i) } },
    'at most 256 key bits per list',
  ],
  [
    '1,537 keys to count',
    { byKeys: [...ALL_KEYS, 0] },
    'byKeys holds at most 1536 key bits',
  ],
  [
    '33 sets of membership',
    { membershipOf: Array.from({ length: 33 }, () => 'listed') },
    'membershipOf holds at most 32 sets',
  ],
  [
    'a histogram of no column',
    { histogram: { of: 'mass', min: 0, width: 1, bins: 1 } },
    'histogram.of is \'key\' or a filter column (logP, hba, charge), not "mass"',
  ],
  [
    'a histogram of width 0',
    { histogram: { of: 'key', min: 0, width: 0, bins: 1 } },
    'histogram.width is a finite number above 0, not 0',
  ],
  [
    'a histogram from Infinity',
    { histogram: { of: 'key', min: Infinity, width: 1, bins: 1 } },
    'histogram.min is a finite number, not Infinity',
  ],
  [
    'a histogram of 101 bins',
    { histogram: { of: 'key', min: 0, width: 1, bins: 101 } },
    'histogram.bins is a whole number from 1 to 100, not 101',
  ],
  [
    'a histogram of 2.5 bins',
    { histogram: { of: 'hba', min: 0, width: 1, bins: 2.5 } },
    'histogram.bins is a whole number from 1 to 100, not 2.5',
  ],
])('%s is refused', (_name, options, message) => {
  expect(() => readCountOptions(options, LAYOUT)).toThrow(message);
});

test('the tallies are laid out as the counts read them: total, sets, keys, membership, histogram', () => {
  const request = readCountOptions(
    {
      bySets: ['listed', 'source:1'],
      byKeys: [0, 1535],
      membershipOf: ['listed', 'source:2'],
      histogram: { of: 'charge', min: -1, width: 1, bins: 3 },
    },
    LAYOUT,
  );

  expect(request.tallies).toBe(1 + 2 + 2 + 4 + 6);
  expect(Array.from(request.byKeys)).toStrictEqual([0 ^ 31, 1535 ^ 31]);
  expect(request.histogram).toStrictEqual({
    column: 2,
    min: -1,
    width: 1,
    bins: 3,
  });

  const tallies = Float64Array.from([
    9, 7, 2, 5, 1, 0, 6, 1, 2, 0, 3, 3, 2, 1, 0,
  ]);

  expect(countsOf(request, tallies, true)).toStrictEqual({
    total: 9,
    bySet: [7, 2],
    byKey: [5, 1],
    membership: [0, 7, 2],
    combinations: [0, 6, 1, 2],
    histogram: [0, 3, 3, 2, 1, 0],
    complete: true,
  });
});

test('a one-bit OR group is a bit to hold, and a list holds each bit once', () => {
  const request = readCountOptions(
    { bits: { all: [5, 5], any: [7], none: [9, 9, 8] } },
    LAYOUT,
  );

  expect(Array.from(request.keys.all)).toStrictEqual([5 ^ 31, 7 ^ 31]);
  expect(Array.from(request.keys.any)).toStrictEqual([]);
  expect(Array.from(request.keys.none)).toStrictEqual([9 ^ 31, 8 ^ 31]);
});
