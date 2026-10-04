import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { foldPlanes } from '../foldPlanes.ts';
import { readFoldState } from '../foldState.ts';
import { planeCoverage } from '../planeCoverage.ts';
import { TAIL_TABLE } from '../planeSchema.ts';
import { WATERMARK_TRIGGERS } from '../watermarkSchema.ts';

import {
  SPACED_SMILES,
  add,
  emptyLibrary,
  expectSameAsColumn,
  foldedLibrary as folded,
  slotsOf,
} from './fixture.ts';

test('migrate creates the plane tables, the columns record and the triggers, and no tail', () => {
  const { db } = emptyLibrary();
  const names = (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE name LIKE 'ocl_ss_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);

  expect(names).toStrictEqual([
    'ocl_ss_bits_stale',
    'ocl_ss_bitstat',
    'ocl_ss_columns',
    'ocl_ss_fold',
    'ocl_ss_index',
    'ocl_ss_plane',
    'ocl_ss_schema',
    'ocl_ss_segment',
    'ocl_ss_settings',
    'ocl_ss_slot',
    'ocl_ss_watermark_delete',
    'ocl_ss_watermark_insert',
    'ocl_ss_watermark_replace',
    'ocl_ss_watermark_update',
  ]);
  expect(names).not.toContain(TAIL_TABLE);
});

test('a fold seeds from ocl_ss_index, records one segment and moves the watermark', () => {
  const { db, molDB } = emptyLibrary();
  for (const smiles of SPACED_SMILES) add(db, molDB, smiles);

  expect(readFoldState(db).watermark).toBeNull();

  expect(foldPlanes(db)).toMatchObject({
    folded: SPACED_SMILES.length,
    chunks: 1,
    pending: false,
  });
  expect(planeCoverage(db)).toStrictEqual({
    segments: 1,
    slots: SPACED_SMILES.length,
  });
  expect(readFoldState(db)).toStrictEqual({
    watermark: SPACED_SMILES.length,
    bound: SPACED_SMILES.length,
    cursor: null,
    segment: null,
  });
});

test('migrate puts the watermark triggers back when a rebuild has dropped them', () => {
  const { db, molDB } = folded();
  // SQLite drops a trigger with the table it watches, which is what any future
  // migration rebuilding ocl_ss_index would do.
  for (const trigger of WATERMARK_TRIGGERS) db.exec(`DROP TRIGGER ${trigger}`);

  expect(molDB.migrate()).toStrictEqual([]);

  // Id 5 is below the watermark: only the trigger can say the planes miss it.
  add(db, molDB, 'Brc1ccccc1', 5);

  expect(readFoldState(db).watermark).toBe(4);
});

test('a caller writing ocl_ss_index itself is checked too', () => {
  const { db } = folded();
  const words = [
    ...new BigInt64Array(
      new Uint32Array(OCL.Molecule.fromSmiles('C1CCNCC1').getIndex()).buffer,
    ),
  ];
  const fingerprint = words
    .map((word, index) => `ss_index${index} = ${word}`)
    .join(', ');

  // A weight changed in place changes nothing the planes hold.
  db.exec('UPDATE ocl_ss_index SET mw = mw + 1 WHERE entry_id = 60');

  expect(readFoldState(db).watermark).toBe(80);

  db.exec(`UPDATE ocl_ss_index SET ${fingerprint} WHERE entry_id = 70`);

  expect(readFoldState(db).watermark).toBe(69);

  // An entry id moved in place loses its slot.
  db.prepare(
    'INSERT INTO molecules (id, id_code) SELECT 5, id_code FROM molecules WHERE id = 40',
  ).run();
  db.exec('UPDATE ocl_ss_index SET entry_id = 5 WHERE entry_id = 40');

  expect(slotsOf(db, 40)).toBe(0);
  expect(readFoldState(db).watermark).toBe(4);

  db.exec('DELETE FROM ocl_ss_index WHERE entry_id = 50');

  expect(slotsOf(db, 50)).toBe(0);
  expect(expectSameAsColumn(db, 'C1CCNCC1')).toStrictEqual([70]);
  expect(expectSameAsColumn(db, 'NS(=O)(=O)c1ccccc1')).toStrictEqual([5]);
});

test('with recursive triggers on, a replace stays exact', () => {
  const { db, molDB } = folded();
  db.exec('PRAGMA recursive_triggers = ON');
  // The replace's delete fires the delete trigger, which takes the slot: the
  // insert then finds the entry unfolded, and the watermark goes below it.
  molDB.insert(70, OCL.Molecule.fromSmiles('Oc1ccc(Cl)cc1').getIDCode());

  expect(slotsOf(db, 70)).toBe(0);
  expect(readFoldState(db).watermark).toBe(69);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([10, 70, 80]);
});
