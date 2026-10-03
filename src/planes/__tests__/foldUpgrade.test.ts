import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../../MoleculesDBSQLite.ts';
import { buildFoldReadSql } from '../foldRead.ts';
import { START_CURSOR, readFoldState } from '../foldState.ts';
import { TAIL_TABLE, buildTailTriggerSqlV5 } from '../planeSchema.ts';
import { buildUnfoldedSql } from '../unfoldedPrescreen.ts';

const SMILES = ['Oc1ccccc1', 'Cc1ccccc1', 'CCO', 'C1CCCCC1', 'O=C(N)c1ccccc1'];

/**
 * A migrated, empty library.
 * @returns The connection and the molecules DB.
 */
function empty() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, { entriesTable: 'molecules' });
  molDB.migrate();
  return { db, molDB };
}

/**
 * Add molecules to the entries table and the index, under the next ids.
 * @param db - The connection.
 * @param molDB - The molecules DB.
 * @param smiles - The molecules.
 */
function add(db: DatabaseSync, molDB: MoleculesDBSQLite, smiles: string[]) {
  for (const one of smiles) {
    const idCode = OCL.Molecule.fromSmiles(one).getIDCode();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO molecules (id_code) VALUES (?)')
      .run(idCode);
    molDB.insert(Number(lastInsertRowid), idCode);
  }
}

/**
 * Turn a database back into what version 5 left: no fold table, the trigger
 * that copied every insert, and version 5 recorded as the last.
 * @param db - The connection.
 */
function rewindToVersion5(db: DatabaseSync) {
  db.exec(`
    DROP TRIGGER ocl_ss_tail_insert;
    DROP TRIGGER ocl_ss_tail_delete;
    DROP TABLE ocl_ss_fold;
    DELETE FROM ocl_ss_schema WHERE version > 5;`);
  db.exec(buildTailTriggerSqlV5());
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

test('a version 5 database never folded drops its copies on upgrade', () => {
  const { db, molDB } = empty();
  rewindToVersion5(db);
  add(db, molDB, SMILES);

  expect(tailIds(db)).toStrictEqual([1, 2, 3, 4, 5]);
  expect(molDB.migrate()).toStrictEqual([6]);
  expect(tailIds(db)).toStrictEqual([]);
  expect(molDB.planeStatus()).toStrictEqual({
    folded: 0,
    segments: 0,
    pending: 5,
    tail: 0,
  });

  add(db, molDB, ['Clc1ccccc1']);

  expect(tailIds(db)).toStrictEqual([]);
  expect(molDB.foldPlanes()).toMatchObject({ folded: 6, pending: false });
  expect(readFoldState(db).foldedThrough).toBe(6);
});

test('a version 5 database already folded keeps its tail on upgrade', () => {
  const { db, molDB } = empty();
  add(db, molDB, SMILES);
  molDB.foldPlanes();
  rewindToVersion5(db);
  add(db, molDB, ['Clc1ccccc1']);

  expect(tailIds(db)).toStrictEqual([6]);
  expect(molDB.migrate()).toStrictEqual([6]);
  // What version 5 had not folded is in its tail, so the watermark starts at
  // the highest id present.
  expect(tailIds(db)).toStrictEqual([6]);
  expect(readFoldState(db).foldedThrough).toBe(6);
  expect(molDB.planeStatus()).toMatchObject({ pending: 1, tail: 1 });
  expect(molDB.foldPlanes()).toMatchObject({ folded: 1, pending: false });
  expect(tailIds(db)).toStrictEqual([]);
});

test('a fold reads one chunk of range through the entry index, more in clustered order', () => {
  const { db } = empty();
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
  // A larger range stays in clustered order, merged with the tail unsorted.
  expect(read(false, 5)).not.toContain('idx_ocl_ss_entry');
  expect(read(false, 5)).not.toContain('TEMP B-TREE');
});

test('the screen of unfolded entries seeks the range above the watermark', () => {
  const { db } = empty();
  const mol = OCL.Molecule.fromSmiles('Oc1ccccc1');
  mol.setFragment(true);
  const params = {
    entriesTable: 'molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    mol,
  };

  expect(planOf(db, buildUnfoldedSql(params, { after: 5 }))).toContain(
    'SEARCH s USING INDEX idx_ocl_ss_entry (entry_id>?)',
  );
});
