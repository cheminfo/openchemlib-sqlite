import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { readFoldState } from '../foldState.ts';

import {
  add,
  expectSameAsColumn,
  foldedLibrary as folded,
  planeSnapshot,
  slotsOf,
} from './fixture.ts';

test('increasing inserts above the watermark never touch the planes', () => {
  const { db, molDB } = folded();
  const before = planeSnapshot(db);

  add(db, molDB, 'Oc1ccc(Br)cc1', 90);
  add(db, molDB, 'Oc1ccc(I)cc1', 100);
  add(db, molDB, 'CCCC', 110);

  expect(planeSnapshot(db)).toBe(before);
  expect(molDB.planeStatus()).toStrictEqual({
    folded: 8,
    segments: 1,
    watermark: 80,
    pending: 3,
    refoldAdvisable: false,
  });
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([
    10, 70, 80, 90, 100,
  ]);

  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 3,
    pending: false,
  });
  expect(readFoldState(db).watermark).toBe(110);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([
    10, 70, 80, 90, 100,
  ]);
});

test('an out-of-order insert is found, and lowers the watermark until a fold raises it', () => {
  const { db, molDB } = folded();
  add(db, molDB, 'Oc1ccc(Br)cc1', 35);

  expect(molDB.planeStatus()).toStrictEqual({
    folded: 8,
    segments: 1,
    watermark: 34,
    pending: 6,
    refoldAdvisable: true,
  });
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([10, 35, 70, 80]);

  // Everything above the new watermark is folded again: 35 and 40 to 80.
  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 6,
    pending: false,
  });
  expect(molDB.planeStatus()).toStrictEqual({
    folded: 14,
    segments: 2,
    watermark: 80,
    pending: 0,
    refoldAdvisable: false,
  });
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([10, 35, 70, 80]);
});

test('an entry inserted again with another fingerprint is found by its new one only', async () => {
  const { db, molDB } = folded();
  // Entry 10 is phenol, and its bits stay in the planes.
  add(db, molDB, 'C1CCNCC1', 10);

  expect(readFoldState(db).watermark).toBe(9);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([70, 80]);
  expect(expectSameAsColumn(db, 'C1CCNCC1')).toStrictEqual([10]);

  molDB.foldPlanes({ maxPopulationRatio: 1 });

  expect(readFoldState(db).watermark).toBe(80);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([70, 80]);
  expect(expectSameAsColumn(db, 'C1CCNCC1')).toStrictEqual([10]);

  const found = await molDB.search('C1CCNCC1', { mode: 'substructure' });

  expect(found.results.map((result) => result.entryId)).toStrictEqual([10]);
});

test('an entry inserted again with the same fingerprint leaves the watermark alone', () => {
  const { db, molDB } = folded();
  const before = planeSnapshot(db);
  molDB.insert(30, OCL.Molecule.fromSmiles('O=C(N)c1ccccc1').getIDCode());

  expect(planeSnapshot(db)).toBe(before);
  expect(readFoldState(db).watermark).toBe(80);
});

test('a removed entry is never returned, and leaves the watermark alone', async () => {
  const { db, molDB } = folded();
  molDB.remove(10);
  db.prepare('DELETE FROM molecules WHERE id = 10').run();

  expect(slotsOf(db, 10)).toBe(0);
  expect(readFoldState(db).watermark).toBe(80);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([70, 80]);

  const found = await molDB.search('Oc1ccccc1', { mode: 'substructure' });

  expect(found.results.map((result) => result.entryId)).toStrictEqual([70, 80]);
});

test('an id given again after its entry was removed answers for its new structure only', () => {
  const { db, molDB } = folded();
  molDB.remove(10);
  db.prepare('DELETE FROM molecules WHERE id = 10').run();
  add(db, molDB, 'C1CCNCC1', 10);

  expect(readFoldState(db).watermark).toBe(9);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([70, 80]);
  expect(expectSameAsColumn(db, 'C1CCNCC1')).toStrictEqual([10]);
});

test('an id written mid-fold between the watermark and the bound is not lost', () => {
  const { db, molDB } = folded();
  add(db, molDB, 'Oc1ccc(Cl)cc1C', 90);
  add(db, molDB, 'Oc1ccc(Br)cc1', 110);
  // Entry 100 arrives while the fold writes the chunk it has already read:
  // after it took 90 and 110, before it moves the watermark from 80 to 110.
  const mol = OCL.Molecule.fromSmiles('Oc1ccc(I)cc1');
  const words = new BigInt64Array(new Uint32Array(mol.getIndex()).buffer);
  db.exec(`
    CREATE TEMP TRIGGER mid_fold AFTER INSERT ON ocl_ss_slot
    WHEN NEW.entry_id = 110
    BEGIN
      INSERT INTO molecules (id, id_code) VALUES (100, '${mol.getIDCode()}');
      INSERT INTO ocl_ss_index (mw, entry_id, ss_index0, ss_index1, ss_index2,
        ss_index3, ss_index4, ss_index5, ss_index6, ss_index7)
      VALUES (${mol.getMolecularFormula().relativeWeight}, 100, ${[...words].join(', ')});
    END;`);

  // The fold may have read past 100, so it stops the watermark below it.
  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 2,
    pending: true,
  });
  expect(readFoldState(db).watermark).toBe(99);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([
    10, 70, 80, 90, 100, 110,
  ]);

  db.exec('DROP TRIGGER mid_fold');

  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 2,
    pending: false,
  });
  expect(readFoldState(db).watermark).toBe(110);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([
    10, 70, 80, 90, 100, 110,
  ]);
});

test('an entry removed mid-fold is given no slot', () => {
  const { db, molDB } = folded();
  add(db, molDB, 'Oc1ccc(Br)cc1', 90);
  add(db, molDB, 'Oc1ccc(I)cc1', 100);
  // The fold has read 90 and 100 when 100 leaves the index.
  db.exec(`
    CREATE TEMP TRIGGER mid_fold AFTER INSERT ON ocl_ss_slot
    WHEN NEW.entry_id = 90
    BEGIN
      DELETE FROM ocl_ss_index WHERE entry_id = 100;
    END;`);
  molDB.foldPlanes({ maxPopulationRatio: 1 });

  expect(slotsOf(db, 100)).toBe(0);
  expect(readFoldState(db).watermark).toBe(100);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([10, 70, 80, 90]);
});

test('a rebuild folds every entry again, into one segment', () => {
  const { db, molDB } = folded();
  add(db, molDB, 'Oc1ccc(Br)cc1', 35);
  molDB.foldPlanes({ maxPopulationRatio: 1 });

  expect(molDB.planeStatus()).toMatchObject({ folded: 14, segments: 2 });

  expect(
    molDB.foldPlanes({ maxPopulationRatio: 1, rebuild: true }),
  ).toMatchObject({ folded: 9, chunks: 1, pending: false });
  expect(molDB.planeStatus()).toStrictEqual({
    folded: 9,
    segments: 1,
    watermark: 80,
    pending: 0,
    refoldAdvisable: false,
  });
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([10, 35, 70, 80]);
});
