import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../../MoleculesDBSQLite.ts';
import { buildPrescreenSql } from '../prescreen.ts';
import { indexHasUnknownMw, queryMwBound } from '../queryMwBound.ts';

const HEAVY = 'Clc1ccccc1CCc1ccncc1';

/**
 * Compare entry ids, so a result order is not asserted by accident.
 * @param a - One id.
 * @param b - The other.
 * @returns Their difference.
 */
const byId = (a: number | undefined, b: number | undefined) =>
  (a ?? 0) - (b ?? 0);

/**
 * A fragment with its query flag set, as the prescreen receives it.
 * @param smiles - The fragment, as SMILES.
 * @returns The fragment molecule.
 */
function fragment(smiles: string) {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.setFragment(true);
  return mol;
}

/**
 * A small library of real molecules spanning a wide weight range.
 * @param options - Passed on to the molecules DB.
 * @param options.mwColumn - Column the library should read weights from.
 * @param options.trustMwColumn - Whether that column may be relied on.
 * @param options.bogusMw - Store a weight that is not the molecular weight.
 * @returns The connection, the molecules DB and the ids by SMILES.
 */
function seed(
  options: {
    mwColumn?: string;
    trustMwColumn?: boolean;
    /** Store a weight that is not the molecular weight, as a caller might. */
    bogusMw?: boolean;
  } = {},
) {
  const { bogusMw = false, ...config } = options;
  const db = new DatabaseSync(':memory:');
  db.exec(
    `CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL, mw REAL)`,
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    ...config,
  });
  molDB.migrate();
  const ids = new Map<string, number>();
  for (const smiles of ['c1ccccc1', 'Cc1ccccc1', 'Oc1ccccc1', HEAVY, 'CCO']) {
    const mol = OCL.Molecule.fromSmiles(smiles);
    const idCode = mol.getIDCode();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO molecules (id_code, mw) VALUES (?, ?)')
      .run(
        idCode,
        bogusMw && smiles === HEAVY
          ? 5
          : mol.getMolecularFormula().relativeWeight,
      );
    ids.set(smiles, Number(lastInsertRowid));
    molDB.insert(Number(lastInsertRowid), idCode);
  }
  return { db, molDB, ids };
}

test('a plain fragment is bounded by the weight of its heavy atoms', () => {
  // Benzene's fragment formula is C6, not C6H6: a match must carry those six
  // carbons, and the hydrogens the formula leaves out only add mass.
  expect(queryMwBound(fragment('c1ccccc1'))).toBeCloseTo(72.07, 2);
  expect(queryMwBound(fragment(HEAVY))).toBeCloseTo(205.6, 1);
});

test('an empty fragment has no bound', () => {
  expect(queryMwBound(fragment(''))).toBeNull();
});

test('a query feature refuses the bound', () => {
  const list = fragment('c1ccccc1');
  list.setAtomList(0, [7, 8], false);

  expect(queryMwBound(list)).toBeNull();

  const excluded = fragment('Clc1ccccc1');
  excluded.setAtomQueryFeature(0, OCL.Molecule.cAtomQFExcludeGroup, true);

  expect(queryMwBound(excluded)).toBeNull();

  const any = fragment('c1ccccc1');
  any.setAtomQueryFeature(0, OCL.Molecule.cAtomQFAny, true);

  expect(queryMwBound(any)).toBeNull();
});

test('the bound is written into the prescreen only when it is given', () => {
  const base = {
    entriesTable: 'molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    mol: fragment('c1ccccc1'),
  };

  expect(buildPrescreenSql(base).sql).not.toContain('s.mw >=');

  const bounded = buildPrescreenSql({ ...base, mwFloor: 72.07 });

  expect(bounded.sql).toContain('s.mw >= ?');
  expect(bounded.params.at(-1)).toBe(72.07);
});

test('SQLite seeks on the bound instead of scanning the lighter entries', () => {
  const { db } = seed();
  const query = buildPrescreenSql({
    entriesTable: 'molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    mol: fragment(HEAVY),
    mwFloor: 205.6,
  });
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .all(...(query.params as never[])) as Array<Record<string, unknown>>;
  const steps = plan.map((row) => String(row.detail)).join(' | ');

  // `s` is ocl_ss_index, and it is sought on its clustered key rather than
  // scanned — which is the entire point of the bound.
  expect(steps).toContain('SEARCH s USING PRIMARY KEY (mw>?)');
});

test('the bound changes no result', async () => {
  const { molDB, ids } = seed();
  const heavy = await molDB.search(HEAVY, { mode: 'substructure' });

  expect(heavy.results.map((r) => r.entryId)).toStrictEqual([ids.get(HEAVY)]);

  const benzene = await molDB.search('c1ccccc1', { mode: 'substructure' });

  expect(benzene.results.map((r) => r.entryId).toSorted(byId)).toStrictEqual(
    [
      ids.get('c1ccccc1'),
      ids.get('Cc1ccccc1'),
      ids.get('Oc1ccccc1'),
      ids.get(HEAVY),
    ].toSorted(byId),
  );
});

test('a configured mwColumn is not trusted unless the caller says so', async () => {
  // The column holds 5 for a 217 Da molecule: a sort key, not a weight. This is
  // why the bound is off by default for a caller's own column.
  const bogus = seed({ mwColumn: 'mw', bogusMw: true });
  const found = await bogus.molDB.search(HEAVY, { mode: 'substructure' });

  expect(found.results.map((r) => r.entryId)).toStrictEqual([
    bogus.ids.get(HEAVY),
  ]);

  // Promising the column is the weight when it is not drops the match, which is
  // the caller's responsibility and the reason this is opt-in.
  const trusted = seed({ mwColumn: 'mw', trustMwColumn: true, bogusMw: true });
  const lost = await trusted.molDB.search(HEAVY, { mode: 'substructure' });

  expect(lost.results).toStrictEqual([]);
});

test('an entry of unknown weight disables the bound', () => {
  const { db } = seed();

  expect(indexHasUnknownMw(db)).toBe(false);

  db.exec('UPDATE ocl_ss_index SET mw = 0 WHERE entry_id = 1');

  expect(indexHasUnknownMw(db)).toBe(true);
});
