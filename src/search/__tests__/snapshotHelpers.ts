/* eslint-disable no-await-in-loop -- every query and set is read in turn */
import type { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect } from 'vitest';

import { SPEC, testThreads } from '../../__tests__/testDatabase.ts';
import {
  readAll,
  readTruth,
  substructureTruth,
} from '../../__tests__/truth.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';
import type { MoleculeIndexOptions } from '../indexOptions.ts';
import type { SearchOptions } from '../pages.ts';
import type { IndexSpec } from '../spec.ts';

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();
const QUERIES = ['', smiles('c1ccccc1'), smiles('Oc1ccccc1'), smiles('ClCCCO')];
const SETS: SearchOptions[] = [
  {},
  { sets: ['source:2'] },
  { sets: ['source:4'] },
  { keyMin: 150, keyMax: 300, filters: { logP: { min: 0 } } },
];

/** The steps of an open that reads its snapshot back. */
export const RESTORED = ['snapshot', 'tail', 'workers'];

/** Where, and under what, a test opens an index. */
export interface SnapshotOpen {
  file: string;
  snapshot: string;
  spec?: IndexSpec;
  /** More options: the index is saved again only when a test asks, unless they say otherwise. */
  options?: MoleculeIndexOptions;
}

/**
 * Opens an index with a snapshot, runs the checks, then closes it.
 * @param open - The database, the snapshot, the specification and more options.
 * @param check - What to do with the index while it is open.
 * @returns The steps finished, as `step` or `step: note`.
 */
export async function openWithSnapshot(
  open: SnapshotOpen,
  check: (index: MoleculeIndex) => Promise<void> = async () => undefined,
): Promise<string[]> {
  const steps: string[] = [];
  const index = await MoleculeIndex.open(open.file, open.spec ?? SPEC, {
    threads: testThreads(2),
    pollMs: 3_600_000,
    snapshot: open.snapshot,
    snapshotRefreshShare: Infinity,
    ...open.options,
    onProgress: ({ step, note, finished }) => {
      if (!finished) return;
      steps.push(note === undefined ? step : `${step}: ${note}`);
    },
  });
  try {
    await check(index);
  } finally {
    await index.close();
  }
  return steps;
}

/**
 * Every query × set paged to the end, against brute force over SQL.
 * @param index - The index, caught up first.
 * @param db - The database.
 */
export async function expectExact(
  index: MoleculeIndex,
  db: DatabaseSync,
): Promise<void> {
  await index.poll();
  const rows = readTruth(db);
  for (const query of QUERIES) {
    for (const options of SETS) {
      const expected = substructureTruth(rows, query, options);
      const { ids } = await readAll(index, query, { ...options, limit: 1000 });

      expect(ids).toStrictEqual(expected);
    }
  }
}
