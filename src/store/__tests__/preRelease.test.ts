import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterAll, expect, test } from 'vitest';

import {
  SPEC,
  readIdCodes,
  testThreads,
} from '../../__tests__/testDatabase.ts';
import { MoleculeIndex } from '../../search/MoleculeIndex.ts';
import { MoleculeStore } from '../MoleculeStore.ts';
import { PRE_RELEASE_FILE } from '../metaChecks.ts';

import { StoreFiles, setMeta } from './rebuildFixtures.ts';

const files = new StoreFiles('ocl-sqlite-prerelease-');

afterAll(() => files.close());

/**
 * A file as a pre-release 6.0 build left it: no function-key signature, and 4,292-byte tiles.
 * @param name - The file's name.
 * @returns Its connection.
 */
async function preReleaseFile(name: string): Promise<DatabaseSync> {
  const { db, store } = await files.storeWith(name, readIdCodes().slice(0, 40));
  await store.close();
  db.exec("DELETE FROM ocl_meta WHERE name = 'signature.functions'");
  db.exec('UPDATE ocl_tile SET data = substr(data, 1, 4292)');
  return db;
}

test('a file of a pre-release 6.0 build is refused by the store, the index and a rebuild', async () => {
  const db = await preReleaseFile('functions');
  const file = join(files.directory, 'functions.sqlite');

  await expect(
    MoleculeStore.open(db, { threads: testThreads(1) }),
  ).rejects.toThrow(PRE_RELEASE_FILE);
  await expect(
    MoleculeIndex.open(file, SPEC, { threads: testThreads(1) }),
  ).rejects.toThrow(PRE_RELEASE_FILE);
  await expect(
    MoleculeStore.rebuild(db, { threads: testThreads(1) }),
  ).rejects.toThrow(PRE_RELEASE_FILE);
  await expect(MoleculeStore.updates(db)).resolves.toStrictEqual({
    identity: true,
    tiles: [],
    counts: [],
    idCodeHash: false,
    rebuilding: false,
  });
});

test('a file written before the library kept signatures is refused the same way', async () => {
  const db = await preReleaseFile('signatures');
  db.exec("DELETE FROM ocl_meta WHERE substr(name, 1, 10) = 'signature.'");

  await expect(
    MoleculeStore.open(db, { threads: testThreads(1) }),
  ).rejects.toThrow(PRE_RELEASE_FILE);
  await expect(
    MoleculeIndex.open(join(files.directory, 'signatures.sqlite'), SPEC, {
      threads: testThreads(1),
    }),
  ).rejects.toThrow(PRE_RELEASE_FILE);
});

test('a file of another format keeps its own message', async () => {
  const db = await preReleaseFile('format');
  setMeta(db, 'format', 'openchemlib-sqlite 7');
  const message =
    'ocl_meta.format is "openchemlib-sqlite 7", this build reads "openchemlib-sqlite 6": the file must be migrated';

  await expect(
    MoleculeStore.open(db, { threads: testThreads(1) }),
  ).rejects.toThrow(message);
  await expect(
    MoleculeIndex.open(join(files.directory, 'format.sqlite'), SPEC, {
      threads: testThreads(1),
    }),
  ).rejects.toThrow(message);
});
