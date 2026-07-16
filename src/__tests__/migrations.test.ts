import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import { SCHEMA_VERSION } from '../migrations.ts';
import type { MigrationEvent } from '../types.ts';

const SMILES = ['CCCc1ccccc1', 'CCc1ccccc1', 'Cc1ccccc1', 'c1ccccc1', 'CCO'];

/**
 * A database exactly as openchemlib-sqlite 2.x left it: ocl_ss_index keyed by
 * entry_id, no mw column, no version table. Rows are inserted heaviest-first so
 * entry_id order is the opposite of molecular-weight order — an upgrade that
 * failed to cluster by mw would still pass a test that only counted rows.
 * @param options - Shape of the legacy database to build.
 * @param options.withMwColumn - Whether the config points at an mw column,
 *   which lets the rebuild take weights from SQL instead of deriving them.
 * @returns The connection and the fingerprints the old schema held.
 */
function legacyDatabase(options: { withMwColumn?: boolean } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ligands (
      id INTEGER PRIMARY KEY,
      id_code TEXT NOT NULL UNIQUE,
      mw REAL
    );
    CREATE TABLE ocl_ss_index (
      entry_id  INTEGER PRIMARY KEY REFERENCES ligands(id),
      ss_index0 INTEGER NOT NULL DEFAULT 0, ss_index1 INTEGER NOT NULL DEFAULT 0,
      ss_index2 INTEGER NOT NULL DEFAULT 0, ss_index3 INTEGER NOT NULL DEFAULT 0,
      ss_index4 INTEGER NOT NULL DEFAULT 0, ss_index5 INTEGER NOT NULL DEFAULT 0,
      ss_index6 INTEGER NOT NULL DEFAULT 0, ss_index7 INTEGER NOT NULL DEFAULT 0
    );
  `);
  const addLigand = db.prepare(
    'INSERT INTO ligands (id_code, mw) VALUES (?, ?) RETURNING id',
  );
  const addIndex = db.prepare(
    `INSERT INTO ocl_ss_index (entry_id, ss_index0, ss_index1, ss_index2,
       ss_index3, ss_index4, ss_index5, ss_index6, ss_index7)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const expected: Array<{ idCode: string; mw: number }> = [];
  for (const smiles of SMILES) {
    const mol = OCL.Molecule.fromSmiles(smiles);
    const idCode = mol.getIDCode();
    const mw = mol.getMolecularFormula().relativeWeight;
    const { id } = addLigand.get(idCode, mw) as { id: number };
    const packed = Array.from(
      new BigInt64Array(new Uint32Array(mol.getIndex()).buffer),
    );
    addIndex.run(id, ...packed);
    expected.push({ idCode, mw });
  }
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'ligands',
    ...(options.withMwColumn ? { mwColumn: 'mw' } : {}),
  });
  return { db, molDB, expected };
}

function schemaOf(db: DatabaseSync): string {
  return (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'ocl_ss_index'")
      .get() as { sql: string }
  ).sql;
}

test('a 2.x database is upgraded in place instead of rejected', async () => {
  const { db, molDB, expected } = legacyDatabase();

  expect(schemaOf(db)).not.toContain('mw');

  const applied = molDB.migrate();

  expect(applied).toStrictEqual([2]);
  expect(schemaOf(db)).toContain('WITHOUT ROWID');

  // The whole point: searching an upgraded database works and is mw-ordered.
  const { results } = await molDB.search('c1ccccc1', { mode: 'substructure' });

  expect(results.map((r) => Math.round(r.mw ?? 0))).toStrictEqual(
    expected
      .filter((e) => e.idCode !== OCL.Molecule.fromSmiles('CCO').getIDCode())
      .map((e) => Math.round(e.mw))
      .toSorted((a, b) => a - b),
  );
});

test('the upgrade carries the fingerprints over rather than recomputing them', () => {
  const { db, molDB } = legacyDatabase();
  // ss_index columns are 64-bit: read them as BigInt or they overflow.
  const read = (): unknown[] => {
    const statement = db.prepare(
      'SELECT entry_id, ss_index0, ss_index7 FROM ocl_ss_index ORDER BY entry_id',
    );
    statement.setReadBigInts(true);
    return statement.all();
  };
  const before = read();

  molDB.migrate();

  expect(read()).toStrictEqual(before);
});

test('migrate is idempotent and does nothing on an already-current database', () => {
  const { molDB } = legacyDatabase();

  expect(molDB.migrate()).toStrictEqual([2]);
  expect(molDB.migrate()).toStrictEqual([]);
  expect(molDB.migrate()).toStrictEqual([]);
});

test('a fresh database walks every migration and records the version', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE ligands (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, { entriesTable: 'ligands' });

  expect(molDB.migrate()).toStrictEqual([1, 2]);

  const recorded = db
    .prepare('SELECT MAX(version) AS version FROM ocl_ss_schema')
    .get() as { version: number };

  expect(recorded.version).toBe(SCHEMA_VERSION);
});

test('the upgrade reports its progress so a slow startup is visible', () => {
  const { molDB } = legacyDatabase();
  const events: MigrationEvent[] = [];

  molDB.migrate({ onMigration: (event) => events.push(event) });

  const phases = events.map((e) => e.phase);

  expect(phases[0]).toBe('start');
  expect(phases.at(-1)).toBe('done');
  expect(events.every((e) => e.version === 2)).toBe(true);
  expect(events.at(-1)?.description).toBe(
    'cluster ocl_ss_index by molecular weight',
  );

  const progress = events.filter((e) => e.phase === 'progress');

  expect(progress.at(-1)).toStrictEqual({
    version: 2,
    description: 'cluster ocl_ss_index by molecular weight',
    phase: 'progress',
    done: SMILES.length,
    total: SMILES.length,
  });
});

test('the upgrade takes mw from the configured column when there is one', async () => {
  // With mwColumn set the rebuild is a pure INSERT ... SELECT — no molecule is
  // parsed — so it must still land the same weights as deriving them.
  const { molDB } = legacyDatabase({ withMwColumn: true });

  molDB.migrate();
  const { results } = await molDB.search('c1ccccc1', { mode: 'substructure' });

  expect(results.map((r) => Math.round(r.mw ?? 0))).toStrictEqual([
    78, 92, 106, 120,
  ]);
});

test('an orphaned fingerprint is dropped by the upgrade, and reported', () => {
  const { db, molDB } = legacyDatabase();
  // Orphan one fingerprint. The foreign key normally forbids this, so a real
  // orphan can only come from a connection that had FK enforcement off — which
  // is SQLite's own default.
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('DELETE FROM ligands WHERE id = 1').run();
  db.exec('PRAGMA foreign_keys = ON');
  const events: MigrationEvent[] = [];

  molDB.migrate({ onMigration: (event) => events.push(event) });

  const orphan = db
    .prepare('SELECT mw FROM ocl_ss_index WHERE entry_id = 1')
    .get();

  // The row could never match anything (the search inner-joins the entries
  // table), so dropping it is cleanup — but it must not be silent.
  expect(orphan).toBeUndefined();
  expect(events.at(-1)?.dropped).toBe(1);
  expect(molDB.count()).toBe(SMILES.length - 1);
});

test('nothing is reported as dropped when there is nothing to drop', () => {
  const { molDB } = legacyDatabase();
  const events: MigrationEvent[] = [];

  molDB.migrate({ onMigration: (event) => events.push(event) });

  expect(events.at(-1)?.dropped).toBeUndefined();
  expect(molDB.count()).toBe(SMILES.length);
});
