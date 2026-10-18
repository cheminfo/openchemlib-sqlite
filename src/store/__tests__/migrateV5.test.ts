import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, test } from 'vitest';

import { SPEC } from '../../__tests__/testDatabase.ts';
import { MoleculeIndex } from '../../search/MoleculeIndex.ts';
import { MoleculeStore } from '../MoleculeStore.ts';
import { migrateFromV5 } from '../migrateV5.ts';

import {
  ENTRIES,
  THREADS,
  fiveFile,
  idCodeOf,
  idsOf,
  removeFiveFiles,
} from './v5Fixture.ts';

afterEach(removeFiveFiles);

test('a 5.x file is refused by the store until it is migrated', async () => {
  const { db } = fiveFile();

  await expect(
    MoleculeStore.open(db, { threads: 1, checkRows: 0 }),
  ).rejects.toThrow('migrate it in place with migrateFromV5()');

  db.close();
});

test('every entry gets the id of its molecule, one structure one id', async () => {
  const { db } = fiveFile();
  const add = db.prepare('INSERT INTO molecules (id, id_code) VALUES (?, ?)');
  add.run(7, idCodeOf('OCC'));
  add.run(8, '!!!');

  const result = await migrateFromV5(db, {
    entries: ENTRIES,
    threads: THREADS,
    chunkSize: 3,
    finish: true,
  });

  expect(result).toStrictEqual({
    entries: 8,
    created: 6,
    failed: 1,
    pending: 0,
    migrated: true,
  });

  const ids = idsOf(db);

  expect(ids.map((row) => row.entry)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  // Ethanol, written twice, is one molecule; the entry that is no idCode has none.
  expect(ids[6]?.id).toBe(ids[0]?.id);
  expect(ids[7]).toStrictEqual({
    entry: 8,
    id: null,
    error: 'the idCode cannot be read',
  });
  expect(ids.slice(0, 7).every((row) => row.error === null)).toBe(true);

  const store = await MoleculeStore.open(db, { threads: 1 });

  expect(store.count()).toBe(6);
  await expect(
    store.find([idCodeOf('CCO'), idCodeOf('C[C@@H](N)C(=O)O')]),
  ).resolves.toStrictEqual([ids[0]?.id, ids[4]?.id]);

  await store.close();
  db.close();
});

test('what the 5.x writers change meanwhile is converted again, and the store is refused until the end', async () => {
  const { db, file } = fiveFile();
  const controller = new AbortController();

  await expect(
    migrateFromV5(db, {
      entries: ENTRIES,
      threads: THREADS,
      chunkSize: 2,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
  ).rejects.toThrow(/abort/i);

  // Entries 1 and 2 are converted; the 5.x application keeps writing.
  db.prepare('INSERT INTO molecules (id, id_code) VALUES (10, ?)').run(
    idCodeOf('CCN'),
  );
  db.prepare('UPDATE molecules SET id_code = ? WHERE id = 1').run(
    idCodeOf('CCCl'),
  );
  // As 5.x removes an entry: its index rows, which keep a foreign key to it, then the entry.
  for (const table of [
    'ocl_ss_index',
    'ocl_ss_slot',
    'ocl_no_stereo_hash',
    'ocl_no_stereo_tautomer_hash',
  ]) {
    db.exec(`DELETE FROM ${table} WHERE entry_id IN (2, 6)`);
  }
  db.exec('DELETE FROM molecules WHERE id IN (2, 6)');

  await expect(
    MoleculeStore.open(db, { threads: 1, checkRows: 0 }),
  ).rejects.toThrow('migration from openchemlib-sqlite 5.x is under way');
  await expect(MoleculeIndex.open(file, SPEC)).rejects.toThrow('under way');
  await expect(
    migrateFromV5(db, { entries: ENTRIES, threads: THREADS }),
  ).resolves.toStrictEqual({
    entries: 4,
    created: 4,
    failed: 0,
    pending: 4,
    migrated: false,
  });
  await expect(
    migrateFromV5(db, {
      entries: ENTRIES,
      threads: THREADS,
      finish: true,
    }),
  ).resolves.toStrictEqual({
    entries: 4,
    created: 1,
    failed: 0,
    pending: 0,
    migrated: true,
  });

  const ids = idsOf(db);

  expect(ids.map((row) => row.entry)).toStrictEqual([1, 3, 4, 5, 10]);

  const store = await MoleculeStore.open(db, { threads: 1 });

  // Ethanol and benzene lost their only entry; aspirin was removed before it was converted.
  await expect(
    store.find([
      idCodeOf('CCO'),
      idCodeOf('c1ccccc1'),
      idCodeOf('CC(=O)Oc1ccccc1C(=O)O'),
      idCodeOf('CCCl'),
      idCodeOf('CCN'),
    ]),
  ).resolves.toStrictEqual([
    undefined,
    undefined,
    undefined,
    ids[0]?.id,
    ids[4]?.id,
  ]);
  expect(store.count()).toBe(5);

  await store.close();

  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE 'ocl_v5%' ORDER BY name",
      )
      .all()
      .map((row) => row.name),
  ).toStrictEqual(['ocl_v5_ids', 'ocl_v5_ids_id']);

  db.close();
});

test('an entries table the migration cannot walk, or a file without 5.x tables, is refused', async () => {
  const { db } = fiveFile();

  await expect(
    migrateFromV5(db, {
      entries: { ...ENTRIES, key: 'mf_molecular_weight' },
      threads: 1,
    }),
  ).rejects.toThrow("is not the table's INTEGER PRIMARY KEY");
  await expect(
    migrateFromV5(db, {
      entries: { ...ENTRIES, idCode: 'smiles' },
      threads: 1,
    }),
  ).rejects.toThrow('molecules has no column smiles');

  db.close();

  const plain = new DatabaseSync(':memory:');
  plain.exec('CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT)');

  await expect(
    migrateFromV5(plain, { entries: ENTRIES, threads: 1 }),
  ).rejects.toThrow('no table of openchemlib-sqlite 5.x');

  plain.close();
});
