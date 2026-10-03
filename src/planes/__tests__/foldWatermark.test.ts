import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../../MoleculesDBSQLite.ts';
import type { PrescreenState } from '../../utils/prescreen.ts';
import { prescreen } from '../../utils/prescreen.ts';
import { beginFold } from '../foldState.ts';
import { TAIL_TABLE } from '../planeSchema.ts';

const SMILES = [
  'Oc1ccccc1',
  'Cc1ccccc1',
  'O=C(N)c1ccccc1',
  'NS(=O)(=O)c1ccccc1',
  'CCO',
  'C1CCCCC1',
  'Cn1cnc2c1c(=O)n(C)c(=O)n2C',
  'CC(=O)Oc1ccccc1C(=O)O',
];

/**
 * A library of entries 1 to 8, folded, with every plane stored so the plane
 * index answers any fragment.
 * @returns The connection and the molecules DB.
 */
function folded() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 1,
    planeCandidateRatio: 1,
  });
  molDB.migrate();
  for (const smiles of SMILES) add(db, molDB, smiles);
  molDB.foldPlanes({ maxPopulationRatio: 1 });
  return { db, molDB };
}

/**
 * Add a molecule to the entries table and the index.
 * @param db - The connection.
 * @param molDB - The molecules DB.
 * @param smiles - The molecule.
 * @param id - The id to give it; the next one when omitted.
 * @returns The entry id.
 */
function add(
  db: DatabaseSync,
  molDB: MoleculesDBSQLite,
  smiles: string,
  id?: number,
): number {
  const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
  const { lastInsertRowid } =
    id === undefined
      ? db.prepare('INSERT INTO molecules (id_code) VALUES (?)').run(idCode)
      : db
          .prepare('INSERT INTO molecules (id, id_code) VALUES (?, ?)')
          .run(id, idCode);
  molDB.insert(Number(lastInsertRowid), idCode);
  return Number(lastInsertRowid);
}

/**
 * The candidates the prescreen yields for a fragment.
 * @param db - The connection.
 * @param smiles - The fragment.
 * @param planeIndex - Whether the plane index may answer.
 * @returns The candidate ids, ascending and with any repeat kept, and the path.
 */
function screen(db: DatabaseSync, smiles: string, planeIndex = true) {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.setFragment(true);
  const state: PrescreenState = { screened: 0, partial: false };
  const found = [
    ...prescreen(
      {
        db,
        entriesTable: 'molecules',
        pkColumn: 'id',
        idCodeColumn: 'id_code',
        mol,
        timeoutMs: 10_000,
        maxCandidates: Number.MAX_SAFE_INTEGER,
        planeCandidateRatio: 1,
        planeIndex,
      },
      state,
    ),
  ];
  return {
    ids: found.map((c) => c.entryId).toSorted((a, b) => a - b),
    usedPlaneIndex: state.usedPlaneIndex === true,
  };
}

/**
 * Assert the plane path answers a fragment exactly as the column path does.
 * @param db - The connection.
 * @param smiles - The fragment.
 * @returns The candidate ids.
 */
function expectSameAsColumn(db: DatabaseSync, smiles: string): number[] {
  const planes = screen(db, smiles);

  expect(planes.usedPlaneIndex).toBe(true);
  expect(planes.ids).toStrictEqual(screen(db, smiles, false).ids);

  return planes.ids;
}

/**
 * The entry ids the tail holds.
 * @param db - The connection.
 * @returns Them, ascending.
 */
function tailIds(db: DatabaseSync): number[] {
  const rows = db
    .prepare(`SELECT entry_id FROM ${TAIL_TABLE} ORDER BY entry_id`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => Number(row.entry_id));
}

test('an id above the watermark is never copied, and is screened until folded', () => {
  const { db, molDB } = folded();
  const id = add(db, molDB, 'Oc1ccc(Cl)cc1');

  expect(tailIds(db)).toStrictEqual([]);
  expect(molDB.planeStatus()).toStrictEqual({
    folded: SMILES.length,
    segments: 1,
    pending: 1,
    tail: 0,
  });
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toContain(id);

  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 1,
    pending: false,
  });
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toContain(id);
});

test('an id below the watermark waits in the tail, and the next fold takes it', () => {
  const { db, molDB } = folded();
  add(db, molDB, 'Oc1ccc(Cl)cc1', 0);

  expect(tailIds(db)).toStrictEqual([0]);
  expect(molDB.planeStatus()).toMatchObject({ pending: 1, tail: 1 });
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toContain(0);

  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 1,
    pending: false,
  });
  expect(tailIds(db)).toStrictEqual([]);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toContain(0);
});

test('an id reused after a delete answers for its new structure only', () => {
  const { db, molDB } = folded();
  // Entry 1 is phenol, and folded: its bits stay in the planes.
  molDB.remove(1);
  db.prepare('DELETE FROM molecules WHERE id = 1').run();
  add(db, molDB, 'C1CCNCC1', 1);

  expect(tailIds(db)).toStrictEqual([1]);

  expect(expectSameAsColumn(db, 'Oc1ccccc1')).not.toContain(1);
  expect(expectSameAsColumn(db, 'C1CCNCC1')).toContain(1);

  molDB.foldPlanes({ maxPopulationRatio: 1 });

  expect(expectSameAsColumn(db, 'Oc1ccccc1')).not.toContain(1);
  expect(expectSameAsColumn(db, 'C1CCNCC1')).toContain(1);
  expect(tailIds(db)).toStrictEqual([]);
});

test('an id inserted mid-fold between the watermark and the bound is not lost', () => {
  const { db, molDB } = folded();
  add(db, molDB, 'Oc1ccc(Cl)cc1', 9);
  add(db, molDB, 'Oc1ccc(Br)cc1', 11);
  // Entry 10 arrives while the fold writes the chunk it has already read: after
  // it took 9 and 11, before it moves the watermark from 8 to 11. A trigger
  // bound by the old watermark would not copy it, and no fold would find it.
  const mol = OCL.Molecule.fromSmiles('Oc1ccc(I)cc1');
  const words = new BigInt64Array(new Uint32Array(mol.getIndex()).buffer);
  db.exec(`
    CREATE TEMP TRIGGER mid_fold AFTER INSERT ON ocl_ss_slot
    WHEN NEW.entry_id = 11
    BEGIN
      INSERT INTO molecules (id, id_code) VALUES (10, '${mol.getIDCode()}');
      INSERT INTO ocl_ss_index (mw, entry_id, ss_index0, ss_index1, ss_index2,
        ss_index3, ss_index4, ss_index5, ss_index6, ss_index7)
      VALUES (${mol.getMolecularFormula().relativeWeight}, 10, ${[...words].join(', ')});
    END;`);

  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 2,
    pending: true,
  });
  expect(tailIds(db)).toStrictEqual([10]);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([1, 8, 9, 10, 11]);

  db.exec('DROP TRIGGER mid_fold');

  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 1,
    pending: false,
  });
  expect(tailIds(db)).toStrictEqual([]);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([1, 8, 9, 10, 11]);
});

test('a copy the fold reaches anyway goes with the chunk', () => {
  const { db, molDB } = folded();
  add(db, molDB, 'Oc1ccc(Br)cc1', 11);
  // The fold has begun, bound 11, but read nothing yet when 10 arrives: it is
  // copied in case the fold were past it, then read from ocl_ss_index anyway.
  beginFold(db);
  add(db, molDB, 'Oc1ccc(I)cc1', 10);

  expect(tailIds(db)).toStrictEqual([10]);
  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 2,
    pending: false,
  });
  expect(tailIds(db)).toStrictEqual([]);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([1, 8, 10, 11]);
});

test('an entry both folded and waiting in the tail is answered once', async () => {
  const { db, molDB } = folded();
  // Inserted again under its own id, below the watermark: copied to the tail
  // while its slot still holds it.
  molDB.insert(1, OCL.Molecule.fromSmiles('Oc1ccccc1').getIDCode());

  expect(tailIds(db)).toStrictEqual([1]);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([1, 8]);

  const found = await molDB.search('Oc1ccccc1', { mode: 'substructure' });

  expect(found.results.map((result) => result.entryId)).toStrictEqual([1, 8]);
});
