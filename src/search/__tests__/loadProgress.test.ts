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
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';
import type { LoadProgress } from '../load/loadProgress.ts';

let directory: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;
const heard: LoadProgress[] = [];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-progress-'));
  const file = join(directory, 'db.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  await addMolecules(db, store, readIdCodes().slice(0, 120));
  index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    pollMs: 3_600_000,
    onProgress: (progress) => heard.push(progress),
  });
});

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('each step of the load is heard starting, then finished with every task taken', () => {
  const finished = heard.filter((progress) => progress.finished);

  expect(finished).toStrictEqual([
    { step: 'plan', done: 0, total: 0, finished: true },
    // One task per atom count: 43 of them among the first 120 molecules.
    { step: 'cells', done: 43, total: 43, finished: true },
    { step: 'tiles', done: 43, total: 43, finished: true },
    { step: 'index', done: 43, total: 43, finished: true },
    { step: 'columns', done: 43, total: 43, finished: true },
    // One task per (atom count, band) cell.
    { step: 'zones', done: 115, total: 115, finished: true },
    // The specification's four sets over the 43 pieces.
    { step: 'sets', done: 172, total: 172, finished: true },
    { step: 'frequencies', done: 0, total: 0, finished: true },
    { step: 'tail', done: 0, total: 0, finished: true },
    { step: 'workers', done: 0, total: 0, finished: true },
  ]);
  expect(
    heard.filter((progress) => !progress.finished && progress.done === 0),
  ).toHaveLength(10);
  expect(index.rowCount).toBe(store.count());
});

test('a running step never reports more tasks than it holds, nor fewer than before', () => {
  const last = new Map<string, number>();
  const regressions: string[] = [];
  for (const { step, done, total } of heard) {
    if (done > total || done < (last.get(step) ?? 0)) {
      regressions.push(`${step}: ${done} of ${total}`);
    }
    last.set(step, done);
  }

  expect(regressions).toStrictEqual([]);
});
