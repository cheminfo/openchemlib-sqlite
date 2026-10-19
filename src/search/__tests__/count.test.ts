/* eslint-disable no-await-in-loop -- each count is checked in turn */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getMoleculeRecords } from 'openchemlib-search-wasm';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { countTruth } from '../../__tests__/countTruth.ts';
import {
  TEST_SETS,
  drawSearches,
  keyPopulations,
} from '../../__tests__/draws.ts';
import {
  APP_SQL,
  SPEC,
  addMolecules,
  readIdCodes,
  testThreads,
} from '../../__tests__/testDatabase.ts';
import type { TruthRow } from '../../__tests__/truth.ts';
import { readTruth } from '../../__tests__/truth.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';
import type { CountOptions } from '../countPage.ts';

const ALL_KEYS = Array.from({ length: 1536 }, (_, bit) => bit);

let directory: string;
let file: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;
let rows: TruthRow[];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-count-'));
  file = join(directory, 'db.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  await addMolecules(db, store, readIdCodes(), { seed: 7 });
  rows = readTruth(db, { keys: true });
  // One block per atom count: entries span every word of its bands.
  index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    follow: false,
  });
}, 120_000);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Counts with the index and checks the counts against the truth.
 * @param target - The index.
 * @param options - The count's options.
 * @param label - What the count is.
 */
async function expectCounts(
  target: MoleculeIndex,
  options: CountOptions,
  label: string,
): Promise<void> {
  await expect(target.count(options), `count ${label}`).resolves.toStrictEqual(
    countTruth(rows, options),
  );
}

test("the oracle's keys, read from the tile slots, are the records of getMoleculeRecords", () => {
  const sample = rows.filter((_, i) => i % 10 === 0);
  const { words } = getMoleculeRecords(
    sample.map((row) => row.idCode),
    { maxTautomers: 0 },
  );

  expect(sample).toHaveLength(210);

  for (const [i, row] of sample.entries()) {
    expect(row.keys, `${row.id}`).toStrictEqual(
      words.slice(48 * i, 48 * i + 48),
    );
  }
});

test('the total of a count is what a browse answers: sets, set expressions, keys, filters, key bounds, all together', async () => {
  const cases: CountOptions[] = [
    {},
    { sets: ['source:2'] },
    { sets: ['source:1', 'source:3'] },
    { sets: [] },
    { sets: ['source:99'] },
    { allSets: ['source:1', 'source:2'] },
    { sets: ['listed'], noneSets: ['source:1'] },
    { sets: ['source:3'], allSets: ['source:3'], noneSets: ['source:99'] },
    { filters: { logP: { min: 2 } } },
    { filters: { hba: { min: 35_000 } } },
    { filters: { hba: { max: 3 }, charge: { min: 0, max: 1 } } },
    { keyMin: 250, keyMax: 400 },
    { keyMin: 250.5 },
    { keyMax: 150 },
    {
      sets: ['source:1', 'source:2'],
      noneSets: ['source:3'],
      bits: { all: [16], none: [3] },
      filters: { logP: { max: 4 } },
      keyMin: 100,
      keyMax: 500,
    },
  ];
  const draws = drawSearches(rows, 3, 25);
  for (const [i, options] of [...cases, ...draws].entries()) {
    await expectCounts(index, options, `case ${i}: ${JSON.stringify(options)}`);
  }

  // The draws are not all empty: 18 of the 25 answer rows.
  expect(
    draws.filter((options) => countTruth(rows, options).total > 0),
  ).toHaveLength(18);
});

test('per set and per key, every key at once, on every row and on a 0.5 % subset', async () => {
  const populations = keyPopulations(rows);
  // A key held by about 0.5 % of the rows: few words of an entry survive, read one by one.
  let rare = 0;
  for (let bit = 0; bit < 1536; bit++) {
    const share = (populations[bit] as number) / rows.length;
    if (share >= 0.004 && share <= 0.006) rare = bit;
  }
  const dense: CountOptions = {
    bySets: TEST_SETS,
    byKeys: ALL_KEYS,
    sets: TEST_SETS,
  };
  const sparse: CountOptions = { ...dense, bits: { all: [rare] } };
  await expectCounts(index, dense, 'every row');
  await expectCounts(index, sparse, `key ${rare}`);

  const subset = countTruth(rows, sparse);

  expect(subset.total).toBeGreaterThanOrEqual(0.004 * rows.length);
  expect(subset.total).toBeLessThanOrEqual(0.006 * rows.length);
  expect(subset.byKey[rare]).toBe(subset.total);
  expect(
    countTruth(rows, { ...dense, bySets: ['source:99'] }).bySet,
  ).toStrictEqual([0]);

  await expectCounts(index, { bySets: ['source:99', 'listed'] }, 'unknown set');
});

test('membership in 3, 16 and 20 sets, by combination up to 16', async () => {
  const three = ['listed', 'source:2', 'source:3'];
  // Repeated and unknown names: a row belongs to every copy of a set, and to no unknown one.
  const sixteen = [
    ...TEST_SETS,
    ...TEST_SETS,
    ...TEST_SETS,
    'source:9',
    'source:8',
    'source:1',
    'source:2',
  ];
  const twenty = [...sixteen, 'listed', 'source:3', 'source:7', 'source:1'];
  for (const membershipOf of [three, sixteen, twenty]) {
    await expectCounts(
      index,
      { sets: TEST_SETS, membershipOf },
      `${membershipOf.length} sets`,
    );
  }
  const counts = await index.count({ sets: TEST_SETS, membershipOf: sixteen });

  expect(counts.combinations).toHaveLength(65_536);
  expect(counts.membership).toHaveLength(17);

  const wide = await index.count({ membershipOf: twenty });

  expect(wide.combinations).toStrictEqual([]);
  expect(wide.membership).toHaveLength(21);
});

test('histograms of the key and of an int16 column with nulls: below, bins, above, missing', async () => {
  const cases: CountOptions[] = [
    { histogram: { of: 'key', min: 100, width: 50, bins: 6 } },
    { histogram: { of: 'hba', min: 1, width: 2, bins: 4 } },
    {
      sets: ['source:2'],
      histogram: { of: 'charge', min: -1, width: 1, bins: 2 },
    },
  ];
  for (const options of cases) {
    await expectCounts(index, options, JSON.stringify(options.histogram));
  }
  const { histogram } = countTruth(rows, cases[1] as CountOptions);

  // Every slot is used: rows with 0 below, rows above 8 (40,000 saturated among them), nulls.
  expect(histogram.every((count) => count > 0)).toBe(true);
});

test('many small chunks count the same, and a count out of budget says it is not complete', async () => {
  const chunked = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    blockRows: 512,
    follow: false,
    countChunkRows: 64,
  });
  try {
    for (const options of [
      {},
      { keyMin: 120, keyMax: 330 },
      {
        bySets: TEST_SETS,
        histogram: { of: 'key', min: 0, width: 100, bins: 10 },
      },
      ...drawSearches(rows, 5, 5),
    ] as CountOptions[]) {
      await expectCounts(chunked, options, JSON.stringify(options));
    }
    const late = await chunked.count({ budgetMs: 0 });

    expect(late.complete).toBe(false);

    const stopped = await chunked.count({ signal: AbortSignal.abort() });

    expect(stopped.complete).toBe(false);
  } finally {
    await chunked.close();
  }
});

test('a count with invalid options is refused before anything runs', async () => {
  await expect(index.count({ bits: { all: [1536] } })).rejects.toThrow(
    'a key bit is a whole number from 0 to 1535, not 1536',
  );
  await expect(index.count({ filters: { mass: { min: 1 } } })).rejects.toThrow(
    'no filter column named "mass"',
  );
});
