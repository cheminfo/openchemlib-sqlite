import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  APP_SQL,
  SPEC,
  addMolecules,
  readIdCodes,
  testThreads,
} from '../../__tests__/testDatabase.ts';
import type { TruthRow } from '../../__tests__/truth.ts';
import { readTruth, substructureTruth } from '../../__tests__/truth.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';

import { openWithSnapshot } from './snapshotHelpers.ts';

const BENZENE = 'gFp@DiTt@@@';
const FIRST_SLICE = 64;

let directory: string;
let file: string;
let snapshot: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;
let rows: TruthRow[];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-empty-'));
  file = join(directory, 'db.sqlite');
  snapshot = join(directory, 'index.snapshot');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 30000');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(4) });
  // Opened on an empty file, as a server is before its first import: every
  // molecule reaches the index through the tail.
  index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    blockRows: 512,
    firstSliceRows: FIRST_SLICE,
    appendBlockRows: 64,
    pollMs: 3_600_000,
    snapshot,
    snapshotRefreshShare: Infinity,
  });
  await addMolecules(db, store, readIdCodes().slice(0, 1200), { seed: 5 });
  await index.poll();
  await index.waitForSeq(store.lastSeq(), 30_000);
  rows = readTruth(db);
}, 120_000);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * The first pages of a browse and of a benzene search, checked against brute
 * force, and how many rows the browse read.
 * @param searched - The index.
 * @returns The rows the first browse page read.
 */
async function firstPages(searched: MoleculeIndex): Promise<number> {
  const browse = await searched.browse({ limit: 5 });
  const benzene = await searched.substructure(BENZENE, { limit: 5 });

  expect(browse.hits.map((hit) => hit.id)).toStrictEqual(
    substructureTruth(rows, '', {}).slice(0, 5),
  );
  expect(benzene.hits.map((hit) => hit.id)).toStrictEqual(
    substructureTruth(rows, BENZENE, {}).slice(0, 5),
  );

  return browse.info.candidates;
}

test('an index started empty slices what the tail added by weight, not as one slice', async () => {
  expect(index.rowCount).toBe(1200);
  // One slice holding the whole image read every row: 1,200 here.
  await expect(firstPages(index)).resolves.toBeLessThan(rows.length / 4);
});

test('its snapshot restores with a histogram rebuilt from the bands', async () => {
  await index.saveSnapshot();
  let candidates = Infinity;
  await openWithSnapshot(
    { file, snapshot, options: { firstSliceRows: FIRST_SLICE } },
    async (restored) => {
      candidates = await firstPages(restored);
    },
  );

  expect(candidates).toBeLessThan(rows.length / 4);
});
