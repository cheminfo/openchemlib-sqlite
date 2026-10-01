import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../../MoleculesDBSQLite.ts';
import { buildPrescreenSql } from '../../utils/prescreen.ts';
import { foldPlanes } from '../foldPlanes.ts';
import { bitsOfIndex, countBits, readBit, setBit } from '../planeLayout.ts';
import {
  planeChunks,
  planeCoverage,
  planeQueryBits,
  prescreenPlanes,
} from '../planePrescreen.ts';
import {
  BITSTAT_TABLE,
  PLANE_TABLE,
  SLOT_TABLE,
  TAIL_TABLE,
} from '../planeSchema.ts';
import { nextSlotOf } from '../planeState.ts';

const SMILES = [
  'CC(=O)Oc1ccccc1C(=O)O',
  'Cn1cnc2c1c(=O)n(C)c(=O)n2C',
  'Oc1ccc(CCN)cc1',
  'c1ccccc1',
  'Oc1ccccc1',
  'O=C(N)c1ccccc1',
  'CCO',
  'C1CCCCC1',
  'Fc1ccc(-c2ccccc2)cc1',
  'OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O',
];

/**
 * A ten-molecule library, migrated to the current schema.
 * @returns The connection and the molecules DB wrapping it.
 */
function makeDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    `CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)`,
  );
  const molDB = new MoleculesDBSQLite(db, OCL, { entriesTable: 'molecules' });
  molDB.migrate();
  for (const smiles of SMILES) {
    const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO molecules (id_code) VALUES (?)')
      .run(idCode);
    molDB.insert(Number(lastInsertRowid), idCode);
  }
  return { db, molDB };
}

/**
 * The candidate ids the column path yields, as the reference answer.
 * @param db - The database to read.
 * @param fragment - The query fragment, as SMILES.
 * @returns The candidate entry ids, ascending.
 */
function columnCandidates(db: DatabaseSync, fragment: string): number[] {
  const mol = OCL.Molecule.fromSmiles(fragment);
  mol.setFragment(true);
  const query = buildPrescreenSql({
    entriesTable: 'molecules',
    pkColumn: 'id',
    idCodeColumn: 'id_code',
    mol,
  });
  const rows = db.prepare(query.sql).all(...(query.params as never[])) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => Number(row.entry_id)).toSorted((a, b) => a - b);
}

/**
 * The candidate ids the plane path yields.
 * @param db - The database to read.
 * @param fragment - The query fragment, as SMILES.
 * @returns The candidate entry ids, ascending.
 */
function planeCandidates(db: DatabaseSync, fragment: string): number[] {
  const mol = OCL.Molecule.fromSmiles(fragment);
  mol.setFragment(true);
  const bits = planeQueryBits(db, mol.getIndex());
  if (bits === null) return [];
  const state = { screened: 0, partial: false };
  const found = [
    ...prescreenPlanes(
      {
        db,
        entriesTable: 'molecules',
        pkColumn: 'id',
        idCodeColumn: 'id_code',
        mol,
        timeoutMs: 10_000,
        maxCandidates: Number.MAX_SAFE_INTEGER,
      },
      state,
      bits,
    ),
  ];
  return found.map((entry) => entry.entryId).toSorted((a, b) => a - b);
}

test('migration 5 creates the plane tables and the tail trigger', () => {
  const { db } = makeDB();
  const names = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'ocl_ss_%'`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name);

  expect(names).toContain(PLANE_TABLE);
  expect(names).toContain(TAIL_TABLE);
  expect(names).toContain('ocl_ss_tail_insert');
});

test('the trigger puts every inserted fingerprint in the tail', () => {
  const { db } = makeDB();
  const { n } = db
    .prepare(`SELECT COUNT(*) AS n FROM ${TAIL_TABLE}`)
    .get() as Record<string, unknown>;

  expect(Number(n)).toBe(SMILES.length);
});

test('a fold seeds from ocl_ss_index, empties the tail and records one segment', () => {
  const { db } = makeDB();
  const result = foldPlanes(db);

  expect(result.folded).toBe(SMILES.length);
  expect(result.chunks).toBe(1);
  expect(result.pending).toBe(false);
  expect(planeCoverage(db)).toStrictEqual({
    segments: 1,
    slots: SMILES.length,
  });

  const { n } = db
    .prepare(`SELECT COUNT(*) AS n FROM ${TAIL_TABLE}`)
    .get() as Record<string, unknown>;

  expect(Number(n)).toBe(0);
});

const FRAGMENTS = [
  'c1ccccc1',
  'Oc1ccccc1',
  'O=C(N)c1ccccc1',
  'CCO',
  'C1CCCCC1',
];

test('with every plane stored, the plane path matches the column path exactly', () => {
  const { db } = makeDB();
  foldPlanes(db, { maxPopulationRatio: 1 });
  for (const fragment of FRAGMENTS) {
    expect(planeCandidates(db, fragment)).toStrictEqual(
      columnCandidates(db, fragment),
    );
  }
});

test('dropping the common planes still answers exactly, or declines the query', () => {
  const { db } = makeDB();
  foldPlanes(db, { maxPopulationRatio: 0.5 });
  let screened = 0;
  for (const fragment of FRAGMENTS) {
    const mol = OCL.Molecule.fromSmiles(fragment);
    mol.setFragment(true);
    // A fragment whose every bit was dropped as too common gets no screen at
    // all, which is what sends it to the column path. One that does get a
    // screen must still be exactly right, because every survivor is checked
    // against its stored 512-bit fingerprint.
    if (planeQueryBits(db, mol.getIndex()) === null) continue;
    screened++;

    expect(planeCandidates(db, fragment)).toStrictEqual(
      columnCandidates(db, fragment),
    );
  }

  expect(screened).toBeGreaterThan(0);
});

test('benzene is too common to screen in a library this small', () => {
  const { db } = makeDB();
  foldPlanes(db, { maxPopulationRatio: 0.5 });
  const mol = OCL.Molecule.fromSmiles('c1ccccc1');
  mol.setFragment(true);

  expect(planeQueryBits(db, mol.getIndex())).toBeNull();
});

test('an entry inserted after a fold is folded by the next one', () => {
  const { db, molDB } = makeDB();
  foldPlanes(db, { maxPopulationRatio: 1 });
  const idCode = OCL.Molecule.fromSmiles('Clc1ccc(O)cc1').getIDCode();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO molecules (id_code) VALUES (?)')
    .run(idCode);
  molDB.insert(Number(lastInsertRowid), idCode);

  expect(planeCandidates(db, 'Oc1ccccc1')).not.toContain(
    Number(lastInsertRowid),
  );

  const second = foldPlanes(db, { maxPopulationRatio: 1 });

  expect(second.folded).toBe(1);
  expect(planeCoverage(db).segments).toBe(2);
  expect(planeCandidates(db, 'Oc1ccccc1')).toContain(Number(lastInsertRowid));
});

test('only selective bits get a plane', () => {
  const { db } = makeDB();
  foldPlanes(db, { maxPopulationRatio: 0.5 });
  const rows = db
    .prepare(
      `SELECT stored, COUNT(*) AS n FROM ${BITSTAT_TABLE} GROUP BY stored`,
    )
    .all() as Array<Record<string, unknown>>;
  const dropped = rows.find((row) => Number(row.stored) === 0);

  expect(dropped).toBeDefined();
  expect(Number(dropped?.n)).toBeGreaterThan(0);
});

test('bit helpers round-trip a fingerprint', () => {
  const index = OCL.Molecule.fromSmiles('Oc1ccccc1').getIndex();
  const positions = bitsOfIndex(index);
  const blob = new Uint8Array(64);
  for (const bit of positions) setBit(blob, bit);

  expect(countBits(blob)).toBe(positions.length);

  for (const bit of positions) expect(readBit(blob, bit)).toBe(true);
});

test('migrate puts the tail trigger back when a rebuild has dropped it', () => {
  const { db, molDB } = makeDB();
  // SQLite drops a trigger with the table it watches, which is what any future
  // migration rebuilding ocl_ss_index would do.
  db.exec('DROP TRIGGER ocl_ss_tail_insert');

  expect(molDB.migrate()).toStrictEqual([]);

  const idCode = OCL.Molecule.fromSmiles('Brc1ccccc1').getIDCode();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO molecules (id_code) VALUES (?)')
    .run(idCode);
  molDB.insert(Number(lastInsertRowid), idCode);

  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${TAIL_TABLE} WHERE entry_id = ?`)
    .get(Number(lastInsertRowid)) as Record<string, unknown>;

  expect(Number(row.n)).toBe(1);
});

test('a chunk no segment covers is invisible to a search', () => {
  const { db } = makeDB();
  foldPlanes(db, { maxPopulationRatio: 1 });
  const published = planeChunks(db);

  // What an interrupted fold leaves behind: planes written, segment not yet
  // extended. Read from ocl_ss_plane this would answer as a complete chunk and
  // return false negatives, because a missing plane row means "no entry here
  // sets this bit".
  db.prepare(
    `INSERT INTO ${PLANE_TABLE} (chunk, bit, bits) VALUES (?, ?, ?)`,
  ).run(99, 0, new Uint8Array(16));

  expect(planeChunks(db)).toStrictEqual(published);
});

test('the slots of an abandoned chunk are written over, not skipped', () => {
  const { db } = makeDB();
  foldPlanes(db, { maxPopulationRatio: 1 });
  const next = nextSlotOf(db);

  // Orphan slots, as an interrupted fold leaves: past the published slots but
  // covered by no segment. The entry has to be real — the slot table references
  // the entries table and foreign keys are enforced.
  const { lastInsertRowid } = db
    .prepare('INSERT INTO molecules (id_code) VALUES (?)')
    .run(OCL.Molecule.fromSmiles('Ic1ccccc1').getIDCode());
  db.prepare(`INSERT INTO ${SLOT_TABLE} (slot, entry_id) VALUES (?, ?)`).run(
    next + 500,
    Number(lastInsertRowid),
  );

  expect(nextSlotOf(db)).toBe(next);
});

test('pausing between transactions changes nothing but the pace', () => {
  const paced = makeDB();
  foldPlanes(paced.db, { maxPopulationRatio: 1, pauseMs: 1 });
  const flat = makeDB();
  foldPlanes(flat.db, { maxPopulationRatio: 1 });

  expect(planeCandidates(paced.db, 'Oc1ccccc1')).toStrictEqual(
    planeCandidates(flat.db, 'Oc1ccccc1'),
  );
  expect(planeCoverage(paced.db)).toStrictEqual(planeCoverage(flat.db));
});
