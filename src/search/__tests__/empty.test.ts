import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  APP_SQL,
  SPEC,
  addMolecules,
  readIdCodes,
  testThreads,
} from '../../__tests__/testDatabase.ts';
import {
  readAll,
  readTruth,
  substructureTruth,
} from '../../__tests__/truth.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';

let directory: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-empty-'));
  const file = join(directory, 'db.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    pollMs: 3_600_000,
  });
});

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('an index opened on an empty store answers nothing, then follows the first commits', async () => {
  const benzene = OCL.Molecule.fromSmiles('c1ccccc1').getIDCode();
  const empty = await index.substructure(benzene);

  expect(empty).toMatchObject({ hits: [], next: undefined, partial: false });
  expect(index.rowCount).toBe(0);

  await addMolecules(db, store, readIdCodes().slice(0, 120));
  await index.poll();
  const rows = readTruth(db);
  const { ids } = await readAll(index, benzene, { limit: 7 });

  expect(ids).toStrictEqual(substructureTruth(rows, benzene, {}));
  expect(index.rowCount).toBe(store.count());
});
