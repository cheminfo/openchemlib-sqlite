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
import { FORMAT } from '../../chemistry/stamp.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';

const idCodes = readIdCodes();
let directory: string;
let file: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-rebuilt-'));
  file = join(directory, 'db.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 30000');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  await addMolecules(db, store, idCodes.slice(0, 120), { sources: [1] });
  index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    readers: testThreads(2),
    pollMs: 3_600_000,
  });
}, 120_000);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('counting the bits again keeps the stamp: the index follows the file through the rebuild', async () => {
  db.prepare(
    "UPDATE ocl_meta SET value = 'x' WHERE name = 'counted.fragFp'",
  ).run();
  await MoleculeStore.rebuild(db, { threads: testThreads(2) });
  const [id] = await addMolecules(db, store, [idCodes[120] as string], {
    sources: [1],
  });
  await index.poll();
  const page = await index.browse({ limit: 1000 });

  expect(page.hits.map((hit) => hit.id)).toContain(id);
  expect(page.hits).toHaveLength(121);
}, 60_000);

test('tiles rebuilt under another stamp: the index stops following, and still answers from what it loaded', async () => {
  db.prepare("UPDATE ocl_meta SET value = ? WHERE name = 'stamp'").run(
    `${FORMAT}:0123456789abcdef`,
  );

  await expect(index.poll()).rejects.toThrow(
    /rebuilt under another stamp: the index is no longer followed/,
  );
  await expect(index.poll()).rejects.toThrow(/no longer followed/);

  const page = await index.browse({ limit: 1000 });

  expect(page.hits).toHaveLength(121);
}, 60_000);
