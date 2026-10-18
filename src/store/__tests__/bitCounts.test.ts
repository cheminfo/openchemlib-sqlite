import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, expect, test } from 'vitest';

import { readIdCodes, testThreads } from '../../__tests__/testDatabase.ts';
import { MoleculeStore } from '../MoleculeStore.ts';

import { bruteCounts } from './bruteCounts.ts';
import { commitIds, commitSteps, removeIds } from './storeSteps.ts';

const idCodes = readIdCodes();
let directory: string;
let db: DatabaseSync;
let store: MoleculeStore;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-bits-'));
  db = new DatabaseSync(join(directory, 'db.sqlite'));
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
});

afterAll(async () => {
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('a new store counts nothing yet, under its own keys', () => {
  const counts = store.bitCounts();

  expect(counts.molecules).toBe(0);
  expect(counts.fragFp).toStrictEqual(new Float64Array(512));
  expect(counts.screen).toStrictEqual(new Float64Array(512));
  expect(counts.functions).toStrictEqual(new Float64Array(512));
});

test('each new molecule is counted once: not a duplicate, not one in error', async () => {
  const batch = [...idCodes.slice(0, 250), idCodes[3] as string, ''];
  const results = await commitSteps(store, db, batch);

  expect(results.filter((result) => result?.[1] === true)).toHaveLength(250);
  expect(results.at(-1)).toBeUndefined();
  expect(store.bitCounts()).toStrictEqual(bruteCounts(db));
  expect(store.bitCounts().molecules).toBe(250);
});

test('a commit rolled back leaves the counts as they were', async () => {
  const before = store.bitCounts();
  await commitSteps(store, db, idCodes.slice(250, 300), 'ROLLBACK');

  expect(store.bitCounts()).toStrictEqual(before);
});

test('a removed molecule takes its bits away, the function bits computed again', async () => {
  const ids = await commitIds(store, db, idCodes.slice(300, 400));
  removeIds(
    store,
    db,
    ids.filter((_, i) => i % 3 === 0),
  );
  const counts = store.bitCounts();

  expect(counts.molecules).toBe(316);
  expect(counts).toStrictEqual(bruteCounts(db));
});
