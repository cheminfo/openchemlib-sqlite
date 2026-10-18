import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { testThreads } from '../../__tests__/testDatabase.ts';
import { MoleculeStore } from '../MoleculeStore.ts';
import type { DistinctHashes } from '../schema.ts';

import { commitIds, countedDistinct, removeIds } from './storeSteps.ts';

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();
const ALANINE_L = smiles('C[C@H](N)C(=O)O');
const ALANINE_D = smiles('C[C@@H](N)C(=O)O');
const ACETONE = smiles('CC(=O)C');
const PROPEN_2_OL = smiles('CC(O)=C');
const LACTIC_L = smiles('C[C@H](O)C(=O)O');
const LACTIC_D = smiles('C[C@@H](O)C(=O)O');
const ETHANOL = smiles('CCO');

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-distinct-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

test('a commit counts each hash no stored molecule carries once', async () => {
  const db = new DatabaseSync(':memory:');
  const store = await MoleculeStore.open(db, { threads: testThreads(2) });
  try {
    expect(store.distinctHashes()).toStrictEqual({ noStereo: 0, tautomer: 0 });

    await commitIds(store, db, [ALANINE_L, ACETONE]);
    const first = store.distinctHashes();

    // D-alanine repeats both hashes of L-alanine. Propen-2-ol is a new compound
    // but a tautomer of acetone. The two lactic acids are one new compound and
    // one new family between them, in one batch. Ethanol is new on both counts,
    // sent twice.
    await commitIds(store, db, [
      ALANINE_D,
      PROPEN_2_OL,
      LACTIC_L,
      LACTIC_D,
      ETHANOL,
      ETHANOL,
    ]);

    expect(first).toStrictEqual({ noStereo: 2, tautomer: 2 });
    expect(store.distinctHashes()).toStrictEqual({ noStereo: 5, tautomer: 4 });
    expect(store.distinctHashes()).toStrictEqual(countedDistinct(db));
    expect(store.count()).toBe(7);
  } finally {
    await store.close();
    db.close();
  }
});

test('removing the last molecule carrying a hash takes the hash out', async () => {
  const db = new DatabaseSync(':memory:');
  const store = await MoleculeStore.open(db, { threads: testThreads(2) });
  try {
    const [l, d, , enol, lacticL, lacticD] = await commitIds(store, db, [
      ALANINE_L,
      ALANINE_D,
      ACETONE,
      PROPEN_2_OL,
      LACTIC_L,
      LACTIC_D,
    ]);
    const steps: DistinctHashes[] = [store.distinctHashes()];

    // L-alanine keeps both of D-alanine's hashes.
    removeIds(store, db, [d as number]);
    steps.push(store.distinctHashes());

    expect(store.distinctHashes()).toStrictEqual(countedDistinct(db));

    // Acetone keeps the family of propen-2-ol.
    removeIds(store, db, [enol as number]);
    steps.push(store.distinctHashes());

    expect(store.distinctHashes()).toStrictEqual(countedDistinct(db));

    // Both lactic acids at once: their compound and their family go.
    removeIds(store, db, [lacticL as number, lacticD as number, 12_345]);
    steps.push(store.distinctHashes());

    expect(store.distinctHashes()).toStrictEqual(countedDistinct(db));

    removeIds(store, db, [l as number]);
    steps.push(store.distinctHashes());

    expect(steps).toStrictEqual([
      { noStereo: 4, tautomer: 3 },
      { noStereo: 4, tautomer: 3 },
      { noStereo: 3, tautomer: 3 },
      { noStereo: 2, tautomer: 2 },
      { noStereo: 1, tautomer: 1 },
    ]);
    expect(store.distinctHashes()).toStrictEqual(countedDistinct(db));
  } finally {
    await store.close();
    db.close();
  }
});

test('a file written before the counters were kept gets them when it is opened', async () => {
  const db = new DatabaseSync(join(directory, 'before.sqlite'));
  const store = await MoleculeStore.open(db, { threads: testThreads(1) });
  await commitIds(store, db, [ALANINE_L, ALANINE_D, ACETONE, PROPEN_2_OL]);
  await store.close();
  db.exec(
    "DELETE FROM ocl_meta WHERE name IN ('distinctNoStereo', 'distinctTautomer')",
  );

  const reopened = await MoleculeStore.open(db, { threads: testThreads(1) });
  const again = await MoleculeStore.open(db, { threads: testThreads(1) });
  try {
    expect(reopened.distinctHashes()).toStrictEqual({
      noStereo: 3,
      tautomer: 2,
    });
    expect(again.distinctHashes()).toStrictEqual(countedDistinct(db));

    await commitIds(reopened, db, [ETHANOL]);

    expect(again.distinctHashes()).toStrictEqual({ noStereo: 4, tautomer: 3 });
  } finally {
    await reopened.close();
    await again.close();
    db.close();
  }
});
