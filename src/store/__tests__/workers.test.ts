import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect, test } from 'vitest';

import { MoleculeStore } from '../MoleculeStore.ts';
import type { ChemistryWorkers } from '../chemistryPool.ts';

const BENZENE = OCL.Molecule.fromSmiles('c1ccccc1').getIDCode();
const ETHANOL = OCL.Molecule.fromSmiles('CCO').getIDCode();

/**
 * A store in a new in-memory database.
 * @param workers - The workers it computes with, or none for threads of its own.
 * @returns The store.
 */
function openStore(workers?: ChemistryWorkers): Promise<MoleculeStore> {
  return MoleculeStore.open(new DatabaseSync(':memory:'), {
    threads: 1,
    checkRows: 0,
    ...(workers === undefined ? {} : { workers }),
  });
}

test('stores sharing workers each compute with them, and leave them running when they close', async () => {
  const workers = MoleculeStore.workers(1);
  const first = await openStore(workers);
  const second = await openStore(workers);

  const before = await first.prepare([BENZENE]);
  await first.close();
  const after = await second.prepare([ETHANOL]);
  const [benzene] = before.molecules;
  const [ethanol] = after.molecules;

  expect([benzene?.idCode, benzene?.atoms]).toStrictEqual([BENZENE, 6]);
  expect([ethanol?.idCode, ethanol?.atoms]).toStrictEqual([ETHANOL, 3]);

  await workers.close();

  await expect(second.prepare([ETHANOL])).rejects.toThrow(
    'the store is closed',
  );
});

test('a store stops the threads of its own when it closes', async () => {
  const store = await openStore();
  await store.prepare([BENZENE]);

  await store.close();

  await expect(store.prepare([BENZENE])).rejects.toThrow('the store is closed');
});

test('a store takes only workers MoleculeStore.workers() made', async () => {
  const foreign: ChemistryWorkers = { close: () => Promise.resolve() };

  await expect(openStore(foreign)).rejects.toThrow(
    'workers come from MoleculeStore.workers()',
  );
});
