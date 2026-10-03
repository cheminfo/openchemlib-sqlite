import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterAll, expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import type { SQLiteDatabase } from '../types.ts';

const SMILES = [
  'c1ccccc1',
  'Cc1ccccc1',
  'Oc1ccccc1',
  'Nc1ccccc1',
  'CCO',
  'OCC1OC(O)C(O)C(O)C1O',
  'O=c1cc(-c2ccccc2)oc2ccccc12',
  'O=c1c(O)c(-c2ccc(O)c(O)c2)oc2cc(O)cc(O)c12',
  'CC(=O)Oc1ccccc1C(=O)O',
  'Cn1cnc2c1c(=O)n(C)c(=O)n2C',
  'c1ccc2ccccc2c1',
  'C1CCC2C(C1)CCC1C2CCC2CCCC21',
];

/** Each entry's fingerprint, computed once. */
const ENTRY_INDEXES = SMILES.map((smiles) =>
  OCL.Molecule.fromSmiles(smiles).getIndex(),
);

const opened: MoleculesDBSQLite[] = [];

afterAll(async () => {
  await Promise.all(opened.map((molDB) => molDB.close()));
});

/**
 * The molecules in an index, on a connection that may hide its functions.
 * @param withFunctions - Whether the driver may register SQL functions.
 * @returns The index.
 */
function seed(withFunctions: boolean): MoleculesDBSQLite {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)',
  );
  // A driver without `function()`: what the scan falls back on.
  const connection: SQLiteDatabase = withFunctions
    ? db
    : {
        prepare: (sql: string) => db.prepare(sql),
        exec: (sql: string) => db.exec(sql),
      };
  const molDB = new MoleculesDBSQLite(connection, OCL, {
    entriesTable: 'molecules',
    poolSize: 1,
    searchCacheSize: 0,
  });
  opened.push(molDB);
  molDB.migrate();
  const insert = db.prepare(
    'INSERT INTO molecules (id, id_code) VALUES (?, ?)',
  );
  for (const [index, smiles] of SMILES.entries()) {
    const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
    insert.run(index + 1, idCode);
    molDB.insert(index + 1, idCode);
  }
  return molDB;
}

/**
 * The coefficients OpenChemLib itself gives, best first.
 * @param query - The query, as SMILES.
 * @param threshold - The lowest kept.
 * @returns Each entry id and its coefficient.
 */
function expected(query: string, threshold: number): Array<[number, number]> {
  const queryIndex = OCL.Molecule.fromSmiles(query).getIndex();
  const pairs: Array<[number, number]> = [];
  for (const [index, entryIndex] of ENTRY_INDEXES.entries()) {
    const similarity = OCL.SSSearcherWithIndex.getSimilarityTanimoto(
      queryIndex,
      entryIndex,
    );
    if (similarity >= threshold) pairs.push([index + 1, similarity]);
  }
  return pairs.toSorted((a, b) => b[1] - a[1] || a[0] - b[0]);
}

test.each([
  ['computed in SQLite', true],
  ['computed in JavaScript', false],
])(
  "the coefficients are OpenChemLib's, exactly (%s)",
  async (_how, withFunctions) => {
    const molDB = seed(withFunctions);
    for (const query of ['O=c1cc(-c2ccccc2)oc2ccccc12', 'Cc1ccccc1', 'CCO']) {
      for (const threshold of [0, 0.3, 0.8]) {
        // eslint-disable-next-line no-await-in-loop -- intentional: one search at a time on one connection
        const { results, timedOut } = await molDB.search(query, {
          mode: 'similarity',
          similarityThreshold: threshold,
        });

        expect(timedOut).toBe(false);
        expect(
          results
            .map((hit): [number, number] => [hit.entryId, hit.similarity ?? -1])
            .toSorted((a, b) => b[1] - a[1] || a[0] - b[0]),
        ).toStrictEqual(expected(query, threshold));
      }
    }
  },
);

test('a restricted similarity scan computes the coefficient over its candidates only', async () => {
  const molDB = seed(true);
  const { results } = await molDB.search('c1ccccc1', {
    mode: 'similarity',
    similarityThreshold: 0,
    candidates: {
      sql: 'SELECT id AS entry_id FROM molecules WHERE id IN (:a, :b)',
      params: { a: 2, b: 3 },
      strategy: 'probe',
    },
    mwRange: { max: 93 },
  });

  // Toluene weighs 92.14 and phenol 94.11: only toluene is kept.
  expect(results.map((hit) => hit.entryId)).toStrictEqual([2]);
  expect(results[0]?.similarity).toBe(
    expected('c1ccccc1', 0).find(([id]) => id === 2)?.[1],
  );
});
