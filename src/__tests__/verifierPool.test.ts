import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import { buildPrescreenSql } from '../utils/prescreen.ts';

/**
 * Twenty-one benzene homologues inserted HEAVIEST FIRST, so entry_id order is
 * the exact opposite of molecular-weight order. Every one of them contains
 * benzene, so a benzene scan screens all of them and only the scan's ordering
 * decides which survive an early stop.
 * @param options - Config overrides selecting an execution path.
 * @param options.poolSize - Verifier threads; 1 keeps everything inline.
 * @param options.batchSize - Candidates per batch; small values force dispatch.
 * @returns The molecules db and the homologues sorted by ascending mw.
 */
function seedHomologues(
  options: { poolSize?: number; batchSize?: number } = {},
) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, name TEXT NOT NULL, id_code TEXT NOT NULL UNIQUE)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    searchCacheSize: 0,
    ...options,
  });
  molDB.migrate();
  const insert = db.prepare(
    'INSERT INTO molecules (name, id_code) VALUES (?, ?) RETURNING id',
  );
  const homologues: Array<{ mw: number; idCode: string }> = [];
  for (let n = 20; n >= 0; n--) {
    const mol = OCL.Molecule.fromSmiles(`${'C'.repeat(n)}c1ccccc1`);
    const idCode = mol.getIDCode();
    const { id } = insert.get(`chain${n}`, idCode) as { id: number };
    molDB.insert(id, idCode);
    homologues.push({ mw: mol.getMolecularFormula().relativeWeight, idCode });
  }
  return { db, molDB, sorted: homologues.toSorted((a, b) => a.mw - b.mw) };
}

const ALL = {
  sql: 'SELECT id AS entry_id FROM molecules WHERE name LIKE :name',
  params: { name: 'chain%' },
};

test('an early-stopped scan keeps the lightest matches, not the first inserted', async () => {
  const { molDB, sorted } = seedHomologues();

  const { results, partial } = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    maxResults: 5,
  });

  expect(partial).toBe(true);
  expect(results.map((r) => r.idCode)).toStrictEqual(
    sorted.slice(0, 5).map((m) => m.idCode),
  );
});

test('candidates do not change which matches an early stop keeps', async () => {
  const { molDB, sorted } = seedHomologues();

  // The subquery matches every row, so this must agree with the unrestricted
  // search above: restricting the scan must not reorder it.
  const { results } = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    maxResults: 5,
    candidates: ALL,
  });

  expect(results.map((r) => r.idCode)).toStrictEqual(
    sorted.slice(0, 5).map((m) => m.idCode),
  );
});

test('the verifier pool returns the same lightest matches as the inline path', async () => {
  // batchSize 2 forces dispatch to real worker threads; poolSize 3 so batches
  // land out of order and the merge has to restore ascending mw.
  const { molDB, sorted } = seedHomologues({ poolSize: 3, batchSize: 2 });

  const { results, partial } = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    maxResults: 5,
  });
  await molDB.close();

  expect(partial).toBe(true);
  expect(results.map((r) => r.idCode)).toStrictEqual(
    sorted.slice(0, 5).map((m) => m.idCode),
  );
});

test('the verifier pool and the inline path agree on a full scan', async () => {
  const inline = seedHomologues({ poolSize: 1 });
  const pooled = seedHomologues({ poolSize: 3, batchSize: 2 });

  const a = await inline.molDB.search('c1ccccc1', { mode: 'substructure' });
  const b = await pooled.molDB.search('c1ccccc1', { mode: 'substructure' });
  await pooled.molDB.close();

  expect(a.total).toBe(21);
  expect(b.results.map((r) => r.entryId)).toStrictEqual(
    a.results.map((r) => r.entryId),
  );
  expect(b.screened).toBe(a.screened);
});

test('candidates restrict the scan and are honoured by the pool', async () => {
  const { db, molDB } = seedHomologues({ poolSize: 3, batchSize: 2 });
  db.prepare("UPDATE molecules SET name = 'drop' WHERE id > 3").run();

  const { results } = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    candidates: ALL,
  });
  await molDB.close();

  expect(results).toHaveLength(3);
});

test('an early stop stops consuming the scan', async () => {
  const { molDB } = seedHomologues({ poolSize: 1 });

  const full = await molDB.search('c1ccccc1', { mode: 'substructure' });
  const stopped = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    maxResults: 3,
  });

  // All 21 contain benzene, so a scan that ran to completion would screen 21.
  expect(full.screened).toBe(21);
  expect(stopped.screened).toBe(3);
});

// `screened` above only proves the JS loop stopped pulling; it would read 3 even
// if SQLite had already materialised and sorted every row behind the cursor. The
// plan is what actually pins the design: ocl_ss_index must drive the scan, so its
// physical (mw, entry_id) order IS the output order and no sort is needed.
test('the prescreen scans the mw-clustered index and never sorts', () => {
  const { db } = seedHomologues();
  const mol = OCL.Molecule.fromSmiles('c1ccccc1');
  mol.setFragment(true);
  const base = {
    entriesTable: 'molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    mol,
  };

  for (const candidates of [undefined, ALL]) {
    const query = buildPrescreenSql({ ...base, candidates });
    const statement = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`);
    const plan = statement.all(
      ...(query.params as Parameters<typeof statement.all>),
    ) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join('\n');

    // ocl_ss_index (aliased s) is scanned in primary-key order...
    expect(detail).toContain('SCAN s');
    // ...so the result is already lightest-first and nothing is sorted or
    // materialised ahead of the cursor.
    expect(detail).not.toContain('TEMP B-TREE');
  }
});

test('exact search on an idCode matches without re-encoding the query', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, { entriesTable: 'molecules' });
  molDB.migrate();

  // A stereo-bearing molecule: parsing its idCode without inventing coordinates
  // drops the stereo descriptors, so re-encoding it would NOT reproduce the
  // stored string. Matching the idCode as a plain string sidesteps that.
  const idCode = OCL.Molecule.fromSmiles('N[C@@H](C)C(=O)O').getIDCode();
  db.prepare('INSERT INTO molecules (id_code) VALUES (?)').run(idCode);
  molDB.insert(1, idCode);

  const { results, total } = await molDB.search(idCode, {
    mode: 'exact',
    format: 'idCode',
  });

  expect(total).toBe(1);
  expect(results[0]?.idCode).toBe(idCode);
});
