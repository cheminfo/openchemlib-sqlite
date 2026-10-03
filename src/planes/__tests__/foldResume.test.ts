import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test, vi } from 'vitest';

import { MoleculesDBSQLite } from '../../MoleculesDBSQLite.ts';
import type { PrescreenState } from '../../utils/prescreen.ts';
import { prescreen } from '../../utils/prescreen.ts';
import { readFoldState } from '../foldState.ts';
import type * as PlaneLayout from '../planeLayout.ts';
import { TAIL_TABLE } from '../planeSchema.ts';

// Chunks of four slots, so a handful of molecules spans several chunks and a
// fold can be split over calls.
vi.mock('../planeLayout.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof PlaneLayout>()),
  SLOTS_PER_CHUNK: 4,
  CHUNK_BYTES: 1,
}));

const SMILES = [
  'Oc1ccccc1',
  'Cc1ccccc1',
  'O=C(N)c1ccccc1',
  'NS(=O)(=O)c1ccccc1',
  'CCO',
  'C1CCCCC1',
  'Oc1ccc(O)cc1',
  'CC(=O)Oc1ccccc1C(=O)O',
  'Oc1ccc(N)cc1',
  'CCCCO',
];

/**
 * A library of entries 1 to 10, not folded yet.
 * @returns The connection and the molecules DB.
 */
function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)',
  );
  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    planeCandidateRatio: 1,
  });
  molDB.migrate();
  for (const smiles of SMILES) add(db, molDB, smiles);
  return { db, molDB };
}

/**
 * Add a molecule to the entries table and the index.
 * @param db - The connection.
 * @param molDB - The molecules DB.
 * @param smiles - The molecule.
 * @param id - The id to give it; the next one when omitted.
 */
function add(
  db: DatabaseSync,
  molDB: MoleculesDBSQLite,
  smiles: string,
  id?: number,
) {
  const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
  const { lastInsertRowid } =
    id === undefined
      ? db.prepare('INSERT INTO molecules (id_code) VALUES (?)').run(idCode)
      : db
          .prepare('INSERT INTO molecules (id, id_code) VALUES (?, ?)')
          .run(id, idCode);
  molDB.insert(Number(lastInsertRowid), idCode);
}

/**
 * The phenol candidates the prescreen yields.
 * @param db - The connection.
 * @param planeIndex - Whether the plane index may answer.
 * @returns The candidate ids, ascending with any repeat kept, and the path.
 */
function phenols(db: DatabaseSync, planeIndex = true) {
  const mol = OCL.Molecule.fromSmiles('Oc1ccccc1');
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

test('a fold split over calls resumes where it stopped, in one segment', () => {
  const { db, molDB } = seed();
  const fold = () => molDB.foldPlanes({ maxPopulationRatio: 1, maxChunks: 1 });

  expect(fold()).toMatchObject({ folded: 4, chunks: 1, pending: true });
  expect(readFoldState(db)).toMatchObject({
    foldedThrough: null,
    tailThrough: 10,
    segment: 1,
  });

  // Arriving between two calls: 11 above the fold's bound, left to the next
  // fold; 0 below it, copied in case the fold has read past it.
  add(db, molDB, 'Clc1ccccc1');
  add(db, molDB, 'Oc1ccc(Br)cc1', 0);

  expect(tailIds(db)).toStrictEqual([0]);

  const midFold = phenols(db);

  expect(midFold.usedPlaneIndex).toBe(true);
  expect(midFold.ids).toStrictEqual(phenols(db, false).ids);

  // Bounded, so a fold that stopped making progress fails instead of hanging.
  const foldedPerCall: number[] = [];
  for (let call = 0; call < 10; call++) {
    const result = fold();
    foldedPerCall.push(result.folded);
    if (!result.pending) break;
  }

  // The first fold's last two chunks, 0 among them, then 11 on its own.
  expect(foldedPerCall).toStrictEqual([4, 3, 1]);
  expect(molDB.planeStatus()).toStrictEqual({
    folded: 12,
    segments: 2,
    pending: 0,
    tail: 0,
  });
  expect(phenols(db)).toStrictEqual({
    ids: [0, 1, 7, 8, 9],
    usedPlaneIndex: true,
  });
});

test('a range wider than a chunk is folded in clustered order, one narrower through the index', () => {
  const { db, molDB } = seed();
  molDB.foldPlanes({ maxPopulationRatio: 1 });
  for (const smiles of ['Oc1ccccc1C', 'Oc1ccccc1CC', 'Oc1ccccc1Cl']) {
    add(db, molDB, smiles);
  }
  for (const smiles of ['Oc1ccccc1F', 'Oc1ccccc1N', 'Oc1ccccc1Br']) {
    add(db, molDB, smiles);
  }

  // Six waiting, over a chunk of four.
  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 6,
    chunks: 2,
    pending: false,
  });

  add(db, molDB, 'Oc1ccccc1I');

  expect(molDB.foldPlanes({ maxPopulationRatio: 1 })).toMatchObject({
    folded: 1,
    pending: false,
  });
  expect(molDB.planeStatus()).toStrictEqual({
    folded: 17,
    segments: 3,
    pending: 0,
    tail: 0,
  });
  expect(phenols(db).ids).toStrictEqual(phenols(db, false).ids);
});
