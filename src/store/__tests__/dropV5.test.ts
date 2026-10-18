import { afterEach, expect, test } from 'vitest';

import { MoleculeStore } from '../MoleculeStore.ts';
import { compactDatabase, dropV5Tables } from '../dropV5.ts';
import { migrateFromV5 } from '../migrateV5.ts';

import { ENTRIES, THREADS, fiveFile, removeFiveFiles } from './v5Fixture.ts';

afterEach(removeFiveFiles);

test('once migrated, the 5.x tables are dropped and the file compacted', async () => {
  const { db } = fiveFile();

  await expect(dropV5Tables(db)).rejects.toThrow('not migrated from 5.x');

  await migrateFromV5(db, { entries: ENTRIES, threads: THREADS, finish: true });

  await expect(
    migrateFromV5(db, { entries: ENTRIES, threads: THREADS }),
  ).resolves.toStrictEqual({
    entries: 0,
    created: 0,
    failed: 0,
    pending: 0,
    migrated: true,
  });
  await expect(dropV5Tables(db)).resolves.toStrictEqual({
    tables: [
      'ocl_ss_schema',
      'ocl_ss_index',
      'ocl_no_stereo_hash',
      'ocl_no_stereo_tautomer_hash',
      'ocl_ss_settings',
      'ocl_ss_plane',
      'ocl_ss_slot',
      'ocl_ss_bitstat',
      'ocl_ss_segment',
      'ocl_ss_fold',
      'ocl_ss_columns',
      'ocl_v5_ids',
    ],
  });
  expect(
    db
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE name LIKE 'ocl_ss%' OR name LIKE 'ocl_no_stereo%' OR name LIKE 'ocl_v5%' OR type = 'trigger'",
      )
      .all(),
  ).toStrictEqual([]);
  expect(
    db.prepare("SELECT name FROM ocl_meta WHERE name LIKE 'v5.%'").all(),
  ).toStrictEqual([]);

  const { before, after } = compactDatabase(db);

  expect(after).toBeLessThan(before);
  expect({
    ...db
      .prepare('SELECT freelist_count AS free FROM pragma_freelist_count()')
      .get(),
  }).toStrictEqual({ free: 0 });

  const store = await MoleculeStore.open(db, { threads: 1 });

  expect(store.count()).toBe(6);

  await store.close();
  db.close();
});
