import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import { generatedLibrary } from '../planes/__tests__/fixture.ts';
import type { SQLiteDatabase } from '../types.ts';
import { restrictEntries } from '../utils/restrictEntries.ts';
import { matchedEntries } from '../utils/similarityEntries.ts';

const IDCODES = generatedLibrary(600);

let shared: ReturnType<typeof library>;
let fingerprints: number[][];

beforeAll(() => {
  shared = library();
  fingerprints = IDCODES.map((idCode) =>
    OCL.Molecule.fromIDCode(idCode).getIndex(),
  );
}, 60_000);

afterAll(async () => {
  await shared.molDB.close();
});

/**
 * The generated molecules in an attached database, the even ids alone listed:
 * the entries table is a view, as molecules.cheminfo.org reads its index
 * through.
 * @returns The connection.
 */
function entries(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    ATTACH DATABASE ':memory:' AS mol;
    CREATE TABLE mol.molecules (
      id INTEGER PRIMARY KEY, id_code TEXT NOT NULL, listed INTEGER NOT NULL);
    CREATE VIEW mol.listed_molecules AS
      SELECT * FROM molecules WHERE listed = 1;
  `);
  const insert = db.prepare(
    'INSERT INTO mol.molecules (id, id_code, listed) VALUES (?, ?, ?)',
  );
  for (const [index, idCode] of IDCODES.entries()) {
    insert.run(index + 1, idCode, (index + 1) % 2 === 0 ? 1 : 0);
  }
  return db;
}

/**
 * The generated molecules, every one indexed, read through the view of the
 * listed ones.
 * @returns The connection, the molecules DB and the SQL it prepared.
 */
function library() {
  const db = entries();
  const prepared: string[] = [];
  const connection: SQLiteDatabase = {
    prepare: (sql: string) => {
      prepared.push(sql);
      return db.prepare(sql);
    },
    exec: (sql: string) => db.exec(sql),
    function: (name, options, fn) => db.function(name, options, fn),
  };
  const molDB = new MoleculesDBSQLite(connection, OCL, {
    entriesTable: 'mol.listed_molecules',
    poolSize: 1,
    searchCacheSize: 0,
  });
  molDB.migrate();
  for (const [index, idCode] of IDCODES.entries()) {
    molDB.insert(index + 1, idCode);
  }
  return { db, molDB, prepared };
}

/**
 * The coefficients OpenChemLib gives the listed entries, best first.
 * @param smiles - The query.
 * @param threshold - The lowest kept.
 * @returns Each entry id and its coefficient.
 */
function expected(smiles: string, threshold: number): Array<[number, number]> {
  const query = OCL.Molecule.fromSmiles(smiles).getIndex();
  const pairs: Array<[number, number]> = [];
  for (const [index, fingerprint] of fingerprints.entries()) {
    if ((index + 1) % 2 !== 0) continue;
    const similarity = OCL.SSSearcherWithIndex.getSimilarityTanimoto(
      query,
      fingerprint,
    );
    if (similarity >= threshold) pairs.push([index + 1, similarity]);
  }
  return pairs.toSorted((a, b) => b[1] - a[1] || a[0] - b[0]);
}

test('the index is scanned on its own, and only listed entries are answered', async () => {
  const { db, molDB, prepared } = shared;
  prepared.length = 0;
  for (const threshold of [0, 0.5, 0.8]) {
    // eslint-disable-next-line no-await-in-loop -- one search at a time on one connection
    const { results, timedOut } = await molDB.search('Oc1ccc(Cl)cc1', {
      mode: 'similarity',
      similarityThreshold: threshold,
    });

    expect(timedOut).toBe(false);
    expect(
      results.map((hit): [number, number] => [
        hit.entryId,
        hit.similarity ?? -1,
      ]),
    ).toStrictEqual(expected('Oc1ccc(Cl)cc1', threshold));
    expect(
      results.every((hit) => hit.idCode === IDCODES[hit.entryId - 1]),
    ).toBe(true);
  }

  const scan = prepared.find((sql) => sql.includes('AS similarity')) ?? '';

  expect(scan).toContain('FROM ocl_ss_index s');
  expect(scan).not.toContain('listed_molecules');

  // The plan reads the clustered table in its order, never through the
  // entry-id index.
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${scan}`)
    .all(...Array.from({ length: scan.split('?').length - 1 }, () => 0))
    .map((row) => (row as { detail: string }).detail);

  expect(plan).toStrictEqual(['SCAN s']);
});

test('probed candidates are tested on the matches, joined ones keep the join', async () => {
  const { molDB, prepared } = shared;
  prepared.length = 0;
  const candidates = {
    sql: 'SELECT id AS entry_id FROM mol.molecules WHERE id % 4 = 0',
  };
  const probed = await molDB.search('Oc1ccc(Cl)cc1', {
    mode: 'similarity',
    similarityThreshold: 0,
    candidates: { ...candidates, strategy: 'probe' },
  });
  const joined = await molDB.search('Oc1ccc(Cl)cc1', {
    mode: 'similarity',
    similarityThreshold: 0,
    candidates: { ...candidates, strategy: 'membership' },
  });
  const kept = expected('Oc1ccc(Cl)cc1', 0).filter(([id]) => id % 4 === 0);

  // Ids 4, 8 … 600: listed, and kept by the candidates.
  expect(kept).toHaveLength(150);
  expect(
    probed.results.map((hit) => [hit.entryId, hit.similarity]),
  ).toStrictEqual(kept);
  expect(probed.results).toStrictEqual(joined.results);

  const scans = prepared.filter((sql) => sql.includes('AS similarity'));

  expect(scans).toHaveLength(2);
  expect(scans[0]).not.toContain('listed_molecules');
  expect(scans[1]).toContain('JOIN (SELECT id AS entry_id');
});

test('past the deadline the best matches read are the ones kept', () => {
  const db = entries();
  const matches = Array.from({ length: 600 }, (_, index) => ({
    entryId: index + 1,
    similarity: (index % 7) / 10,
  }));
  const params = {
    db,
    entriesTable: 'mol.molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    restriction: restrictEntries('id', false),
  };

  const cut = matchedEntries(params, matches, 0);
  const all = matchedEntries(params, matches, Date.now() + 60_000);

  expect(all.timedOut).toBe(false);
  expect(all.results).toHaveLength(600);
  // One chunk of 500 is read before the clock is looked at.
  expect(cut.timedOut).toBe(true);
  expect(cut.results).toStrictEqual(all.results.slice(0, 500));
  expect(cut.results[0]).toStrictEqual({
    entryId: 7,
    idCode: IDCODES[6],
    similarity: 0.6,
  });
});
