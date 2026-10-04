import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import { generatedLibrary } from '../planes/__tests__/fixture.ts';
import type { SQLiteDatabase } from '../types.ts';
import { bitWindow } from '../utils/similarityScan.ts';

const IDCODES = generatedLibrary(600);

/**
 * The generated molecules, indexed.
 * @param withoutFunctions - Whether the index sees a connection that cannot
 *   register a SQL function, so similarity is computed by OpenChemLib in
 *   JavaScript for every row.
 * @returns The connection and the molecules DB.
 */
function library(withoutFunctions = false) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL)',
  );
  const connection: SQLiteDatabase = withoutFunctions
    ? { prepare: (sql) => db.prepare(sql), exec: (sql) => db.exec(sql) }
    : db;
  const molDB = new MoleculesDBSQLite(connection, OCL, {
    entriesTable: 'molecules',
    poolSize: 1,
    searchCacheSize: 0,
  });
  molDB.migrate();
  const insert = db.prepare(
    'INSERT INTO molecules (id, id_code) VALUES (?, ?)',
  );
  for (const [index, idCode] of IDCODES.entries()) {
    insert.run(index + 1, idCode);
    molDB.insert(index + 1, idCode);
  }
  return { db, molDB };
}

/**
 * A similarity search, as ids and coefficients.
 * @param molDB - The index.
 * @param smiles - The query.
 * @param threshold - The coefficient a match reaches.
 * @returns The matches, best first.
 */
async function similar(
  molDB: MoleculesDBSQLite,
  smiles: string,
  threshold: number,
) {
  const response = await molDB.search(smiles, {
    mode: 'similarity',
    similarityThreshold: threshold,
  });
  return response.results.map((hit) => [hit.entryId, hit.similarity]);
}

const QUERIES = ['c1ccncc1C(=O)N', 'Oc1ccc(Cl)cc1', 'C1CCNCC1C#N'];
const THRESHOLDS = [0, 0.3, 0.5, 0.7, 0.9, 1];

test('the bit-count window a threshold allows', () => {
  expect(bitWindow(10, 0.8)).toStrictEqual({ low: 8, high: 12 });
  expect(bitWindow(10, 1)).toStrictEqual({ low: 10, high: 10 });
  expect(bitWindow(7, 0.5)).toStrictEqual({ low: 4, high: 14 });
  // A threshold no coefficient reaches leaves an empty window.
  expect(bitWindow(10, 1.5)).toStrictEqual({ low: 15, high: 6 });
  expect(bitWindow(10, 0)).toBeNull();
  expect(bitWindow(10, -1)).toBeNull();
  expect(bitWindow(10, Number.NaN)).toBeNull();
});

test('each entry carries how many bits its fingerprint sets', () => {
  const { db } = library();
  const read = db.prepare(
    `SELECT ss_bits AS bits, ss_index0, ss_index1, ss_index2, ss_index3,
            ss_index4, ss_index5, ss_index6, ss_index7 FROM ocl_ss_index`,
  );
  read.setReadBigInts(true);
  const rows = read.all() as Array<Record<string, bigint>>;

  expect(rows).toHaveLength(IDCODES.length);

  for (const row of rows) {
    let ones = 0;
    for (let word = 0; word < 8; word++) {
      const binary = BigInt.asUintN(64, row[`ss_index${word}`] ?? 0n).toString(
        2,
      );
      ones += binary.replaceAll('0', '').length;
    }

    expect(Number(row.bits)).toBe(ones);
  }
});

test('skipping the rows outside the window changes no answer', async () => {
  const windowed = library();
  // The same library through a connection without functions: every row is
  // read into JavaScript and compared by OpenChemLib itself, with no window.
  const reference = library(true);

  for (const smiles of QUERIES) {
    for (const threshold of THRESHOLDS) {
      // eslint-disable-next-line no-await-in-loop -- compared one at a time
      const got = await similar(windowed.molDB, smiles, threshold);
      // eslint-disable-next-line no-await-in-loop -- compared one at a time
      const expected = await similar(reference.molDB, smiles, threshold);

      expect(got).toStrictEqual(expected);
    }
  }
});

test('entries indexed before the count existed are computed, then filled', async () => {
  const { db, molDB } = library();
  const before = await similar(molDB, QUERIES[0] as string, 0.5);
  // As a file upgraded from a version without the column leaves them.
  db.exec('UPDATE ocl_ss_index SET ss_bits = NULL WHERE entry_id % 3 = 0');
  db.exec(
    "UPDATE ocl_ss_columns SET fill_to = 600, fill_cursor = 0 WHERE name = 'ss_bits'",
  );

  expect(molDB.columnStatus()[0]).toStrictEqual({
    name: 'ss_bits',
    type: 'integer',
    declared: true,
    complete: false,
    filledThrough: 0,
    fillTo: 600,
  });
  await expect(
    similar(molDB, QUERIES[0] as string, 0.5),
  ).resolves.toStrictEqual(before);

  // No reader needed: the library computes its own column.
  const fill = await molDB.fillColumns();

  expect([fill.filled, fill.pending]).toStrictEqual([600, false]);
  expect(molDB.columnStatus()[0]?.complete).toBe(true);
  await expect(
    similar(molDB, QUERIES[0] as string, 0.5),
  ).resolves.toStrictEqual(before);

  const nulls = db
    .prepare('SELECT count(*) AS n FROM ocl_ss_index WHERE ss_bits IS NULL')
    .get() as { n: number };

  expect(nulls.n).toBe(0);
});

test("entries written by the caller's own SQL, without a bit count, are still found", async () => {
  const windowed = library();
  const reference = library(true);
  // Every row written again the way a caller filling the table itself writes
  // it: the fingerprint, and no count.
  windowed.db.exec(`
    CREATE TEMP TABLE written AS
      SELECT mw, entry_id, ss_index0, ss_index1, ss_index2, ss_index3,
             ss_index4, ss_index5, ss_index6, ss_index7 FROM ocl_ss_index;
    DELETE FROM ocl_ss_index;
    INSERT INTO ocl_ss_index (mw, entry_id, ss_index0, ss_index1, ss_index2,
                              ss_index3, ss_index4, ss_index5, ss_index6, ss_index7)
      SELECT * FROM written;`);
  const nulls = windowed.db
    .prepare('SELECT count(*) AS n FROM ocl_ss_index WHERE ss_bits IS NULL')
    .get() as { n: number };

  expect(nulls.n).toBe(IDCODES.length);
  // The column was complete when the rows went in, and says so still.
  expect(windowed.molDB.columnStatus()[0]?.complete).toBe(true);

  for (const smiles of QUERIES) {
    for (const threshold of [0.5, 0.9]) {
      // eslint-disable-next-line no-await-in-loop -- compared one at a time
      const got = await similar(windowed.molDB, smiles, threshold);
      // eslint-disable-next-line no-await-in-loop -- compared one at a time
      const expected = await similar(reference.molDB, smiles, threshold);

      expect(got).toStrictEqual(expected);
    }
  }
});

test('a fingerprint changed in place loses a bit count it no longer has', async () => {
  const { db, molDB } = library();
  const read = db.prepare(
    `SELECT entry_id AS id, ss_bits AS bits, ss_index0, ss_index1, ss_index2,
            ss_index3, ss_index4, ss_index5, ss_index6, ss_index7
       FROM ocl_ss_index ORDER BY entry_id`,
  );
  read.setReadBigInts(true);
  const rows = read.all() as Array<Record<string, bigint>>;
  const first = rows[0] as Record<string, bigint>;
  // Another entry whose fingerprint sets a different number of bits.
  const other = rows.find((row) => row.bits !== first.bits) as Record<
    string,
    bigint
  >;
  const words = [0, 1, 2, 3, 4, 5, 6, 7].map(
    (word) => other[`ss_index${word}`] as bigint,
  );
  const update = db.prepare(
    `UPDATE ocl_ss_index SET ss_index0 = ?, ss_index1 = ?, ss_index2 = ?,
            ss_index3 = ?, ss_index4 = ?, ss_index5 = ?, ss_index6 = ?,
            ss_index7 = ? WHERE entry_id = ?`,
  );
  update.run(...words, first.id as bigint);
  const statement = db.prepare(
    'SELECT ss_bits AS bits FROM ocl_ss_index WHERE entry_id = ?',
  );
  const bitsOf = (id: bigint | number) =>
    (statement.get(id) as { bits: number | null }).bits;

  expect(bitsOf(first.id as bigint)).toBeNull();

  // The entry now holds the other one's fingerprint, so it is found as an
  // identical match of the other one's molecule.
  const response = await molDB.search(IDCODES[Number(other.id) - 1] as string, {
    format: 'idCode',
    mode: 'similarity',
    similarityThreshold: 1,
  });

  expect(response.results.map((hit) => hit.entryId)).toContain(
    Number(first.id),
  );

  // An update that writes the count with the fingerprint is trusted.
  db.prepare(
    'UPDATE ocl_ss_index SET ss_index0 = ss_index0 + 1, ss_bits = 99 WHERE entry_id = ?',
  ).run(Number(other.id));

  expect(bitsOf(Number(other.id))).toBe(99);
});
