/* eslint-disable no-await-in-loop -- pages and checks run one after the other */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { drawSearches } from '../../__tests__/draws.ts';
import {
  readAllSimilar,
  similarityTruth,
} from '../../__tests__/similarityTruth.ts';
import {
  APP_SQL,
  SPEC,
  addMolecules,
  readIdCodes,
  testThreads,
} from '../../__tests__/testDatabase.ts';
import type { TruthRow } from '../../__tests__/truth.ts';
import {
  readAll,
  readTruth,
  substructureTruth,
} from '../../__tests__/truth.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();

let directory: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;
let rows: TruthRow[];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-keys-'));
  db = new DatabaseSync(join(directory, 'db.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(4) });
  await addMolecules(db, store, readIdCodes(), { seed: 7 });
  rows = readTruth(db, { keys: true });
  index = await MoleculeIndex.open(join(directory, 'db.sqlite'), SPEC, {
    threads: testThreads(3),
    readers: testThreads(2),
    blockRows: 512,
    firstSliceRows: 64,
    follow: false,
  });
}, 120_000);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('key bits and set expressions: browse and substructure pages equal brute force, a browse verifies nothing', async () => {
  const queries = ['', smiles('c1ccccc1'), 'gOp@DjWkB@@Mi`'];
  let answered = 0;
  for (const [i, options] of drawSearches(rows, 11, 25).entries()) {
    for (const query of queries) {
      const label = `draw ${i}, ${query || 'browse'}: ${JSON.stringify(options)}`;
      const expected = substructureTruth(rows, query, options);
      const full = await readAll(index, query, { ...options, limit: 1000 });

      expect(full.ids, `${label}, pages of 1000`).toStrictEqual(expected);

      const small = await readAll(index, query, { ...options, limit: 7 });

      expect(small.ids, `${label}, pages of 7`).toStrictEqual(expected);

      if (expected.length > 0) answered++;
    }

    // Keys are stored, so exact: a browse with keys verifies nothing.
    await expect(
      index.browse({ ...options, limit: 1000 }),
    ).resolves.toMatchObject({ info: { verified: 0 } });
  }

  // Two thirds of the 75 searches answer rows.
  expect(answered).toBe(50);
}, 120_000);

test('key bits and set expressions: similarity pages on each fingerprint equal Tanimoto brute force', async () => {
  const aspirin = smiles('CC(=O)Oc1ccccc1C(=O)O');
  let answered = 0;
  for (const [i, options] of drawSearches(rows, 13, 25).entries()) {
    for (const fingerprint of ['fragFp', 'screen', 'both'] as const) {
      const label = `draw ${i}, ${fingerprint}: ${JSON.stringify(options)}`;
      const expected = similarityTruth(
        rows,
        aspirin,
        0.3,
        options,
        fingerprint,
      );
      const { hits, totals } = await readAllSimilar(index, aspirin, {
        ...options,
        threshold: 0.3,
        fingerprint,
        limit: 24,
        budgetMs: 60_000,
      });

      expect(hits, `${label}, hits`).toStrictEqual(expected);
      expect(new Set(totals), `${label}, totals`).toStrictEqual(
        new Set([expected.length]),
      );

      if (expected.length > 0) answered++;
    }
  }

  // 30 of the 75 searches answer rows.
  expect(answered).toBe(30);
}, 120_000);
