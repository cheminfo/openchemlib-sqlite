import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { getIndex, getIndexes } from 'openchemlib-search-wasm';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import type { PrecomputedEntry } from '../types.ts';

const BENZENE = 'gFp@DiTt@@B';
const NAPHTHALENE = 'det@@DjYUX^d@@@@B';

/**
 * An empty database with the index schema in place.
 * @returns The connection and the configured instance.
 */
function makeDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 1,
    searchCacheSize: 0,
  });
  molDB.migrate();
  return { db, molDB };
}

/**
 * Add one entry and index it.
 * @param db - The connection.
 * @param molDB - The configured instance.
 * @param idCode - The molecule.
 * @param precomputed - What the caller claims to hold already.
 * @returns Its primary key.
 */
function add(
  db: DatabaseSync,
  molDB: MoleculesDBSQLite,
  idCode: string,
  precomputed?: PrecomputedEntry,
): number {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO molecules (id_code) VALUES (?)')
    .run(idCode);
  const entryId = Number(lastInsertRowid);
  molDB.insert(entryId, idCode, precomputed);
  return entryId;
}

/**
 * The eight fingerprint words stored for an entry.
 * @param db - The connection.
 * @param entryId - The entry to read.
 * @returns Its words, in column order.
 */
function storedIndex(db: DatabaseSync, entryId: number): bigint[] {
  const statement = db.prepare(
    'SELECT ss_index0, ss_index1, ss_index2, ss_index3, ss_index4, ss_index5, ss_index6, ss_index7 FROM ocl_ss_index WHERE entry_id = ?',
  );
  statement.setReadBigInts(true);
  const row = statement.get(entryId) as Record<string, bigint>;
  return Array.from({ length: 8 }, (_, i) => row[`ss_index${i}`] as bigint);
}

test('a precomputed fingerprint stores the same words as a computed one', () => {
  const computed = makeDB();
  const given = makeDB();

  const computedId = add(computed.db, computed.molDB, BENZENE);
  const givenId = add(given.db, given.molDB, BENZENE, {
    index: getIndex(BENZENE),
  });

  expect(storedIndex(given.db, givenId)).toStrictEqual(
    storedIndex(computed.db, computedId),
  );
});

test('a view from getIndexes is read at its own offset, not the first one', () => {
  const views = getIndexes([BENZENE, NAPHTHALENE]);

  // Checked rather than assumed: an `index` of undefined is a legal
  // PrecomputedEntry, so it would send this test down the computed path and pass
  // there without exercising anything.
  expect(views).toHaveLength(2);

  const first = views[0] as Int32Array;
  const second = views[1] as Int32Array;

  const { db, molDB } = makeDB();
  // The second view starts 64 bytes into one shared buffer. Reading from offset
  // 0 would store benzene's fingerprint for naphthalene, and nothing anywhere
  // would say so.
  const givenId = add(db, molDB, NAPHTHALENE, { index: second });
  const alone = makeDB();
  const aloneId = add(alone.db, alone.molDB, NAPHTHALENE);

  expect(storedIndex(db, givenId)).toStrictEqual(
    storedIndex(alone.db, aloneId),
  );

  expect(storedIndex(db, givenId)).not.toStrictEqual(
    Array.from(new BigInt64Array(first.buffer, first.byteOffset, 8)),
  );
});

test('the eight packed words are taken as they are', () => {
  const { db, molDB } = makeDB();
  const packed = Array.from(new BigInt64Array(getIndex(BENZENE).buffer, 0, 8));

  const entryId = add(db, molDB, BENZENE, { index: packed });

  expect(storedIndex(db, entryId)).toStrictEqual(packed);
});

test('a fingerprint of the wrong width is refused', () => {
  const { db, molDB } = makeDB();
  db.prepare('INSERT INTO molecules (id_code) VALUES (?)').run(BENZENE);

  expect(() => molDB.insert(1, BENZENE, { index: [1, 2, 3] })).toThrow(
    /16 words of 32 bits, not 3/,
  );

  expect(() => molDB.insert(1, BENZENE, { index: new Int32Array(8) })).toThrow(
    /16 words of 32 bits, not 8/,
  );
});

test('a precomputed weight is stored instead of being derived', () => {
  const { db, molDB } = makeDB();

  const entryId = add(db, molDB, BENZENE, { mw: 12.5 });

  const row = db
    .prepare('SELECT mw FROM ocl_ss_index WHERE entry_id = ?')
    .get(entryId) as { mw: number };

  expect(row.mw).toBe(12.5);
});

test('with both given, the molecule is never read', () => {
  const { db, molDB } = makeDB();
  db.prepare('INSERT INTO molecules (id_code) VALUES (?)').run(BENZENE);

  // Not a molecule in any notation: with the fingerprint and the weight both in
  // hand nothing here parses it, which is what makes the fast path observable.
  expect(() =>
    molDB.insert(1, 'not a molecule at all', {
      index: getIndex(BENZENE),
      mw: 78.11,
    }),
  ).not.toThrow();

  expect(storedIndex(db, 1)).toStrictEqual(
    Array.from(new BigInt64Array(getIndex(BENZENE).buffer, 0, 8)),
  );
});

test('a precomputed entry is found by substructure search like any other', async () => {
  const { db, molDB } = makeDB();
  add(db, molDB, BENZENE, { index: getIndex(BENZENE), mw: 78.11 });
  add(db, molDB, NAPHTHALENE, { index: getIndex(NAPHTHALENE), mw: 128.17 });

  const response = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    format: 'smiles',
  });

  expect(
    response.results.map((result) => result.idCode).toSorted(),
  ).toStrictEqual([BENZENE, NAPHTHALENE].toSorted());
});
