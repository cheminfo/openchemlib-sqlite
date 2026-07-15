import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';

/**
 * An entries table with a `name` column, so a candidates subquery has an
 * attribute to filter on the way a real caller would.
 * @returns The connection and the molecules DB wrapping it.
 */
function makeDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE molecules (
      id                INTEGER PRIMARY KEY,
      name              TEXT NOT NULL,
      id_code           TEXT NOT NULL UNIQUE,
      id_code_no_stereo TEXT NOT NULL
    )
  `);
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    idCodeNoStereoColumn: 'id_code_no_stereo',
  });
  molDB.migrate();
  return { db, molDB };
}

function insert(
  db: DatabaseSync,
  molDB: MoleculesDBSQLite,
  name: string,
  smiles: string,
): number {
  const mol = OCL.Molecule.fromSmiles(smiles);
  const idCode = mol.getIDCode();
  mol.stripStereoInformation();
  const result = db
    .prepare(
      'INSERT INTO molecules (name, id_code, id_code_no_stereo) VALUES (?, ?, ?)',
    )
    .run(name, idCode, mol.getIDCode()) as { lastInsertRowid: number };
  molDB.insert(result.lastInsertRowid, idCode);
  return result.lastInsertRowid;
}

/**
 * Three benzene-containing molecules; only two are named "keep".
 * @returns The database, the molecules DB and the entry ids.
 */
function seed() {
  const { db, molDB } = makeDB();
  const toluene = insert(db, molDB, 'keep toluene', 'Cc1ccccc1');
  const phenol = insert(db, molDB, 'keep phenol', 'Oc1ccccc1');
  const aniline = insert(db, molDB, 'drop aniline', 'Nc1ccccc1');
  return { db, molDB, toluene, phenol, aniline };
}

const byId = (a: number, b: number) => a - b;

const KEEP = {
  sql: 'SELECT id AS entry_id FROM molecules WHERE name LIKE :name',
  params: { name: 'keep%' },
};

test('substructure: candidates restrict the scan to the subquery', async () => {
  const { molDB, toluene, phenol, aniline } = seed();

  const all = await molDB.search('c1ccccc1', { mode: 'substructure' });

  expect(all.results.map((r) => r.entryId).toSorted(byId)).toStrictEqual([
    toluene,
    phenol,
    aniline,
  ]);
  expect(all.total).toBe(3);

  const restricted = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    candidates: KEEP,
  });

  expect(restricted.results.map((r) => r.entryId).toSorted(byId)).toStrictEqual(
    [toluene, phenol],
  );
  expect(restricted.total).toBe(2);
  // The excluded molecule was never parsed or matched, not merely filtered out.
  expect(restricted.screened).toBe(2);
});

test('substructure: candidates matching nothing yield no results', async () => {
  const { molDB } = seed();
  const response = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    candidates: {
      sql: 'SELECT id AS entry_id FROM molecules WHERE name = :name',
      params: { name: 'absent' },
    },
  });

  expect(response.results).toStrictEqual([]);
  expect(response.total).toBe(0);
  expect(response.screened).toBe(0);
});

test('similarity: candidates restrict the scan', async () => {
  const { molDB, toluene, phenol } = seed();
  const response = await molDB.search('c1ccccc1', {
    mode: 'similarity',
    similarityThreshold: 0,
    candidates: KEEP,
  });

  expect(response.results.map((r) => r.entryId).toSorted(byId)).toStrictEqual([
    toluene,
    phenol,
  ]);
  expect(response.total).toBe(2);
});

test('exact: candidates restrict the match', async () => {
  const { molDB, aniline } = seed();

  const found = await molDB.search('Nc1ccccc1', { mode: 'exact' });

  expect(found.results.map((r) => r.entryId)).toStrictEqual([aniline]);

  // The same molecule is excluded by the subquery.
  const excluded = await molDB.search('Nc1ccccc1', {
    mode: 'exact',
    candidates: KEEP,
  });

  expect(excluded.results).toStrictEqual([]);
  expect(excluded.total).toBe(0);
});

test('exactNoStereo: candidates restrict the match', async () => {
  const { molDB, aniline } = seed();

  const found = await molDB.search('Nc1ccccc1', { mode: 'exactNoStereo' });

  expect(found.results.map((r) => r.entryId)).toStrictEqual([aniline]);

  const excluded = await molDB.search('Nc1ccccc1', {
    mode: 'exactNoStereo',
    candidates: KEEP,
  });

  expect(excluded.results).toStrictEqual([]);
});

test('the search cache never serves one candidate set to another', async () => {
  const { molDB, toluene, phenol, aniline } = seed();

  // Unrestricted first, so an unkeyed cache would hand these three back.
  const all = await molDB.search('c1ccccc1', { mode: 'substructure' });

  expect(all.total).toBe(3);

  const restricted = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    candidates: KEEP,
  });

  expect(restricted.total).toBe(2);

  // A different bound value is a different subset, not a cache hit.
  const other = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    candidates: { ...KEEP, params: { name: 'drop%' } },
  });

  expect(other.results.map((r) => r.entryId)).toStrictEqual([aniline]);

  // ...and back, to prove the restricted entry is still keyed correctly.
  const again = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    candidates: KEEP,
  });

  expect(again.results.map((r) => r.entryId).toSorted(byId)).toStrictEqual([
    toluene,
    phenol,
  ]);
});

test('similarity: the cache is keyed by candidates too', async () => {
  const { molDB, aniline } = seed();
  const options = { mode: 'similarity', similarityThreshold: 0 } as const;

  const all = await molDB.search('c1ccccc1', options);

  expect(all.total).toBe(3);

  const kept = await molDB.search('c1ccccc1', { ...options, candidates: KEEP });

  expect(kept.total).toBe(2);

  const dropped = await molDB.search('c1ccccc1', {
    ...options,
    candidates: { ...KEEP, params: { name: 'drop%' } },
  });

  expect(dropped.results.map((r) => r.entryId)).toStrictEqual([aniline]);
});

test('candidates work without bound parameters', async () => {
  const { molDB, aniline } = seed();
  const response = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    candidates: {
      sql: "SELECT id AS entry_id FROM molecules WHERE name LIKE 'drop%'",
    },
  });

  expect(response.results.map((r) => r.entryId)).toStrictEqual([aniline]);
});
