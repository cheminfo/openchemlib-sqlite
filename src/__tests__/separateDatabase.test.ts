import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterEach, expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import { referencesEntries } from '../schema.ts';

const BENZENE = 'gFp@DiTt@@B';
const FORMIC = 'eMDARVB';
const NAPHTHALENE = 'det@@DjYUX^d@@@@B';

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

/**
 * An entries database in one file and the index in another, attached as `mol`.
 * @returns The index connection and the configured instance.
 */
function twoFiles() {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-'));
  const entriesFile = join(directory, 'entries.sqlite');

  const entries = new DatabaseSync(entriesFile);
  entries.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT, mw REAL)',
  );
  const insert = entries.prepare(
    'INSERT INTO molecules (id_code, mw) VALUES (?, ?)',
  );
  for (const [idCode, mw] of [
    [BENZENE, 78.11],
    [FORMIC, 46.03],
    [NAPHTHALENE, 128.17],
  ] as const) {
    insert.run(idCode, mw);
  }
  entries.close();

  const index = new DatabaseSync(join(directory, 'index.sqlite'));
  index.exec(`ATTACH DATABASE '${entriesFile}' AS mol`);
  const molDB = new MoleculesDBSQLite(index, OCL, {
    entriesTable: 'mol.molecules',
    mwColumn: 'mw',
    trustMwColumn: true,
    poolSize: 1,
    searchCacheSize: 0,
  });
  molDB.migrate();
  return { index, molDB };
}

/**
 * Index every entry of the attached database.
 *
 * The column is aliased in SQL rather than named in a type: the entries table is
 * the caller's, and its snake_case names are not this library's convention.
 * @param index - The index connection, with the entries database attached.
 * @param molDB - The configured instance.
 */
function indexEveryEntry(index: DatabaseSync, molDB: MoleculesDBSQLite): void {
  const entries = index
    .prepare('SELECT id, id_code AS idCode FROM mol.molecules')
    .all() as Array<{ id: number; idCode: string }>;
  for (const entry of entries) molDB.insert(entry.id, entry.idCode);
}

test('a qualified entries table drops the foreign key, an unqualified one keeps it', () => {
  // SQLite has no syntax for `REFERENCES other.t(id)`, and a foreign key may not
  // span databases at all, so the clause is the one thing that cannot survive.
  expect(referencesEntries({ entriesTable: 'molecules', pkColumn: 'id' })).toBe(
    ' REFERENCES molecules(id)',
  );
  expect(
    referencesEntries({ entriesTable: 'mol.molecules', pkColumn: 'id' }),
  ).toBe('');
});

test('the index tables are created in the index database, not the entries one', () => {
  const { index } = twoFiles();

  const names = (schema: string) =>
    index
      .prepare(
        `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all()
      .map((row) => (row as { name: string }).name);

  expect(names('main')).toContain('ocl_ss_index');
  expect(names('main')).toContain('ocl_no_stereo_hash');
  // The entries database is left exactly as the caller built it.
  expect(names('mol')).toStrictEqual(['molecules']);
});

test('substructure search works across the attachment', async () => {
  const { index, molDB } = twoFiles();
  indexEveryEntry(index, molDB);

  const response = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
  });

  expect(
    response.results.map((result) => result.idCode).toSorted(),
  ).toStrictEqual([BENZENE, NAPHTHALENE].toSorted());
});

test('the hashes and their searches work across the attachment', async () => {
  const { molDB, index } = twoFiles();
  indexEveryEntry(index, molDB);

  const result = await molDB.backfillHashes({ poolSize: 1 });

  expect(result.hashed).toBe(6);

  const noStereo = await molDB.search(BENZENE, {
    mode: 'exactNoStereo',
    format: 'idCode',
  });

  expect(noStereo.results.map((entry) => entry.idCode)).toStrictEqual([
    BENZENE,
  ]);
});
