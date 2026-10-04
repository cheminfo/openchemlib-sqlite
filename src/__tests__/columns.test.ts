import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterAll, expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import type { MoleculesDBConfig, SearchOptions } from '../types.ts';

/** Benzene derivatives and a few others, each with two made-up properties. */
const MOLECULES = [
  { smiles: 'c1ccccc1', rings: 1, logP: 2.1 },
  { smiles: 'Cc1ccccc1', rings: 1, logP: 2.7 },
  { smiles: 'Oc1ccccc1', rings: 1, logP: 1.5 },
  { smiles: 'c1ccc(-c2ccccc2)cc1', rings: 2, logP: 4 },
  { smiles: 'c1ccc2ccccc2c1', rings: 2, logP: 3.3 },
  { smiles: 'CCO', rings: 0, logP: -0.3 },
  { smiles: 'NS(=O)(=O)c1ccccc1', rings: 1, logP: 0.3 },
  { smiles: 'O=C(O)c1ccccc1', rings: 1, logP: 1.9 },
];

const COLUMNS: MoleculesDBConfig['columns'] = {
  rings: 'integer',
  logP: 'real',
};

const opened: MoleculesDBSQLite[] = [];

afterAll(async () => {
  await Promise.all(opened.map((molDB) => molDB.close()));
});

/**
 * The molecules, in an entries table carrying their properties too.
 * @returns The connection.
 */
function entries() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL, rings INTEGER, logP REAL)',
  );
  const insert = db.prepare(
    'INSERT INTO molecules (id, id_code, rings, logP) VALUES (?, ?, ?, ?)',
  );
  for (const [index, molecule] of MOLECULES.entries()) {
    const idCode = OCL.Molecule.fromSmiles(molecule.smiles).getIDCode();
    insert.run(index + 1, idCode, molecule.rings, molecule.logP);
  }
  return db;
}

/**
 * An index over the entries.
 * @param db - The connection.
 * @param columns - The columns it carries.
 * @returns The molecules DB, migrated.
 */
function index(db: DatabaseSync, columns?: MoleculesDBConfig['columns']) {
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 1,
    searchCacheSize: 10,
    ...(columns === undefined ? {} : { columns }),
  });
  opened.push(molDB);
  molDB.migrate();
  return molDB;
}

/**
 * Index every entry, with its properties when the index carries them.
 * @param db - The connection.
 * @param molDB - The index.
 */
function fill(db: DatabaseSync, molDB: MoleculesDBSQLite) {
  const rows = db
    .prepare('SELECT id, id_code AS idCode, rings, logP FROM molecules')
    .all() as Array<{
    id: number;
    idCode: string;
    rings: number;
    logP: number;
  }>;
  for (const row of rows) {
    molDB.insert(row.id, row.idCode, {
      columns: { rings: row.rings, logP: row.logP },
    });
  }
}

/**
 * The entry ids a search answers, in order.
 * @param molDB - The index.
 * @param smiles - The query.
 * @param options - The search options.
 * @returns The ids.
 */
async function ids(
  molDB: MoleculesDBSQLite,
  smiles: string,
  options: SearchOptions,
): Promise<number[]> {
  const response = await molDB.search(smiles, options);
  return response.results.map((result) => result.entryId);
}

/**
 * The same bounds as a probed subquery on the entries table.
 * @param where - The bounds, as SQL on `molecules`.
 * @returns The search options.
 */
function probe(where: string): SearchOptions {
  return {
    candidates: {
      sql: `SELECT id AS entry_id FROM molecules WHERE ${where}`,
      strategy: 'probe',
    },
  };
}

test('a bound on a carried column keeps what the same bound probed keeps', async () => {
  const db = entries();
  const carried = index(db, COLUMNS);
  fill(db, carried);

  for (const [ranges, where] of [
    [{ rings: { max: 1 } }, 'rings <= 1'],
    [{ logP: { min: 2, max: 3.5 } }, 'logP >= 2 AND logP <= 3.5'],
    [{ rings: { min: 2 }, logP: { max: 3.5 } }, 'rings >= 2 AND logP <= 3.5'],
  ] as const) {
    for (const mode of ['substructure', 'similarity', 'exact'] as const) {
      const options = { mode, similarityThreshold: 0.1 };
      // eslint-disable-next-line no-await-in-loop -- one search at a time, compared
      const bounded = await ids(carried, 'c1ccccc1', {
        ...options,
        columnRanges: ranges,
      });
      // eslint-disable-next-line no-await-in-loop -- one search at a time, compared
      const probed = await ids(carried, 'c1ccccc1', {
        ...options,
        ...probe(where),
      });

      expect(bounded).toStrictEqual(probed);
    }
  }

  await expect(
    ids(carried, 'c1ccccc1', {
      mode: 'substructure',
      columnRanges: { rings: { max: 1 }, logP: { min: 1, max: 2 } },
    }),
  ).resolves.toStrictEqual([3, 8]);
});

test('a column declared on a filled index is added empty, and bounded once filled', async () => {
  const db = entries();
  fill(db, index(db));
  const carried = index(db, COLUMNS);

  expect(carried.columnStatus()).toStrictEqual([
    {
      name: 'logP',
      type: 'real',
      declared: true,
      complete: false,
      filledThrough: 0,
      fillTo: 8,
    },
    {
      name: 'rings',
      type: 'integer',
      declared: true,
      complete: false,
      filledThrough: 0,
      fillTo: 8,
    },
  ]);
  await expect(
    carried.search('c1ccccc1', {
      mode: 'substructure',
      columnRanges: { rings: { max: 1 } },
    }),
  ).rejects.toThrow(
    'the index does not carry the column "rings" for every entry; see columnStatus()',
  );

  const read = db.prepare(
    'SELECT id, rings, logP FROM molecules WHERE id IN (SELECT value FROM json_each(?))',
  );
  const reader = (entryIds: readonly number[]) =>
    (
      read.all(JSON.stringify(entryIds)) as Array<{
        id: number;
        rings: number;
        logP: number;
      }>
    ).map((row) => ({
      entryId: row.id,
      columns: { rings: row.rings, logP: row.logP },
    }));
  const first = await carried.fillColumns(reader, { chunkSize: 3, limit: 5 });

  expect([first.filled, first.pending]).toStrictEqual([5, true]);
  expect(carried.columnStatus()[0]).toMatchObject({
    complete: false,
    filledThrough: 5,
  });

  const rest = await carried.fillColumns(reader, { chunkSize: 3 });

  expect([rest.filled, rest.pending]).toStrictEqual([3, false]);
  expect(carried.columnStatus().map((column) => column.complete)).toStrictEqual(
    [true, true],
  );
  await expect(
    ids(carried, 'c1ccccc1', {
      mode: 'substructure',
      columnRanges: { rings: { max: 1 }, logP: { min: 1, max: 2 } },
    }),
  ).resolves.toStrictEqual([3, 8]);
});

test('a column cannot be retyped, renamed oddly, or bounded undeclared', async () => {
  const db = entries();
  fill(db, index(db, COLUMNS));

  expect(() => index(db, { rings: 'real' })).toThrow(
    'ocl_ss_index carries col_rings as integer; it cannot be declared real',
  );
  expect(() => index(db, { 'rings; DROP TABLE x': 'integer' })).toThrow(
    'the column name "rings; DROP TABLE x" is not a plain identifier of at most 60 characters',
  );

  const without = index(db, { logP: 'real' });

  expect(without.columnStatus()).toMatchObject([
    { name: 'logP', declared: true, complete: true },
    { name: 'rings', declared: false, complete: true },
  ]);
  await expect(
    without.search('c1ccccc1', {
      mode: 'substructure',
      columnRanges: { rings: { max: 1 } },
    }),
  ).rejects.toThrow('the index does not carry the column "rings"');
});

test('a search bounded differently is not answered from the cache', async () => {
  const db = entries();
  const carried = index(db, COLUMNS);
  fill(db, carried);
  const search = (max: number) =>
    ids(carried, 'c1ccccc1', {
      mode: 'substructure',
      columnRanges: { logP: { max } },
    });

  await expect(search(2)).resolves.toStrictEqual([3, 8, 7]);
  await expect(search(3)).resolves.toStrictEqual([1, 2, 3, 8, 7]);
});

test('the plane index applies the bounds too', async () => {
  const db = entries();
  const carried = index(db, COLUMNS);
  fill(db, carried);
  carried.foldPlanes({ maxPopulationRatio: 1 });
  const bounded = { columnRanges: { rings: { max: 1 } } };

  await expect(
    ids(carried, 'c1ccccc1', { mode: 'substructure', ...bounded }),
  ).resolves.toStrictEqual([1, 2, 3, 8, 7]);
  await expect(
    ids(carried, 'c1ccccc1', {
      mode: 'substructure',
      maxResults: 2,
      ...bounded,
    }),
  ).resolves.toStrictEqual([1, 2]);
});
