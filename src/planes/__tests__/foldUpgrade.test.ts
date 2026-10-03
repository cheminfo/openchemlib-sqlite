import type { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import type { MoleculesDBSQLite } from '../../MoleculesDBSQLite.ts';
import { installScanDeadline } from '../../utils/scanDeadline.ts';
import { buildFoldReadSql } from '../foldRead.ts';
import { START_CURSOR, readFoldState } from '../foldState.ts';
import {
  SLOT_TABLE,
  TAIL_TABLE,
  buildPlaneSchemaSqlV5,
} from '../planeSchema.ts';
import { buildUnfoldedSql } from '../unfoldedPrescreen.ts';
import { WATERMARK_TRIGGERS } from '../watermarkSchema.ts';

import { add, emptyLibrary, expectSameAsColumn } from './fixture.ts';

const SMILES = ['Oc1ccccc1', 'Cc1ccccc1', 'CCO', 'C1CCCCC1', 'O=C(N)c1ccccc1'];

/**
 * Turn a database back into what version 5 left: no fold table, a tail filled
 * by a trigger copying every insert, and version 5 recorded as the last.
 * @param db - The connection.
 */
function rewindToVersion5(db: DatabaseSync) {
  for (const trigger of WATERMARK_TRIGGERS) db.exec(`DROP TRIGGER ${trigger}`);
  db.exec('DROP TABLE ocl_ss_fold');
  db.exec('DELETE FROM ocl_ss_schema WHERE version > 5');
  db.exec(buildPlaneSchemaSqlV5({ entriesTable: 'molecules', pkColumn: 'id' }));
}

/**
 * Add molecules under the next ids.
 * @param db - The connection.
 * @param molDB - The molecules DB.
 * @param smiles - The molecules.
 */
function addAll(db: DatabaseSync, molDB: MoleculesDBSQLite, smiles: string[]) {
  for (const one of smiles) add(db, molDB, one);
}

/**
 * The names of the tables, indexes and triggers about the tail.
 * @param db - The connection.
 * @returns Them, sorted.
 */
function tailObjects(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE name LIKE '%tail%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * The entry ids the slot table holds.
 * @param db - The connection.
 * @returns Them, ascending.
 */
function slotted(db: DatabaseSync): number[] {
  const rows = db
    .prepare(`SELECT entry_id FROM ${SLOT_TABLE} ORDER BY entry_id`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => Number(row.entry_id));
}

/**
 * The plan SQLite picks for a statement, one step per line.
 * @param db - The connection.
 * @param query - The statement and its parameters.
 * @param query.sql - The statement.
 * @param query.params - Its parameters.
 * @returns The plan's details.
 */
function planOf(db: DatabaseSync, query: { sql: string; params: unknown[] }) {
  const rows = db
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .all(...(query.params as never[])) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join('\n');
}

test('a version 5 database never folded drops its tail on upgrade', () => {
  const { db, molDB } = emptyLibrary();
  rewindToVersion5(db);
  addAll(db, molDB, SMILES);

  expect(tailObjects(db)).toStrictEqual([
    'idx_ocl_ss_tail_entry',
    'ocl_ss_tail',
    'ocl_ss_tail_insert',
  ]);
  expect(molDB.migrate()).toStrictEqual([6]);
  expect(tailObjects(db)).toStrictEqual([]);
  expect(molDB.planeStatus()).toStrictEqual({
    folded: 0,
    segments: 0,
    watermark: null,
    pending: 5,
    refoldAdvisable: false,
  });

  addAll(db, molDB, ['Clc1ccccc1']);

  expect(molDB.foldPlanes()).toMatchObject({ folded: 6, pending: false });
  expect(readFoldState(db).watermark).toBe(6);
});

test('a version 5 database already folded starts below what its tail holds', () => {
  const { db, molDB } = emptyLibrary();
  addAll(db, molDB, SMILES);
  molDB.foldPlanes({ maxPopulationRatio: 1 });
  rewindToVersion5(db);
  // What version 5 had not folded yet: a new entry, and entry 2 inserted again
  // with another fingerprint, its old bits still in the planes.
  addAll(db, molDB, ['Clc1ccccc1']);
  add(db, molDB, 'Oc1ccccc1C', 2);

  const tail = db
    .prepare(`SELECT entry_id FROM ${TAIL_TABLE} ORDER BY entry_id`)
    .all() as Array<Record<string, unknown>>;

  expect(tail.map((row) => Number(row.entry_id))).toStrictEqual([2, 6]);
  expect(molDB.migrate()).toStrictEqual([6]);
  expect(tailObjects(db)).toStrictEqual([]);
  expect(molDB.planeStatus()).toStrictEqual({
    folded: 5,
    segments: 1,
    watermark: 1,
    pending: 5,
    refoldAdvisable: true,
  });
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([1, 2]);

  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 5,
    pending: false,
  });
  expect(readFoldState(db).watermark).toBe(6);
  expect(expectSameAsColumn(db, 'Oc1ccccc1')).toStrictEqual([1, 2]);
});

test('an entry no published slot stands for keeps the watermark below it', () => {
  const { db, molDB } = emptyLibrary();
  addAll(db, molDB, SMILES);
  molDB.foldPlanes({ maxPopulationRatio: 1 });
  rewindToVersion5(db);
  // What a version 5 fold split over calls could leave: an entry never folded,
  // which only the column path still found.
  db.exec(`DELETE FROM ${SLOT_TABLE} WHERE entry_id = 3`);

  expect(molDB.migrate()).toStrictEqual([6]);
  expect(readFoldState(db).watermark).toBe(2);
});

test('a slot whose entry has left the index is dropped on upgrade', () => {
  const { db, molDB } = emptyLibrary();
  addAll(db, molDB, SMILES);
  molDB.foldPlanes({ maxPopulationRatio: 1 });
  rewindToVersion5(db);
  // Version 5 never removed a slot with its entry.
  db.exec('DELETE FROM ocl_ss_index WHERE entry_id = 4');

  expect(slotted(db)).toStrictEqual([1, 2, 3, 4, 5]);
  expect(molDB.migrate()).toStrictEqual([6]);
  expect(slotted(db)).toStrictEqual([1, 2, 3, 5]);
  expect(readFoldState(db).watermark).toBe(5);

  // Id 4 given again is new to the planes, and lowers the watermark.
  molDB.insert(4, OCL.Molecule.fromSmiles('C1CCCCC1').getIDCode());

  expect(readFoldState(db).watermark).toBe(3);
});

test('a fold reads one chunk of range through the entry index, more in clustered order', () => {
  const { db } = emptyLibrary();
  const read = (indexed: boolean, after: number | null) =>
    planOf(
      db,
      buildFoldReadSql({ after, through: 10, indexed }, START_CURSOR, 5),
    );

  // The first fold streams the clustered key from the cursor.
  expect(read(false, null)).toContain(
    'SEARCH ocl_ss_index USING PRIMARY KEY ((mw,entry_id)>(?,?))',
  );
  expect(read(true, 5)).toContain(
    'SEARCH ocl_ss_index USING INDEX idx_ocl_ss_entry (entry_id>? AND entry_id<?)',
  );
  // A larger range stays in clustered order, and needs no sort.
  expect(read(false, 5)).not.toContain('idx_ocl_ss_entry');
  expect(read(false, 5)).not.toContain('TEMP B-TREE');
});

test('the entries above the watermark are sought on the entry index', () => {
  const { db } = emptyLibrary();
  installScanDeadline(db);
  const mol = OCL.Molecule.fromSmiles('Oc1ccccc1');
  mol.setFragment(true);
  const params = {
    entriesTable: 'molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    mol,
  };

  expect(planOf(db, buildUnfoldedSql(params, 5, Date.now()))).toContain(
    'SEARCH s USING INDEX idx_ocl_ss_entry (entry_id>?)',
  );
});
