import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterAll, expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import type { ScanPosition, SearchResponse } from '../types.ts';
import { buildPrescreenSql } from '../utils/prescreen.ts';
import { BEFORE_EVERY_ENTRY } from '../utils/searchHelpers.ts';

/**
 * Alkylbenzenes with one to twelve carbons on the ring, the three xylenes
 * beside ethylbenzene — four entries of one weight, so a page can end between
 * isomers — and alkanes, which hold no ring.
 */
const SMILES = [
  ...Array.from({ length: 12 }, (_, n) => `${'C'.repeat(n + 1)}c1ccccc1`),
  'Cc1ccccc1C',
  'Cc1cccc(C)c1',
  'Cc1ccc(C)cc1',
  ...Array.from({ length: 8 }, (_, n) => 'C'.repeat(n + 2)),
];

const opened: MoleculesDBSQLite[] = [];

afterAll(async () => {
  await Promise.all(opened.map((molDB) => molDB.close()));
});

/**
 * An in-memory database holding {@link SMILES}, in that order.
 * @param poolSize - The verifier threads.
 * @param step - The ids are its multiples, from itself.
 * @returns The database and its index.
 */
function seed(poolSize: number, step = 1) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize,
    batchSize: 2,
    searchCacheSize: 0,
  });
  opened.push(molDB);
  molDB.migrate();
  const insert = db.prepare(
    'INSERT INTO molecules (id, id_code) VALUES (?, ?)',
  );
  for (const [index, smiles] of SMILES.entries()) {
    const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
    insert.run((index + 1) * step, idCode);
    molDB.insert((index + 1) * step, idCode);
  }
  return { db, molDB };
}

/**
 * Page through a substructure search, each page resuming where the last one
 * stopped.
 * @param molDB - The index.
 * @param maxResults - The page size.
 * @returns Every page, in order.
 */
async function pages(
  molDB: MoleculesDBSQLite,
  maxResults: number,
): Promise<SearchResponse[]> {
  const answered: SearchResponse[] = [];
  let after: ScanPosition | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop -- intentional: each page starts where the previous one stopped
    const page = await molDB.search('c1ccccc1', {
      mode: 'substructure',
      maxResults,
      ...(after === undefined ? {} : { after }),
    });
    answered.push(page);
    after = page.resume;
  } while (after !== undefined && answered.length < 20);
  return answered;
}

test.each([1, 2])(
  'pages resumed one after another answer the whole scan, once each (%i thread(s))',
  async (poolSize) => {
    const { molDB } = seed(poolSize);
    const whole = await molDB.search('c1ccccc1', { mode: 'substructure' });

    expect(whole.results).toHaveLength(15);
    expect(whole.resume).toBeUndefined();
    expect(whole.timedOut).toBe(false);

    const answered = await pages(molDB, 4);

    expect(answered.map((page) => page.results.length)).toStrictEqual([
      4, 4, 4, 3,
    ]);
    expect(
      answered.flatMap((page) => page.results.map((hit) => hit.entryId)),
    ).toStrictEqual(whole.results.map((hit) => hit.entryId));
    // Toluene, then the four C8H10 isomers in id order: the first page ends
    // between two of them, and the second resumes at the next.
    expect(answered[0]?.results.map((hit) => hit.entryId)).toStrictEqual([
      1, 2, 13, 14,
    ]);
    expect(answered[0]?.resume).toStrictEqual({
      mw: answered[0]?.results[3]?.mw,
      entryId: 14,
    });
    expect(answered[1]?.results.map((hit) => hit.entryId)).toStrictEqual([
      15, 3, 4, 5,
    ]);
    // A full page was cut at its bound, never by the clock; the last one read
    // every candidate there was.
    expect(answered.map((page) => [page.partial, page.timedOut])).toStrictEqual(
      [
        [true, false],
        [true, false],
        [true, false],
        [false, false],
      ],
    );
    expect(answered[3]?.resume).toBeUndefined();
  },
);

test('a scan out of time says so, and resumes where it started when it read nothing', async () => {
  // Every id a multiple of 1024, so the guard reads the clock at every row.
  const { molDB } = seed(1, 1024);
  const stopped = await molDB.search('c1ccncc1', {
    mode: 'substructure',
    candidates: {
      sql: 'SELECT id AS entry_id FROM molecules',
      strategy: 'probe',
    },
    timeoutMs: -1,
  });

  expect(stopped.timedOut).toBe(true);
  expect(stopped.partial).toBe(true);

  const from = { mw: 100, entryId: 3 };
  const resumed = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    after: from,
    timeoutMs: -1,
  });

  expect(resumed.timedOut).toBe(true);
  expect(resumed.results).toStrictEqual([]);
  expect(resumed.resume).toStrictEqual(from);

  const fromStart = await molDB.search('c1ccccc1', {
    mode: 'substructure',
    timeoutMs: -1,
  });

  expect(fromStart.resume).toStrictEqual(BEFORE_EVERY_ENTRY);
  expect(BEFORE_EVERY_ENTRY).toStrictEqual({
    mw: -Number.MAX_VALUE,
    entryId: Number.MIN_SAFE_INTEGER,
  });
});

test('a scan out of time is not cached, so the same search given time answers in full', async () => {
  const { db } = seed(1, 1024);
  // The default search cache, whose key holds no timeout.
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 1,
  });
  opened.push(molDB);

  for (const [mode, expected] of [
    ['substructure', 15],
    ['similarity', SMILES.length],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- intentional: the retry must follow the stopped scan
    const stopped = await molDB.search('c1ccccc1', {
      mode,
      similarityThreshold: 0,
      timeoutMs: -1,
    });
    // eslint-disable-next-line no-await-in-loop -- intentional: the retry must follow the stopped scan
    const retried = await molDB.search('c1ccccc1', {
      mode,
      similarityThreshold: 0,
    });

    expect([stopped.timedOut, stopped.results.length]).toStrictEqual([true, 0]);
    expect([retried.timedOut, retried.results.length]).toStrictEqual([
      false,
      expected,
    ]);
  }
});

test('a resumed scan seeks past the position on the clustered key', () => {
  const { db } = seed(1);
  const mol = OCL.Molecule.fromSmiles('c1ccccc1');
  mol.setFragment(true);
  const query = buildPrescreenSql({
    entriesTable: 'molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    mol,
    after: { mw: 106, entryId: 13 },
  });
  const plan = (
    db
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...(query.params as never[])) as Array<{ detail: string }>
  ).map((row) => row.detail);

  expect(plan[0]).toBe('SEARCH s USING PRIMARY KEY ((mw,entry_id)>(?,?))');
});
