import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../MoleculesDBSQLite.ts';
import type { MigrationEvent } from '../types.ts';

const KETO = 'CC(=O)CC(=O)C';
const ENOL = 'CC(O)=CC(=O)C';

/**
 * A database holding two tautomers, opened under a given ceiling.
 * @param db - The connection, so several instances can share one database.
 * @param maxTautomers - The ceiling this instance is configured with.
 * @param onMigration - Log callback, to observe a rebuild.
 * @returns The configured instance.
 */
function open(
  db: DatabaseSync,
  maxTautomers?: number,
  onMigration?: (event: MigrationEvent) => void,
) {
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 2,
    ...(maxTautomers === undefined ? {} : { maxTautomers }),
  });
  molDB.migrate({ onMigration });
  return molDB;
}

/**
 * A fresh database with the two tautomers indexed.
 * @returns The connection.
 */
function seed(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL)',
  );
  const molDB = open(db);
  const insert = db.prepare('INSERT INTO molecules (id_code) VALUES (?)');
  for (const smiles of [KETO, ENOL]) {
    const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
    const { lastInsertRowid } = insert.run(idCode);
    molDB.insert(Number(lastInsertRowid), idCode);
  }
  return db;
}

const count = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('the ceiling is recorded when the hashes are built', () => {
  const db = seed();
  open(db, 4000);

  const row = db
    .prepare("SELECT value FROM ocl_ss_settings WHERE name = 'maxTautomers'")
    .get() as { value: string };

  expect(row.value).toBe('4000');
});

test('changing the ceiling rebuilds the tautomer hashes, and only those', async () => {
  const db = seed();
  const first = open(db, 4000);
  await first.backfillHashes();
  await first.close();

  expect(count(db, 'ocl_no_stereo_hash')).toBe(2);
  expect(count(db, 'ocl_no_stereo_tautomer_hash')).toBe(2);

  const events: MigrationEvent[] = [];
  const second = open(db, 1000, (event) => events.push(event));

  // the tautomer table is emptied, because which molecules have one depends on
  // the ceiling; the no-stereo table enumerates nothing and is left alone
  expect(count(db, 'ocl_no_stereo_tautomer_hash')).toBe(0);
  expect(count(db, 'ocl_no_stereo_hash')).toBe(2);
  expect(events.map((event) => event.description)).toStrictEqual([
    'rebuild ocl_no_stereo_tautomer_hash: maxTautomers 4000 -> 1000',
  ]);

  // and a backfill fills it again under the new ceiling
  await second.backfillHashes();

  expect(count(db, 'ocl_no_stereo_tautomer_hash')).toBe(2);

  await second.close();
});

test('reopening under the same ceiling rebuilds nothing', async () => {
  const db = seed();
  const first = open(db, 4000);
  await first.backfillHashes();
  await first.close();

  const events: MigrationEvent[] = [];
  const second = open(db, 4000, (event) => events.push(event));

  expect(count(db, 'ocl_no_stereo_tautomer_hash')).toBe(2);
  expect(events).toStrictEqual([]);

  await second.close();
});

test('a fresh database records the ceiling without reporting a rebuild', () => {
  const db = seed();
  const events: MigrationEvent[] = [];
  open(db, 2500, (event) => events.push(event));

  expect(events).toStrictEqual([]);
  expect(
    (
      db
        .prepare(
          "SELECT value FROM ocl_ss_settings WHERE name = 'maxTautomers'",
        )
        .get() as { value: string }
    ).value,
  ).toBe('2500');
});

test('the ceiling is a work bound, so the same molecule always gives the same answer', async () => {
  const db = seed();
  const molDB = open(db, 1000);
  await molDB.backfillHashes();

  const read = db.prepare(
    'SELECT hash FROM ocl_no_stereo_tautomer_hash ORDER BY entry_id',
  );
  read.setReadBigInts(true);
  const first = (read.all() as Array<{ hash: bigint | null }>).map(
    (row) => row.hash,
  );

  // the two are tautomers of one compound, so they share a hash
  expect(first[0]).toStrictEqual(first[1]);
  expect(first[0]).not.toBeNull();

  // recomputing under the same ceiling reproduces it exactly
  const search = await molDB.search(KETO, {
    mode: 'exactNoStereoTautomer',
    format: 'smiles',
  });

  expect(search.total).toBe(2);

  await molDB.close();
});
