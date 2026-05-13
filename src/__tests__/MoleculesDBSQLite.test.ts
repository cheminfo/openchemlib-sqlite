import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import { packSSIndex, unpackSSIndex } from '../utils/packSSIndex.ts';

function makeDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE molecules (
      id                INTEGER PRIMARY KEY,
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

function insertSmiles(
  db: DatabaseSync,
  molDB: MoleculesDBSQLite,
  smiles: string,
): { entryId: number; idCode: string } {
  const mol = OCL.Molecule.fromSmiles(smiles);
  const idCode = mol.getIDCode();
  mol.stripStereoInformation();
  const idCodeNoStereo = mol.getIDCode();
  const result = db
    .prepare('INSERT INTO molecules (id_code, id_code_no_stereo) VALUES (?, ?)')
    .run(idCode, idCodeNoStereo) as { lastInsertRowid: number };
  const entryId = result.lastInsertRowid;
  molDB.insert(entryId, idCode);
  return { entryId, idCode };
}

test('search accepts a Molecule instance (exact)', () => {
  const { db, molDB } = makeDB();
  const { idCode } = insertSmiles(db, molDB, 'c1ccccc1');
  const queryMol = OCL.Molecule.fromSmiles('c1ccccc1');

  const { results } = molDB.search(queryMol, { mode: 'exact' });

  expect(results[0]?.idCode).toBe(idCode);
});

test('search accepts a Molecule instance (substructure) without mutating the original', () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'c1ccccc1');
  insertSmiles(db, molDB, 'c1ccc(cc1)C(=O)O');
  const queryMol = OCL.Molecule.fromSmiles('c1ccccc1');
  const wasFragment = queryMol.isFragment();

  const { results } = molDB.search(queryMol, { mode: 'substructure' });

  expect(results).toHaveLength(2);
  expect(queryMol.isFragment()).toBe(wasFragment);
});

test('insert accepts a Molecule instance', () => {
  const { db, molDB } = makeDB();
  const mol = OCL.Molecule.fromSmiles('c1ccccc1');
  const idCode = mol.getIDCode();
  mol.stripStereoInformation();
  const idCodeNoStereo = mol.getIDCode();
  const result = db
    .prepare('INSERT INTO molecules (id_code, id_code_no_stereo) VALUES (?, ?)')
    .run(idCode, idCodeNoStereo) as { lastInsertRowid: number };
  molDB.insert(result.lastInsertRowid, mol);

  const { results } = molDB.search('c1ccccc1', {
    mode: 'exact',
    format: 'smiles',
  });

  expect(results[0]?.idCode).toBe(idCode);
});

test('count starts at zero', () => {
  const { molDB } = makeDB();

  expect(molDB.count()).toBe(0);
});

test('insert and count', () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'Cn1c(=O)c2c(ncn2C)n(C)c1=O');

  expect(molDB.count()).toBe(1);
});

test('re-inserting the same entryId does not throw and keeps count at 1', () => {
  const { db, molDB } = makeDB();
  const { entryId, idCode } = insertSmiles(db, molDB, 'c1ccccc1');
  molDB.insert(entryId, idCode);

  expect(molDB.count()).toBe(1);
});

test('exact search finds inserted molecule', () => {
  const { db, molDB } = makeDB();
  const { idCode, entryId } = insertSmiles(
    db,
    molDB,
    'Cn1c(=O)c2c(ncn2C)n(C)c1=O',
  );

  const { results, total } = molDB.search('Cn1c(=O)c2c(ncn2C)n(C)c1=O', {
    mode: 'exact',
    format: 'smiles',
  });

  expect(total).toBe(1);
  expect(results).toHaveLength(1);
  expect(results[0]?.idCode).toBe(idCode);
  expect(results[0]?.entryId).toBe(entryId);
});

test('exact search returns empty for non-matching molecule', () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'c1ccccc1');

  const { results, total } = molDB.search('CCO', {
    mode: 'exact',
    format: 'smiles',
  });

  expect(total).toBe(0);
  expect(results).toHaveLength(0);
});

test('exactNoStereo search ignores stereocenters', () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'N[C@@H](C)C(=O)O');
  insertSmiles(db, molDB, 'N[C@H](C)C(=O)O');

  const { results, total } = molDB.search('NC(C)C(=O)O', {
    mode: 'exactNoStereo',
    format: 'smiles',
  });

  expect(total).toBe(2);
  expect(results).toHaveLength(2);
});

test('exactNoStereo throws when column not configured', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, { entriesTable: 'molecules' });
  molDB.migrate();

  expect(() =>
    molDB.search('NC(C)C(=O)O', { mode: 'exactNoStereo', format: 'smiles' }),
  ).toThrow('exactNoStereo');
});

test('substructure search finds all molecules containing the fragment', () => {
  const { db, molDB } = makeDB();
  const { idCode: benzeneId } = insertSmiles(db, molDB, 'c1ccccc1');
  const { idCode: benzoicAcidId } = insertSmiles(db, molDB, 'c1ccc(cc1)C(=O)O');
  insertSmiles(db, molDB, 'CCO');

  const { results } = molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
  });

  expect(results.map((r) => r.idCode).toSorted()).toStrictEqual(
    [benzeneId, benzoicAcidId].toSorted(),
  );
});

test('similarity search returns results above threshold with similarity scores', () => {
  const { db, molDB } = makeDB();
  const { idCode: caffeineId } = insertSmiles(
    db,
    molDB,
    'Cn1c(=O)c2c(ncn2C)n(C)c1=O',
  );
  const { idCode: theophyllineId } = insertSmiles(
    db,
    molDB,
    'Cn1cnc2c1c(=O)[nH]c(=O)n2C',
  );
  insertSmiles(db, molDB, 'CCO');

  const { results } = molDB.search('Cn1c(=O)c2c(ncn2C)n(C)c1=O', {
    mode: 'similarity',
    format: 'smiles',
    similarityThreshold: 0.3,
  });

  const idCodes = results.map((r) => r.idCode);

  expect(idCodes).toContain(caffeineId);
  expect(idCodes).toContain(theophyllineId);

  for (let i = 1; i < results.length; i++) {
    expect(results[i - 1]?.similarity).toBeGreaterThanOrEqual(
      results[i]?.similarity ?? 0,
    );
  }
});

test('pagination with from and limit', () => {
  const { db, molDB } = makeDB();
  for (const smiles of ['c1ccccc1', 'c1ccc(cc1)C(=O)O', 'c1ccc(cc1)N']) {
    insertSmiles(db, molDB, smiles);
  }

  const { results, total } = molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
    limit: 2,
    from: 0,
  });

  expect(total).toBe(3);
  expect(results).toHaveLength(2);
});

test('search parses idCode format', () => {
  const { db, molDB } = makeDB();
  const { idCode } = insertSmiles(db, molDB, 'c1ccccc1');

  const { results } = molDB.search(idCode, { mode: 'exact', format: 'idCode' });

  expect(results[0]?.idCode).toBe(idCode);
});

test('search parses molfile format', () => {
  const { db, molDB } = makeDB();
  const { idCode } = insertSmiles(db, molDB, 'c1ccccc1');
  const mol = OCL.Molecule.fromSmiles('c1ccccc1');
  mol.inventCoordinates();
  const molfile = mol.toMolfile();

  const { results } = molDB.search(molfile, {
    mode: 'exact',
    format: 'molfile',
  });

  expect(results[0]?.idCode).toBe(idCode);
});

test('search throws for unknown format', () => {
  const { molDB } = makeDB();

  expect(() =>
    molDB.search('c1ccccc1', { mode: 'exact', format: 'unknown' as never }),
  ).toThrow('Unknown format');
});

test('search throws for unknown mode', () => {
  const { molDB } = makeDB();

  expect(() => molDB.search('c1ccccc1', { mode: 'unknown' as never })).toThrow(
    'Unknown search mode',
  );
});

test('search with fragment Molecule instance uses compact copy for exact mode', () => {
  const { db, molDB } = makeDB();
  const { idCode } = insertSmiles(db, molDB, 'c1ccccc1');
  const queryMol = OCL.Molecule.fromSmiles('c1ccccc1');
  queryMol.setFragment(true);

  const { results } = molDB.search(queryMol, { mode: 'exact' });

  expect(results[0]?.idCode).toBe(idCode);
  expect(queryMol.isFragment()).toBe(true);
});

test('search with Molecule instance for similarity mode', () => {
  const { db, molDB } = makeDB();
  const { idCode: caffeineId } = insertSmiles(
    db,
    molDB,
    'Cn1c(=O)c2c(ncn2C)n(C)c1=O',
  );
  const queryMol = OCL.Molecule.fromSmiles('Cn1c(=O)c2c(ncn2C)n(C)c1=O');

  const { results } = molDB.search(queryMol, {
    mode: 'similarity',
    similarityThreshold: 0.9,
  });

  expect(results[0]?.idCode).toBe(caffeineId);
  expect(queryMol.isFragment()).toBe(false);
});

test('search with Molecule instance for exactNoStereo mode', () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'N[C@@H](C)C(=O)O');
  insertSmiles(db, molDB, 'N[C@H](C)C(=O)O');
  const queryMol = OCL.Molecule.fromSmiles('NC(C)C(=O)O');

  const { total } = molDB.search(queryMol, { mode: 'exactNoStereo' });

  expect(total).toBe(2);
  expect(queryMol.isFragment()).toBe(false);
});

test('packSSIndex and unpackSSIndex round-trip preserves bit pattern', () => {
  const mol = OCL.Molecule.fromSmiles('c1ccccc1');
  const original = mol.getIndex().map((v) => v >>> 0);
  const packed = packSSIndex(original);
  const roundTripped = unpackSSIndex(
    Object.fromEntries(packed.map((v, i) => [`ss_index${i}`, v])),
  );

  expect(roundTripped).toStrictEqual(original);
});
