import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { testThreads } from '../../__tests__/testDatabase.ts';
import { MoleculeStore } from '../MoleculeStore.ts';
import type { DistinctHashes } from '../schema.ts';

import { commitIds, commitSteps, countedDistinct } from './storeSteps.ts';

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();
const ALANINE_L = smiles('C[C@H](N)C(=O)O');
const ALANINE_D = smiles('C[C@@H](N)C(=O)O');
const ACETONE = smiles('CC(=O)C');
const PROPEN_2_OL = smiles('CC(O)=C');
const BENZENE = smiles('c1ccccc1');
const ETHANOL = smiles('CCO');
const TOLUENE = smiles('Cc1ccccc1');
const PHENOL = smiles('Oc1ccccc1');

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-readers-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

test('with readers, find and commit answer what the plain store answers', async () => {
  const plainDb = new DatabaseSync(join(directory, 'plain.sqlite'));
  const fastDb = new DatabaseSync(join(directory, 'fast.sqlite'));
  const plain = await MoleculeStore.open(plainDb, { threads: testThreads(2) });
  const fast = await MoleculeStore.open(fastDb, {
    threads: testThreads(2),
    readers: 2,
  });
  try {
    const first = [ALANINE_L, ACETONE, BENZENE];
    // D-alanine shares L-alanine's no-stereo hash, propen-2-ol is new, ethanol
    // comes twice, '' cannot be read.
    const second = [ALANINE_D, ALANINE_L, PROPEN_2_OL, ETHANOL, ETHANOL, ''];
    const lookups = [ALANINE_L, ALANINE_D, ETHANOL, TOLUENE, '', BENZENE];
    const answers: unknown[][] = [];
    for (const [store, db] of [
      [plain, plainDb],
      [fast, fastDb],
    ] as const) {
      /* eslint-disable no-await-in-loop -- each store runs the same steps in turn */
      const created = await commitSteps(store, db, first);
      const before = await store.find(lookups);
      const again = await commitSteps(store, db, second);
      const after = await store.find(lookups);
      /* eslint-enable no-await-in-loop */
      answers.push([created, before, again, after, store.distinctHashes()]);
    }

    expect(answers[1]).toStrictEqual(answers[0]);

    const [created, before, again, after, distinct] = answers[0] as [
      Array<[number, boolean]>,
      unknown[],
      Array<[number, boolean] | undefined>,
      unknown[],
      DistinctHashes,
    ];
    const [l, , benzene] = created.map(([id]) => id);

    expect(before).toStrictEqual([
      l,
      undefined,
      undefined,
      undefined,
      undefined,
      benzene,
    ]);
    expect(again.map((result) => result?.[1])).toStrictEqual([
      true,
      false,
      true,
      true,
      false,
      undefined,
    ]);
    expect(again[1]?.[0]).toBe(l);
    expect(again[4]?.[0]).toBe(again[3]?.[0]);
    expect(after).toStrictEqual([
      l,
      again[0]?.[0],
      again[3]?.[0],
      undefined,
      undefined,
      benzene,
    ]);
    expect(distinct).toStrictEqual({ noStereo: 5, tautomer: 4 });
    expect(distinct).toStrictEqual(countedDistinct(fastDb));
  } finally {
    await plain.close();
    await fast.close();
    plainDb.close();
    fastDb.close();
  }
});

test('with readers, find and commit follow what another connection commits, and a rolled back commit', async () => {
  const file = join(directory, 'shared.sqlite');
  const ownDb = new DatabaseSync(file);
  const otherDb = new DatabaseSync(file);
  ownDb.exec('PRAGMA journal_mode = WAL');
  ownDb.exec('PRAGMA busy_timeout = 5000');
  otherDb.exec('PRAGMA busy_timeout = 5000');
  const own = await MoleculeStore.open(ownDb, {
    threads: testThreads(2),
    readers: 1,
  });
  const other = await MoleculeStore.open(otherDb, { threads: testThreads(1) });
  try {
    const [acetone] = await commitIds(own, ownDb, [ACETONE]);
    // A commit of its own store that rolls back: its seqs are taken again by
    // the other connection, for other molecules.
    await commitSteps(own, ownDb, [TOLUENE, PHENOL], 'ROLLBACK');
    const [benzene, ethanol] = await commitIds(other, otherDb, [
      BENZENE,
      ETHANOL,
    ]);

    await expect(
      own.find([BENZENE, ETHANOL, TOLUENE, PHENOL, ACETONE]),
    ).resolves.toStrictEqual([benzene, ethanol, undefined, undefined, acetone]);

    const again = await commitSteps(own, ownDb, [ETHANOL, TOLUENE, BENZENE]);

    expect(again.map((result) => result?.[1])).toStrictEqual([
      false,
      true,
      false,
    ]);
    expect(again[0]?.[0]).toBe(ethanol);
    expect(again[2]?.[0]).toBe(benzene);

    // A commit of its own whose molecules are all removed in the same
    // transaction, as an application does when its own rows fail.
    const batch = await own.prepare([PHENOL]);
    ownDb.exec('BEGIN IMMEDIATE');
    const [phenol] = own.commit(batch);
    own.remove([phenol?.id as number]);
    ownDb.exec('COMMIT');
    const [propenol] = await commitIds(other, otherDb, [PROPEN_2_OL]);

    await expect(own.find([PROPEN_2_OL, PHENOL])).resolves.toStrictEqual([
      propenol,
      undefined,
    ]);

    const idCodes = ownDb
      .prepare('SELECT idCode FROM ocl_molecule ORDER BY idCode')
      .all()
      .map((row) => (row as { idCode: string }).idCode);

    expect(idCodes).toStrictEqual(
      [ACETONE, BENZENE, ETHANOL, TOLUENE, PROPEN_2_OL].toSorted(),
    );
    expect(own.distinctHashes()).toStrictEqual(countedDistinct(ownDb));
  } finally {
    await own.close();
    await other.close();
    ownDb.close();
    otherDb.close();
  }
});

test('readers need a database file', async () => {
  const db = new DatabaseSync(':memory:');

  await expect(
    MoleculeStore.open(db, { threads: testThreads(1), readers: 1 }),
  ).rejects.toThrow(/in-memory/);

  db.close();
});
