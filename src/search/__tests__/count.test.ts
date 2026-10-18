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

let directory: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;
let rows: TruthRow[];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-count-'));
  db = new DatabaseSync(join(directory, 'db.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  await addMolecules(db, store, readIdCodes(), { seed: 7 });
  rows = readTruth(db);
  index = await MoleculeIndex.open(join(directory, 'db.sqlite'), SPEC, {
    threads: testThreads(2),
    blockRows: 512,
    follow: false,
  });
}, 120_000);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('a browse with no filter is counted on the bitmaps, as many as it answers', () => {
  const selections = [
    undefined,
    ['source:2'],
    ['source:1', 'source:3'],
    ['source:3'],
    ['source:99'],
    [],
  ];
  for (const sets of selections) {
    const answered = substructureTruth(
      rows,
      '',
      sets === undefined ? {} : { sets },
    ).length;

    expect(index.count(sets)).toBe(answered);
  }

  expect(index.count(['source:99'])).toBe(0);
});
