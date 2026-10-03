import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculesDBSQLite } from '../../MoleculesDBSQLite.ts';
import type { PrescreenState } from '../../utils/prescreen.ts';
import { prescreen } from '../../utils/prescreen.ts';
import { choosePrescreenPath } from '../planeRouter.ts';

const SMILES = [
  'c1ccccc1',
  'Cc1ccccc1',
  'Oc1ccccc1',
  'O=C(N)c1ccccc1',
  'Fc1ccc(-c2ccccc2)cc1',
  'NS(=O)(=O)c1ccccc1',
  'Clc1ccccc1CCc1ccncc1',
  'CCO',
  'C1CCCCC1',
  'Cn1cnc2c1c(=O)n(C)c(=O)n2C',
  'OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O',
  'CC(=O)Oc1ccccc1C(=O)O',
];

/**
 * A library, optionally folded into the plane index.
 * @param options - How to build it.
 * @param options.fold - Whether to fold the plane index.
 * @param options.planeCandidateRatio - The router's crossover share.
 * @param options.maxPopulationRatio - The share above which a bit gets no plane.
 * @returns The connection and the molecules DB.
 */
function seed(
  options: {
    fold?: boolean;
    planeCandidateRatio?: number;
    maxPopulationRatio?: number;
  } = {},
) {
  const { fold = false, planeCandidateRatio, maxPopulationRatio = 1 } = options;
  const db = new DatabaseSync(':memory:');

  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, id_code TEXT NOT NULL UNIQUE)',
  );

  const molDB = new MoleculesDBSQLite(db, OCL, {
    entriesTable: 'molecules',
    poolSize: 1,
    ...(planeCandidateRatio === undefined ? {} : { planeCandidateRatio }),
  });
  molDB.migrate();
  for (const smiles of SMILES) {
    const idCode = OCL.Molecule.fromSmiles(smiles).getIDCode();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO molecules (id_code) VALUES (?)')
      .run(idCode);
    molDB.insert(Number(lastInsertRowid), idCode);
  }
  if (fold) molDB.foldPlanes({ maxPopulationRatio });

  return { db, molDB };
}

/**
 * A fragment with its query flag set.
 * @param smiles - The fragment, as SMILES.
 * @returns The fragment molecule.
 */
function fragment(smiles: string) {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.setFragment(true);
  return mol;
}

/**
 * Run the prescreen and report which path answered.
 * @param db - The database to read.
 * @param smiles - The query fragment.
 * @param extra - Extra prescreen parameters.
 * @returns The candidate ids and whether the plane index answered.
 */
function screen(
  db: DatabaseSync,
  smiles: string,
  extra: Record<string, unknown> = {},
) {
  const state: PrescreenState = { screened: 0, partial: false };
  const found = [
    ...prescreen(
      {
        db,
        entriesTable: 'molecules',
        pkColumn: 'id',
        idCodeColumn: 'id_code',
        mol: fragment(smiles),
        timeoutMs: 10_000,
        maxCandidates: Number.MAX_SAFE_INTEGER,
        planeCandidateRatio: 1,
        ...extra,
      },
      state,
    ),
  ];

  return {
    ids: found.map((c) => c.entryId).toSorted((a, b) => a - b),
    usedPlaneIndex: state.usedPlaneIndex === true,
  };
}

test('an unfolded index sends every query to the column path', () => {
  const { db } = seed();

  expect(
    choosePrescreenPath(db, fragment('Fc1ccc(-c2ccccc2)cc1'), 1e9),
  ).toStrictEqual({ kind: 'column', reason: 'the plane index is empty' });
  expect(screen(db, 'Fc1ccc(-c2ccccc2)cc1').usedPlaneIndex).toBe(false);
});

test('a fragment with no selective bit stays on the column path', () => {
  // Folded at the real default, so the bits most entries set get no plane at
  // all — which for benzene is every bit it sets.
  const { db } = seed({ fold: true, maxPopulationRatio: 0.5 });
  const plan = choosePrescreenPath(db, fragment('c1ccccc1'), 1e9, 0.5);

  expect(plan).toStrictEqual({
    kind: 'column',
    reason: 'no bit of the query is selective enough',
  });
});

test('a result set that would be truncated stays on the column path', () => {
  const { db } = seed({ fold: true });
  // One result wanted, more than one candidate: the order of what survives the
  // truncation is then observable, so the plane index must not answer.
  const plan = choosePrescreenPath(db, fragment('Oc1ccccc1'), 1, 1);

  expect(plan).toStrictEqual({
    kind: 'column',
    reason: 'the result set would be truncated, so the order is observable',
  });
});

test('too many candidates for the screen to pay for itself', () => {
  const { db } = seed({ fold: true });
  const plan = choosePrescreenPath(db, fragment('Oc1ccccc1'), 1e9, 0.000_01);

  expect(plan).toStrictEqual({
    kind: 'column',
    reason: 'too many candidates for the screen to pay for itself',
  });
});

test('a candidates subquery stays on the column path', () => {
  const { db } = seed({ fold: true });
  const restricted = screen(db, 'Fc1ccc(-c2ccccc2)cc1', {
    candidates: { sql: 'SELECT id AS entry_id FROM molecules' },
  });

  expect(restricted.usedPlaneIndex).toBe(false);
});

test('the plane index answers a selective fragment, with the same candidates', () => {
  const folded = seed({ fold: true });
  const plain = seed();

  for (const smiles of [
    'Fc1ccc(-c2ccccc2)cc1',
    'NS(=O)(=O)c1ccccc1',
    'Clc1ccccc1CCc1ccncc1',
    'O=C(N)c1ccccc1',
  ]) {
    const viaPlanes = screen(folded.db, smiles);
    const viaColumn = screen(plain.db, smiles);

    expect(viaPlanes.usedPlaneIndex).toBe(true);
    expect(viaPlanes.ids).toStrictEqual(viaColumn.ids);
  }
});

test('a search returns the same results, in the same order, either way', async () => {
  const folded = seed({ fold: true, planeCandidateRatio: 1 });
  const plain = seed();

  const fragments = [
    'Fc1ccc(-c2ccccc2)cc1',
    'NS(=O)(=O)c1ccccc1',
    'c1ccccc1',
    'Oc1ccccc1',
  ];
  const pairs = await Promise.all(
    fragments.map(async (smiles) => [
      await folded.molDB.search(smiles, { mode: 'substructure' }),
      await plain.molDB.search(smiles, { mode: 'substructure' }),
    ]),
  );

  for (const [a, b] of pairs) {
    expect(a?.results.map((r) => r.entryId)).toStrictEqual(
      b?.results.map((r) => r.entryId),
    );
  }
});

test('an entry inserted after a fold is screened until the next fold', async () => {
  const { db, molDB } = seed({ fold: true, planeCandidateRatio: 1 });

  expect(molDB.planeStatus()).toStrictEqual({
    folded: SMILES.length,
    segments: 1,
    watermark: SMILES.length,
    pending: 0,
    refoldAdvisable: false,
  });

  const idCode = OCL.Molecule.fromSmiles(
    'Fc1ccc(-c2ccc(Cl)cc2)cc1',
  ).getIDCode();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO molecules (id_code) VALUES (?)')
    .run(idCode);
  molDB.insert(Number(lastInsertRowid), idCode);

  // Its id is above the watermark, so it waits without touching the planes.
  expect(molDB.planeStatus()).toMatchObject({ pending: 1 });

  // Not folded yet, so only the screen above the watermark can find it.
  const found = await molDB.search('Fc1ccc(-c2ccccc2)cc1', {
    mode: 'substructure',
  });

  expect(found.results.map((r) => r.entryId)).toContain(
    Number(lastInsertRowid),
  );

  const result = molDB.foldPlanes({ maxPopulationRatio: 1 });

  expect(result.folded).toBe(1);
  expect(molDB.planeStatus()).toStrictEqual({
    folded: SMILES.length + 1,
    segments: 2,
    watermark: SMILES.length + 1,
    pending: 0,
    refoldAdvisable: false,
  });
});
