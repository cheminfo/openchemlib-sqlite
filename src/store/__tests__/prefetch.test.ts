import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { testThreads } from '../../__tests__/testDatabase.ts';
import { MoleculeStore } from '../MoleculeStore.ts';

import { commitIds } from './storeSteps.ts';

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-prefetch-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

test('prefetch runs the reads ahead on the readers, and nothing without them', async () => {
  const db = new DatabaseSync(join(directory, 'db.sqlite'));
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)');
  const plain = await MoleculeStore.open(db, { threads: testThreads(1) });
  const reading = await MoleculeStore.open(db, {
    threads: testThreads(1),
    readers: 2,
  });
  try {
    await commitIds(plain, db, [smiles('CCO')]);
    const idCodes = ['c1ccccc1', 'CC(=O)O', 'CCN', 'CCCl'].map(smiles);
    const batch = await reading.prepare(idCodes);
    const missing = [
      { sql: 'SELECT text FROM missing WHERE id = ?', keys: [1] },
    ];

    await expect(
      reading.prefetch(batch, [
        { sql: 'SELECT text FROM notes WHERE id = ?', keys: [1, 2, 3] },
      ]),
    ).resolves.toBeUndefined();
    // The statement runs on a reader: one that cannot be prepared fails there.
    await expect(reading.prefetch(batch, missing)).rejects.toThrow(
      /no such table: missing/,
    );
    await expect(
      plain.prefetch(await plain.prepare(idCodes), missing),
    ).resolves.toBeUndefined();

    db.exec('BEGIN IMMEDIATE');
    const results = reading.commit(batch);
    db.exec('COMMIT');

    expect(results.map((result) => result?.created)).toStrictEqual([
      true,
      true,
      true,
      true,
    ]);
  } finally {
    await plain.close();
    await reading.close();
    db.close();
  }
});
