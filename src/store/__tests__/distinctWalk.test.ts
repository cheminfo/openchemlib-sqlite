import { DatabaseSync } from 'node:sqlite';

import { XSadd } from 'ml-xsadd';
import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { testThreads } from '../../__tests__/testDatabase.ts';
import { MoleculeStore } from '../MoleculeStore.ts';
import type { DistinctHashes } from '../schema.ts';

import { commitIds, countedDistinct, removeIds } from './storeSteps.ts';

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();

test('the counts equal count(DISTINCT …) through random commits and removals', async () => {
  const pool = [
    'C[C@H](N)C(=O)O',
    'C[C@@H](N)C(=O)O',
    'CC(N)C(=O)O',
    'CC(=O)C',
    'CC(O)=C',
    'C[C@H](O)C(=O)O',
    'C[C@@H](O)C(=O)O',
    'CC(=O)CC(=O)C',
    'CC(O)=CC(=O)C',
    'Oc1ccccn1',
    'O=c1cccc[nH]1',
    'C/C=C/C',
    String.raw`C/C=C\C`,
    'OC(=O)/C=C/C(=O)O',
    String.raw`OC(=O)/C=C\C(=O)O`,
    'N[C@@H](Cc1ccccc1)C(=O)O',
    'N[C@H](Cc1ccccc1)C(=O)O',
    'CCO',
    'c1ccccc1',
  ].map(smiles);
  const random = new XSadd(17);
  const pick = (count: number) =>
    Array.from({ length: count }, () =>
      Math.floor(random.getFloat() * pool.length),
    );
  const db = new DatabaseSync(':memory:');
  const store = await MoleculeStore.open(db, { threads: testThreads(2) });
  try {
    const stored = new Map<string, number>();
    const seen: DistinctHashes[] = [];
    for (let step = 0; step < 40; step++) {
      if (stored.size === 0 || random.getFloat() < 0.6) {
        const idCodes = pick(1 + Math.floor(random.getFloat() * 5)).map(
          (index) => pool[index] as string,
        );
        // eslint-disable-next-line no-await-in-loop -- each step is checked before the next
        const ids = await commitIds(store, db, idCodes);
        for (const [index, idCode] of idCodes.entries()) {
          stored.set(idCode, ids[index] as number);
        }
      } else {
        const ids = [...stored.values()];
        const chosen = new Set(
          pick(1 + Math.floor(random.getFloat() * 3)).map(
            (index) => ids[index % ids.length] as number,
          ),
        );
        removeIds(store, db, [...chosen]);
        for (const [idCode, id] of stored) {
          if (chosen.has(id)) stored.delete(idCode);
        }
      }

      expect(store.distinctHashes()).toStrictEqual(countedDistinct(db));

      seen.push(store.distinctHashes());
    }
    // Seeded: the walk climbs to 12 compounds, falls back to one, and ends
    // with 11 compounds in 9 families.
    const compounds = seen.map((counts) => counts.noStereo);

    expect([Math.min(...compounds), Math.max(...compounds)]).toStrictEqual([
      1, 12,
    ]);
    expect(seen.at(-1)).toStrictEqual({ noStereo: 11, tautomer: 9 });
  } finally {
    await store.close();
    db.close();
  }
});
