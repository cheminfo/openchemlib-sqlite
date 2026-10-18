import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { testThreads } from '../../__tests__/testDatabase.ts';
import { MoleculeStore } from '../MoleculeStore.ts';

import { commitIds } from './storeSteps.ts';

// PubChem CID 9942100: OpenChemLib canonicalizes each of these two idCodes to the other.
const FLIP_A =
  'dSdeHC``@CaLRkz@\\@chQERtcLqlgEpBLbjjvhXvkn{^PYFq|Xdi@GBl\\BYprW@hbHQH`hjDRLaDcHRDqLaHRDRDQDqHSHrDcHqDKHaHaDaBaHbdRAQDPdQHqDRDaLRDaLRDaHaHsH`daHjDqHrDcDaHQDRHSDrBRdJHQHbdMNQtgHKBdgHJp]DaTVEqDPfjjjjiijZZjjjjfjifjjjjjjjBBJfjifjjjjjjijZjjjjjjfijjjjhj`@`RJXSiSh';
const FLIP_B =
  'dSdeHC``@CaLRkz@\\@chQERtcLqlgEpBLbjjvhXvkn{^PYFq|Xdi@GBl\\BYprW@hbHQH`hjDRLaDcHRDqLaHRDRDQDqHSHrDcHqDKHaHaDaBaHbdRAQDPdQHqDRDaLRDaLRDaHaHsH`daHjDqHrDcDaHQDRHSDrBRdJHQHbdMNQtgHKBdgHJp]DaTVEqDPfjjjjiijZZjjjjfjifjjjjjjjBBJfjifjjjjjjijZjjjjjjfijjjjhj`@`RJXSjSh';

test('a stored idCode that canonicalizes to the other form of a flipping pair passes the opening check', async () => {
  const db = new DatabaseSync(':memory:');
  const store = await MoleculeStore.open(db, { threads: testThreads(1) });
  try {
    const forms = await store.prepare([FLIP_A, FLIP_B]);
    const [id] = await commitIds(store, db, [FLIP_A]);
    const stored = (
      db
        .prepare('SELECT idCode FROM ocl_molecule WHERE id = ?')
        .get(id as number) as {
        idCode: string;
      }
    ).idCode;

    expect(forms.molecules.map((molecule) => molecule.idCode)).toStrictEqual([
      FLIP_B,
      FLIP_A,
    ]);
    expect(stored).toBe(FLIP_B);

    // Every molecule of the store is sampled: before, this one failed the check.
    await expect(
      MoleculeStore.open(db, { threads: testThreads(1), checkRows: 32 }).then(
        (reopened) => reopened.close(),
      ),
    ).resolves.toBeUndefined();
  } finally {
    await store.close();
    db.close();
  }
});
