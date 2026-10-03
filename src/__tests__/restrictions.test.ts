import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import type { CandidateStrategy } from '../types.ts';
import { buildPrescreenSql } from '../utils/prescreen.ts';
import { installScanDeadline, isScanDeadline } from '../utils/scanDeadline.ts';

/** Benzene homologues, lightest first: 92.14, 106.17, 120.19, 134.22, 148.25. */
const HOMOLOGUES = [
  'Cc1ccccc1',
  'CCc1ccccc1',
  'CCCc1ccccc1',
  'CCCCc1ccccc1',
  'CCCCCc1ccccc1',
];

/**
 * The homologues, named `even` and `odd` by position so a subquery has an
 * attribute to select on.
 * @param entryIds - The id each homologue is stored under.
 * @returns The connection, the molecules DB and the ids, lightest first.
 */
function seed(entryIds = [1, 2, 3, 4, 5]) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, name TEXT NOT NULL, id_code TEXT NOT NULL UNIQUE)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 1,
  });
  molDB.migrate();
  const insert = db.prepare(
    'INSERT INTO molecules (id, name, id_code) VALUES (?, ?, ?)',
  );
  for (const [position, smiles] of HOMOLOGUES.entries()) {
    const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
    const id = entryIds[position] ?? 0;
    insert.run(id, position % 2 === 0 ? 'even' : 'odd', idCode);
    molDB.insert(id, idCode);
  }
  return { db, molDB, ids: entryIds };
}

const EVEN = {
  sql: 'SELECT id AS entry_id FROM molecules WHERE name = :name',
  params: { name: 'even' },
};

const STRATEGIES: CandidateStrategy[] = ['membership', 'probe', 'drive'];

const byId = (a: number, b: number) => a - b;

/**
 * The plan SQLite picks for a prescreen.
 * @param db - The database to plan against.
 * @param options - What the prescreen is restricted by.
 * @returns The plan's steps, one per line.
 */
function planOf(
  db: DatabaseSync,
  options: Partial<Parameters<typeof buildPrescreenSql>[0]>,
): string {
  const mol = OCL.Molecule.fromSmiles('c1ccccc1');
  mol.setFragment(true);
  const query = buildPrescreenSql({
    entriesTable: 'molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    mol,
    ...options,
  });
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .all(...(query.params as never[])) as Array<{ detail: string }>;
  return plan.map((row) => row.detail).join('\n');
}

test('mwRange keeps the matches within the range, in every mode', async () => {
  const { molDB, ids } = seed();
  const mwRange = { min: 100, max: 140 };

  const substructure = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    mwRange,
  });

  expect(substructure.results.map((r) => r.entryId)).toStrictEqual(
    ids.slice(1, 4),
  );

  const similar = await molDB.search('c1ccccc1', {
    mode: 'similarity',
    similarityThreshold: 0,
    mwRange,
  });

  expect(similar.results.map((r) => r.entryId).toSorted(byId)).toStrictEqual(
    ids.slice(1, 4),
  );

  const exact = await molDB.search('CCc1ccccc1', {
    mode: 'exact',
    mwRange: { max: 110 },
  });

  expect(exact.results.map((r) => r.entryId)).toStrictEqual([ids[1]]);

  const outside = await molDB.search('CCc1ccccc1', {
    mode: 'exact',
    mwRange: { min: 110 },
  });

  expect(outside.total).toBe(0);

  await molDB.backfillHashes();
  const noStereo = await molDB.search('CCc1ccccc1', {
    mode: 'exactNoStereo',
    mwRange: { min: 110 },
  });

  expect(noStereo.total).toBe(0);
});

test('mwRange is a seek on both ends of the clustered key', () => {
  const { db } = seed();
  const plan = planOf(db, { mwRange: { min: 100, max: 140 } });

  expect(plan).toContain('SEARCH s USING PRIMARY KEY (mw>? AND mw<?)');
});

test.each(STRATEGIES)(
  '%s keeps the same entries as every strategy, lightest first',
  async (strategy) => {
    const { molDB, ids } = seed();
    const candidates = { ...EVEN, strategy };

    const substructure = await molDB.search('c1ccccc1', {
      mode: 'substructure',
      candidates,
    });

    expect(substructure.results.map((r) => r.entryId)).toStrictEqual([
      ids[0],
      ids[2],
      ids[4],
    ]);
    // Only the candidates were read, whichever way they were applied.
    expect(substructure.screened).toBe(3);

    const similar = await molDB.search('c1ccccc1', {
      mode: 'similarity',
      similarityThreshold: 0,
      candidates,
    });

    expect(similar.results.map((r) => r.entryId).toSorted(byId)).toStrictEqual([
      ids[0],
      ids[2],
      ids[4],
    ]);

    const excluded = await molDB.search('CCc1ccccc1', {
      mode: 'exact',
      candidates,
    });

    expect(excluded.total).toBe(0);
  },
);

test('probe tests each entry rather than listing the subquery', () => {
  const { db } = seed();
  const plan = planOf(db, { candidates: { ...EVEN, strategy: 'probe' } });

  // ocl_ss_index streams in weight order, and the subquery is looked up per
  // entry: nothing is listed, sorted or materialised ahead of the cursor.
  expect(plan).toContain('SCAN s');
  expect(plan).toContain('CORRELATED');
  expect(plan).not.toContain('LIST SUBQUERY');
  expect(plan).not.toContain('TEMP B-TREE');
});

test('drive reads each candidate through the entry index and sorts', () => {
  const { db } = seed();
  const plan = planOf(db, { candidates: { ...EVEN, strategy: 'drive' } });

  expect(plan).toContain('SEARCH s USING INDEX idx_ocl_ss_entry (entry_id=?)');
  expect(plan).toContain('USE TEMP B-TREE FOR ORDER BY');
});

test('drive yields an entry the subquery names twice only once', async () => {
  const { molDB, ids } = seed();
  const response = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    candidates: {
      sql: 'SELECT id AS entry_id FROM molecules UNION ALL SELECT id AS entry_id FROM molecules',
      strategy: 'drive',
    },
  });

  expect(response.results.map((r) => r.entryId)).toStrictEqual(ids);
});

test('the verifier pool orders matches of one weight as one thread does', async () => {
  // Four isomers of C8H10 share a weight, and one candidate per batch spread
  // over four threads comes back in whatever order the threads finish.
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 4,
    batchSize: 1,
    searchCacheSize: 0,
  });
  molDB.migrate();
  const insert = db.prepare('INSERT INTO molecules (id_code) VALUES (?)');
  for (const smiles of [
    'Cc1ccccc1C',
    'Cc1cccc(C)c1',
    'Cc1ccc(C)cc1',
    'CCc1ccccc1',
  ]) {
    const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
    const { lastInsertRowid } = insert.run(idCode);
    molDB.insert(Number(lastInsertRowid), idCode);
  }

  const pages = await Promise.all(
    [1, 2, 3, 4, 5].map(() =>
      molDB.search('c1ccccc1', { mode: 'substructure', maxResults: 2 }),
    ),
  );
  await molDB.close();

  for (const page of pages) {
    expect(page.results.map((r) => r.entryId)).toStrictEqual([1, 2]);
  }
});

test('the deadline stops a scan from inside SQLite', async () => {
  // Pyridine passes the prefilter for none of them, so the scan yields no row
  // and the loop that looks at the clock between rows never runs: only the
  // guard, which reads it at entry ids that are multiples of 1024, can stop it.
  const { molDB } = seed([1, 2, 1024, 2048, 3072]);

  const finished = await molDB.search('c1ccncc1', { mode: 'substructure' });

  expect(finished.partial).toBe(false);

  const stopped = await molDB.search('c1ccncc1', {
    mode: 'substructure',
    candidates: { ...EVEN, strategy: 'probe' },
    timeoutMs: -1,
  });

  expect(stopped.partial).toBe(true);
  expect(stopped.results).toStrictEqual([]);

  const similar = await molDB.search('c1ccccc1', {
    mode: 'similarity',
    similarityThreshold: 0,
    timeoutMs: -1,
  });

  expect(similar.partial).toBe(true);
});

test('the guard aborts the statement with an error it recognises', () => {
  const { db } = seed([1024, 2, 3, 4, 5]);

  expect(installScanDeadline(db)).toBe(true);

  const mol = OCL.Molecule.fromSmiles('c1ccccc1');
  mol.setFragment(true);
  const query = buildPrescreenSql({
    entriesTable: 'molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    mol,
    deadline: 0,
  });
  let caught: unknown;
  try {
    db.prepare(query.sql).all(...(query.params as never[]));
  } catch (error: unknown) {
    caught = error;
  }

  expect(isScanDeadline(caught)).toBe(true);
});
