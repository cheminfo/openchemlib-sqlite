import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { similarityTruth } from '../../__tests__/similarityTruth.ts';
import {
  APP_SQL,
  SPEC,
  addMolecules,
  readIdCodes,
  testThreads,
} from '../../__tests__/testDatabase.ts';
import type { TruthRow } from '../../__tests__/truth.ts';
import {
  readAll,
  readTruth,
  substructureTruth,
} from '../../__tests__/truth.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';
import type { SearchOptions } from '../pages.ts';

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();

let directory: string;
let file: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;
let rows: TruthRow[];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-sets-'));
  file = join(directory, 'db.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  await addMolecules(db, store, readIdCodes().slice(0, 400), { seed: 9 });
  rows = readTruth(db);
  index = await MoleculeIndex.open(file, SPEC, {
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

/**
 * Checks a browse, a count and a similarity search against the ids the sets keep.
 * @param target - The index.
 * @param options - The sets.
 * @param expected - The ids a browse answers, in order.
 */
async function expectSets(
  target: MoleculeIndex,
  options: SearchOptions,
  expected: number[],
): Promise<void> {
  const label = JSON.stringify(options);
  const { ids } = await readAll(target, '', { ...options, limit: 1000 });

  expect(ids, `browse ${label}`).toStrictEqual(expected);
  await expect(target.count(options), `count ${label}`).resolves.toMatchObject({
    total: expected.length,
    complete: true,
  });

  const benzene = smiles('c1ccccc1');
  const similar = await target.similarity(benzene, {
    ...options,
    threshold: 0.2,
    limit: 1000,
  });
  const hits = similarityTruth(rows, benzene, 0.2, options);

  expect(similar.hits, `similarity ${label}`).toStrictEqual(hits);
  expect(similar.total, `similarity ${label}`).toBe(hits.length);
}

test('unknown names: in sets they add nothing, in allSets they answer nothing, in noneSets they remove nothing', async () => {
  const listed = substructureTruth(rows, '', { sets: ['listed'] });
  const sourceB = substructureTruth(rows, '', { sets: ['source:2'] });

  expect(listed.length).toBeGreaterThan(sourceB.length);
  expect(sourceB.length).toBeGreaterThan(0);

  await expectSets(index, { sets: ['nope'] }, []);
  await expectSets(index, { sets: ['nope', 'listed'] }, listed);
  await expectSets(index, { sets: [] }, []);
  await expectSets(index, { allSets: ['nope'] }, []);
  await expectSets(
    index,
    { sets: ['source:2'], allSets: ['source:2', 'nope'] },
    [],
  );
  await expectSets(index, { noneSets: ['nope'] }, listed);
  await expectSets(index, { sets: ['source:2'], noneSets: ['nope'] }, sourceB);
  await expectSets(index, { sets: ['source:2'], noneSets: ['source:2'] }, []);
  await expectSets(
    index,
    { sets: ['source:1', 'source:2'], allSets: ['source:2'] },
    sourceB,
  );
});

test('sets left out follow the default sets, or every alive row without any', async () => {
  const listed = substructureTruth(rows, '', { sets: ['listed'] });
  await expectSets(index, {}, listed);

  const everything = rows.map((row) => row.id);
  const open = await MoleculeIndex.open(
    file,
    { ...SPEC, defaultSets: undefined },
    { threads: testThreads(1), blockRows: 512, follow: false },
  );
  try {
    expect(everything.length).toBeGreaterThan(listed.length);

    await expectSets(open, {}, everything);
    await expectSets(open, { allSets: ['listed'] }, listed);
    await expectSets(
      open,
      { noneSets: ['listed'] },
      everything.filter((id) => !listed.includes(id)),
    );
  } finally {
    await open.close();
  }
});
