/* eslint-disable no-await-in-loop -- each bad limit is refused in turn */
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
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';
import { MAX_PAGE_LIMIT } from '../pages.ts';
import { nextGeneration } from '../pool/SearchPool.ts';

let directory: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-robust-'));
  const file = join(directory, 'db.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(1) });
  await addMolecules(db, store, readIdCodes().slice(0, 100));
  index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    pollMs: 3_600_000,
  });
}, 120_000);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('a bad page limit is refused, and the workers keep answering', async () => {
  const benzene = OCL.Molecule.fromSmiles('c1ccccc1').getIDCode();
  for (const limit of [-1, 0, 1.5, Infinity, MAX_PAGE_LIMIT + 1]) {
    await expect(index.similarity(benzene, { limit })).rejects.toThrow(
      /limit is a whole number/,
    );
    await expect(index.browse({ limit })).rejects.toThrow(
      /limit is a whole number/,
    );
  }
  const page = await index.browse({ limit: 5 });

  expect(page.hits).toHaveLength(5);
});

test('the phase generation wraps before an Int32 would turn it negative', () => {
  expect(nextGeneration(0)).toBe(1);
  expect(nextGeneration(41)).toBe(42);
  expect(nextGeneration(2 ** 31 - 2)).toBe(2 ** 31 - 1);
  expect(nextGeneration(2 ** 31 - 1)).toBe(1);
});

test('a change log emptied past what the index applied is reported', async () => {
  const { id } = db
    .prepare('SELECT id FROM molecules ORDER BY id LIMIT 1')
    .get() as { id: number };
  db.exec("INSERT INTO sources (id, name, isPublic) VALUES (9, 'Late', 1)");
  db.prepare(
    'INSERT INTO molecule_sources (sourceId, moleculeId) VALUES (9, ?)',
  ).run(id);
  db.exec('DELETE FROM entry_changes');
  await index.poll();

  expect(index.errors).toStrictEqual([
    'the change log was pruned past the changes the image applied: load the index again',
  ]);
});
