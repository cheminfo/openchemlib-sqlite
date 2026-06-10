import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('search accepts a Molecule instance (exact)', async () => {
  const { db, molDB } = makeDB();
  const { idCode } = insertSmiles(db, molDB, 'c1ccccc1');
  const queryMol = OCL.Molecule.fromSmiles('c1ccccc1');

  const { results } = await molDB.search(queryMol, { mode: 'exact' });

  expect(results[0]?.idCode).toBe(idCode);
});

test('search accepts a Molecule instance (substructure) without mutating the original', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'c1ccccc1');
  insertSmiles(db, molDB, 'c1ccc(cc1)C(=O)O');
  const queryMol = OCL.Molecule.fromSmiles('c1ccccc1');
  const wasFragment = queryMol.isFragment();

  const { results } = await molDB.search(queryMol, { mode: 'substructure' });

  expect(results).toHaveLength(2);
  expect(queryMol.isFragment()).toBe(wasFragment);
});

test('insert accepts a Molecule instance', async () => {
  const { db, molDB } = makeDB();
  const mol = OCL.Molecule.fromSmiles('c1ccccc1');
  const idCode = mol.getIDCode();
  mol.stripStereoInformation();
  const idCodeNoStereo = mol.getIDCode();
  const result = db
    .prepare('INSERT INTO molecules (id_code, id_code_no_stereo) VALUES (?, ?)')
    .run(idCode, idCodeNoStereo) as { lastInsertRowid: number };
  molDB.insert(result.lastInsertRowid, mol);

  const { results } = await molDB.search('c1ccccc1', {
    mode: 'exact',
    format: 'smiles',
  });

  expect(results[0]?.idCode).toBe(idCode);
});

test('count starts at zero', async () => {
  const { molDB } = makeDB();

  expect(molDB.count()).toBe(0);
});

test('insert and count', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'Cn1c(=O)c2c(ncn2C)n(C)c1=O');

  expect(molDB.count()).toBe(1);
});

test('re-inserting the same entryId does not throw and keeps count at 1', async () => {
  const { db, molDB } = makeDB();
  const { entryId, idCode } = insertSmiles(db, molDB, 'c1ccccc1');
  molDB.insert(entryId, idCode);

  expect(molDB.count()).toBe(1);
});

test('exact search finds inserted molecule', async () => {
  const { db, molDB } = makeDB();
  const { idCode, entryId } = insertSmiles(
    db,
    molDB,
    'Cn1c(=O)c2c(ncn2C)n(C)c1=O',
  );

  const { results, total } = await molDB.search('Cn1c(=O)c2c(ncn2C)n(C)c1=O', {
    mode: 'exact',
    format: 'smiles',
  });

  expect(total).toBe(1);
  expect(results).toHaveLength(1);
  expect(results[0]?.idCode).toBe(idCode);
  expect(results[0]?.entryId).toBe(entryId);
});

test('exact search returns empty for non-matching molecule', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'c1ccccc1');

  const { results, total } = await molDB.search('CCO', {
    mode: 'exact',
    format: 'smiles',
  });

  expect(total).toBe(0);
  expect(results).toHaveLength(0);
});

test('exactNoStereo search ignores stereocenters', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'N[C@@H](C)C(=O)O');
  insertSmiles(db, molDB, 'N[C@H](C)C(=O)O');

  const { results, total } = await molDB.search('NC(C)C(=O)O', {
    mode: 'exactNoStereo',
    format: 'smiles',
  });

  expect(total).toBe(2);
  expect(results).toHaveLength(2);
});

test('exactNoStereo throws when column not configured', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, { entriesTable: 'molecules' });
  molDB.migrate();

  await expect(
    molDB.search('NC(C)C(=O)O', { mode: 'exactNoStereo', format: 'smiles' }),
  ).rejects.toThrow('exactNoStereo');
});

test('substructure search finds all molecules containing the fragment', async () => {
  const { db, molDB } = makeDB();
  const { idCode: benzeneId } = insertSmiles(db, molDB, 'c1ccccc1');
  const { idCode: benzoicAcidId } = insertSmiles(db, molDB, 'c1ccc(cc1)C(=O)O');
  insertSmiles(db, molDB, 'CCO');

  const { results } = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
  });

  expect(results.map((r) => r.idCode).toSorted()).toStrictEqual(
    [benzeneId, benzoicAcidId].toSorted(),
  );
});

test('similarity search returns results above threshold with similarity scores', async () => {
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

  const { results } = await molDB.search('Cn1c(=O)c2c(ncn2C)n(C)c1=O', {
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

test('pagination with from and limit', async () => {
  const { db, molDB } = makeDB();
  for (const smiles of ['c1ccccc1', 'c1ccc(cc1)C(=O)O', 'c1ccc(cc1)N']) {
    insertSmiles(db, molDB, smiles);
  }

  const { results, total } = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
    limit: 2,
    from: 0,
  });

  expect(total).toBe(3);
  expect(results).toHaveLength(2);
});

test('search parses idCode format', async () => {
  const { db, molDB } = makeDB();
  const { idCode } = insertSmiles(db, molDB, 'c1ccccc1');

  const { results } = await molDB.search(idCode, {
    mode: 'exact',
    format: 'idCode',
  });

  expect(results[0]?.idCode).toBe(idCode);
});

test('search parses molfile format', async () => {
  const { db, molDB } = makeDB();
  const { idCode } = insertSmiles(db, molDB, 'c1ccccc1');
  const mol = OCL.Molecule.fromSmiles('c1ccccc1');
  mol.inventCoordinates();
  const molfile = mol.toMolfile();

  const { results } = await molDB.search(molfile, {
    mode: 'exact',
    format: 'molfile',
  });

  expect(results[0]?.idCode).toBe(idCode);
});

test('search throws for unknown format', async () => {
  const { molDB } = makeDB();

  await expect(
    molDB.search('c1ccccc1', { mode: 'exact', format: 'unknown' as never }),
  ).rejects.toThrow('Unknown format');
});

test('search throws for unknown mode', async () => {
  const { molDB } = makeDB();

  await expect(
    molDB.search('c1ccccc1', { mode: 'unknown' as never }),
  ).rejects.toThrow('Unknown search mode');
});

test('search with fragment Molecule instance uses compact copy for exact mode', async () => {
  const { db, molDB } = makeDB();
  const { idCode } = insertSmiles(db, molDB, 'c1ccccc1');
  const queryMol = OCL.Molecule.fromSmiles('c1ccccc1');
  queryMol.setFragment(true);

  const { results } = await molDB.search(queryMol, { mode: 'exact' });

  expect(results[0]?.idCode).toBe(idCode);
  expect(queryMol.isFragment()).toBe(true);
});

test('search with Molecule instance for similarity mode', async () => {
  const { db, molDB } = makeDB();
  const { idCode: caffeineId } = insertSmiles(
    db,
    molDB,
    'Cn1c(=O)c2c(ncn2C)n(C)c1=O',
  );
  const queryMol = OCL.Molecule.fromSmiles('Cn1c(=O)c2c(ncn2C)n(C)c1=O');

  const { results } = await molDB.search(queryMol, {
    mode: 'similarity',
    similarityThreshold: 0.9,
  });

  expect(results[0]?.idCode).toBe(caffeineId);
  expect(queryMol.isFragment()).toBe(false);
});

test('search with Molecule instance for exactNoStereo mode', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'N[C@@H](C)C(=O)O');
  insertSmiles(db, molDB, 'N[C@H](C)C(=O)O');
  const queryMol = OCL.Molecule.fromSmiles('NC(C)C(=O)O');

  const { total } = await molDB.search(queryMol, { mode: 'exactNoStereo' });

  expect(total).toBe(2);
  expect(queryMol.isFragment()).toBe(false);
});

// ── empty-molecule optimization ────────────────────────────────────────────

test('substructure search with empty molecule returns all entries', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'c1ccccc1');
  insertSmiles(db, molDB, 'c1ccc(cc1)C(=O)O');
  insertSmiles(db, molDB, 'CCO');

  const emptyMol = new OCL.Molecule(0, 0);
  const { results, total, partial } = await molDB.search(emptyMol, {
    mode: 'substructure',
  });

  expect(total).toBe(3);
  expect(results).toHaveLength(3);
  expect(partial).toBe(false);
});

// ── sortByMassDifference ────────────────────────────────────────────────────

function makeDBWithMw() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE molecules (
      id                INTEGER PRIMARY KEY,
      id_code           TEXT NOT NULL UNIQUE,
      id_code_no_stereo TEXT NOT NULL,
      mw                REAL NOT NULL
    )
  `);
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    idCodeNoStereoColumn: 'id_code_no_stereo',
    mwColumn: 'mw',
  });
  molDB.migrate();
  return { db, molDB };
}

function insertSmilesWithMw(
  db: DatabaseSync,
  molDB: MoleculesDBSQLite,
  smiles: string,
): { entryId: number; idCode: string; mw: number } {
  const mol = OCL.Molecule.fromSmiles(smiles);
  const idCode = mol.getIDCode();
  const mw = mol.getMolecularFormula().relativeWeight;
  mol.stripStereoInformation();
  const idCodeNoStereo = mol.getIDCode();
  const result = db
    .prepare(
      'INSERT INTO molecules (id_code, id_code_no_stereo, mw) VALUES (?, ?, ?)',
    )
    .run(idCode, idCodeNoStereo, mw) as { lastInsertRowid: number };
  const entryId = result.lastInsertRowid;
  molDB.insert(entryId, idCode);
  return { entryId, idCode, mw };
}

test('sortByMassDifference puts closest-mass match first in substructure results', async () => {
  const { db, molDB } = makeDBWithMw();
  // benzene MW ~78, benzoic acid MW ~122, toluene MW ~92
  const { idCode: benzeneId, mw: benzeneMw } = insertSmilesWithMw(
    db,
    molDB,
    'c1ccccc1',
  );
  const { idCode: benzoicAcidId } = insertSmilesWithMw(
    db,
    molDB,
    'c1ccc(cc1)C(=O)O',
  );
  const { idCode: tolueneId } = insertSmilesWithMw(db, molDB, 'Cc1ccccc1');

  // Query is benzene — all three contain benzene ring; mwColumn is configured so results are sorted by mass diff
  const { results } = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
  });

  // Benzene (diff=0) must be first; mw field must be populated
  expect(results[0]?.idCode).toBe(benzeneId);
  expect(results[0]?.mw).toBeCloseTo(benzeneMw, 1);

  // Toluene (diff ~14) before benzoic acid (diff ~44)
  const toluenePos = results.findIndex((r) => r.idCode === tolueneId);
  const benzoicPos = results.findIndex((r) => r.idCode === benzoicAcidId);

  expect(toluenePos).toBeLessThan(benzoicPos);
});

test('sortByMassDifference does not mutate the query Molecule instance', async () => {
  const { db, molDB } = makeDBWithMw();
  insertSmilesWithMw(db, molDB, 'c1ccccc1');
  const queryMol = OCL.Molecule.fromSmiles('c1ccccc1');
  const wasFragment = queryMol.isFragment();

  await molDB.search(queryMol, { mode: 'substructure' });

  expect(queryMol.isFragment()).toBe(wasFragment);
});

// ── maxResults / maxCandidates early-exit options ─────────────────────────

test('maxResults stops after N matches and marks partial:true', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'c1ccccc1');
  insertSmiles(db, molDB, 'c1ccc(cc1)C(=O)O');
  insertSmiles(db, molDB, 'Cc1ccccc1');

  const { results, partial } = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
    maxResults: 1,
  });

  expect(results).toHaveLength(1);
  expect(partial).toBe(true);
});

test('substructure search reports progress and ends at processed === total', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'c1ccccc1');
  insertSmiles(db, molDB, 'Cc1ccccc1');
  insertSmiles(db, molDB, 'c1ccc(cc1)C(=O)O');

  const calls: Array<[number, number]> = [];
  const { screened } = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
    onProgress: (processed, total) => calls.push([processed, total]),
  });

  expect(calls.length).toBeGreaterThan(0);

  const last = calls.at(-1);

  expect(last?.[0]).toBe(screened);
  expect(last?.[0]).toBe(last?.[1]);
});

test('maxCandidates caps the fingerprint prefilter fetch and marks partial:true', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'c1ccccc1');
  insertSmiles(db, molDB, 'c1ccc(cc1)C(=O)O');
  insertSmiles(db, molDB, 'Cc1ccccc1');

  // All three pass the fingerprint prefilter for benzene; cap at 1 candidate.
  const { partial } = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
    maxCandidates: 1,
  });

  expect(partial).toBe(true);
});

test('maxResults stops the streaming scan early and marks partial:true', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'c1ccccc1');
  insertSmiles(db, molDB, 'Cc1ccccc1');
  insertSmiles(db, molDB, 'Oc1ccccc1');

  // Three benzene-containing molecules, but stop after the first two matches.
  const res = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
    maxResults: 2,
  });

  expect(res.results).toHaveLength(2);
  expect(res.matched).toBe(2);
  expect(res.partial).toBe(true);
});

test('substructure response reports matched, screened and elapsedMs', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'c1ccccc1');
  insertSmiles(db, molDB, 'CCO');

  const res = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
  });

  expect(res.matched).toBe(1); // only benzene contains the benzene fragment
  expect(res.screened).toBeGreaterThanOrEqual(1);
  expect(typeof res.elapsedMs).toBe('number');
  expect(res.results[0]?.idCode).toBe(
    OCL.Molecule.fromSmiles('c1ccccc1').getIDCode(),
  );
});

test('maxCandidates equal to candidate count does not falsely mark partial', async () => {
  const { db, molDB } = makeDB();
  insertSmiles(db, molDB, 'c1ccccc1');
  insertSmiles(db, molDB, 'CCO');

  // Only 1 molecule passes the fingerprint prefilter for CCO; maxCandidates=1 must not be a false positive.
  const { partial } = await molDB.search('CCO', {
    mode: 'substructure',
    format: 'smiles',
    maxCandidates: 1,
  });

  expect(partial).toBe(false);
});

test('entryId is a plain number (not BigInt) for substructure results', async () => {
  const { db, molDB } = makeDB();
  const { entryId } = insertSmiles(db, molDB, 'c1ccccc1');

  const { results } = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
  });

  expect(typeof results[0]?.entryId).toBe('number');
  expect(results[0]?.entryId).toBe(entryId);
});

test('entryId is a plain number (not BigInt) for similarity results', async () => {
  const { db, molDB } = makeDB();
  const { entryId } = insertSmiles(db, molDB, 'c1ccccc1');

  const { results } = await molDB.search('c1ccccc1', {
    mode: 'similarity',
    format: 'smiles',
    similarityThreshold: 0.9,
  });

  expect(typeof results[0]?.entryId).toBe('number');
  expect(results[0]?.entryId).toBe(entryId);
});

test('parallel substructure search across workers matches the sync result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocl-sqlite-pool-'));
  const dbPath = join(dir, 'mols.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE molecules (
      id                INTEGER PRIMARY KEY,
      id_code           TEXT NOT NULL UNIQUE,
      id_code_no_stereo TEXT NOT NULL,
      mw                REAL NOT NULL
    )
  `);
  const baseConfig = {
    entriesTable: 'molecules',
    idCodeNoStereoColumn: 'id_code_no_stereo',
    mwColumn: 'mw',
  };
  const indexer = new MoleculesDBSQLite(db, OCL, baseConfig);
  indexer.migrate();

  // Eight rows so a poolSize of 3 partitions them unevenly across workers.
  const smiles = [
    'c1ccccc1',
    'Cc1ccccc1',
    'Oc1ccccc1',
    'CCO',
    'c1ccc(cc1)C(=O)O',
    'C1CCCCC1',
    'c1ccncc1',
    'Cn1c(=O)c2c(ncn2C)n(C)c1=O',
  ];
  const insert = db.prepare(
    'INSERT INTO molecules (id_code, id_code_no_stereo, mw) VALUES (?, ?, ?)',
  );
  for (const smi of smiles) {
    const mol = OCL.Molecule.fromSmiles(smi);
    const idCode = mol.getIDCode();
    const mw = mol.getMolecularFormula().relativeWeight;
    mol.stripStereoInformation();
    const { lastInsertRowid } = insert.run(idCode, mol.getIDCode(), mw) as {
      lastInsertRowid: number;
    };
    indexer.insert(lastInsertRowid, idCode);
  }

  const sync = await indexer.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
  });

  // No dbPath here: it is derived from the connection (PRAGMA database_list).
  const parallel = new MoleculesDBSQLite(db, OCL, {
    ...baseConfig,
    poolSize: 3,
  });
  const progress: Array<[number, number]> = [];
  const result = await parallel.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
    onProgress: (processed, total) => progress.push([processed, total]),
  });
  await parallel.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });

  // Same matches and same mass-proximity ordering as the single-thread scan.
  expect(result.total).toBe(sync.total);
  expect(result.results.map((r) => r.entryId)).toStrictEqual(
    sync.results.map((r) => r.entryId),
  );
  expect(result.total).toBe(4);
  expect(progress.length).toBeGreaterThan(0);
});

test('packSSIndex and unpackSSIndex round-trip preserves bit pattern', async () => {
  const mol = OCL.Molecule.fromSmiles('c1ccccc1');
  const original = mol.getIndex().map((v) => v >>> 0);
  const packed = packSSIndex(original);
  const roundTripped = unpackSSIndex(
    Object.fromEntries(packed.map((v, i) => [`ss_index${i}`, v])),
  );

  expect(roundTripped).toStrictEqual(original);
});
